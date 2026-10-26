/**
 * Plain-text and JSON journal export formats.
 *
 * Shared by the Worker's /api/journal-export and the journal's own export
 * panel. Text dates use UTC so they agree across runtimes. Both formats list
 * explicit reading fields only; private visual state never reaches them.
 */

import { buildReflectionEntries } from './reflectionLabels.js';
import { getTimestamp } from './utils.js';

const SEPARATOR = '='.repeat(50);
const PRIVATE_CAPABILITY_FIELDS = new Set([
  'visualJobToken', 'visualToken', 'visualJobId', 'attemptId', 'resumeHandle',
  'visualResume', 'visionProof', 'visualState', 'visualSnapshot'
]);

function newestFirst(entries) {
  return (Array.isArray(entries) ? entries.filter(Boolean) : [])
    .map((entry, index) => ({ entry, index, ts: getTimestamp(entry) || 0 }))
    .sort((a, b) => (b.ts - a.ts) || (a.index - b.index))
    .map(({ entry }) => entry);
}

/**
 * Format a journal entry as readable text (also the source of the PDF export)
 */
export function formatEntryAsText(entry) {
  const lines = [];
  const timestamp = getTimestamp(entry);
  const date = timestamp === null ? 'Date unavailable' : new Date(timestamp).toLocaleString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short'
  });

  lines.push(`# ${entry.spread || 'Tarot Reading'}`);
  lines.push(`Date: ${date}`);
  lines.push('');

  if (entry.question) {
    lines.push('## Question');
    lines.push(entry.question);
    lines.push('');
  }

  if (entry.context) {
    lines.push(`Context: ${entry.context}`);
    lines.push('');
  }

  lines.push('## Cards Drawn');
  if (Array.isArray(entry.cards)) {
    for (const card of entry.cards) {
      const position = card.position ? `${card.position}: ` : '';
      const orientation = card.orientation ? ` (${card.orientation})` : '';
      lines.push(`- ${position}${card.card || card.name}${orientation}`);
    }
  }
  lines.push('');

  if (entry.personalReading) {
    lines.push('## Reading');
    // Split long reading into paragraphs
    const paragraphs = entry.personalReading.split(/\n\n+/);
    for (const para of paragraphs) {
      lines.push(para.replace(/\n/g, ' ').trim());
      lines.push('');
    }
  }

  if (Array.isArray(entry.followUps) && entry.followUps.length) {
    lines.push('## Follow-up Conversation');
    for (const turn of entry.followUps) {
      const turnNumber = Number.isFinite(turn?.turnNumber) ? turn.turnNumber : null;
      const header = turnNumber ? `Turn ${turnNumber}` : 'Turn';
      lines.push(header);

      const question = typeof turn?.question === 'string' ? turn.question.trim() : '';
      const answer = typeof turn?.answer === 'string' ? turn.answer.trim() : '';
      if (question) lines.push(`Q: ${question.replace(/\n/g, ' ')}`);
      if (answer) lines.push(`A: ${answer.replace(/\n/g, ' ')}`);
      lines.push('');
    }
  }

  const reflectionEntries = buildReflectionEntries(entry.reflections, entry.cards);
  if (reflectionEntries.length > 0) {
    lines.push('## Personal Reflections');
    for (const [label, note] of reflectionEntries) {
      lines.push(`${label}: ${note}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');

  return lines.join('\n');
}

/**
 * The whole plain-text export: a header, then each entry newest first.
 * @param {Array<object>} entries
 * @param {{ generatedAt?: Date }} [options]
 */
export function buildJournalText(entries, { generatedAt = new Date() } = {}) {
  const sorted = newestFirst(entries);
  let content = 'TAROT JOURNAL EXPORT\n';
  content += `Generated: ${generatedAt.toISOString()}\n`;
  content += `Entries: ${sorted.length}\n`;
  content += `\n${SEPARATOR}\n\n`;
  for (const entry of sorted) {
    content += formatEntryAsText(entry);
  }
  return content;
}

function publicScalars(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(fields.filter(field => Object.hasOwn(value, field)
    && (value[field] === null || ['string', 'number', 'boolean'].includes(typeof value[field])))
    .map(field => [field, value[field]]));
}

function publicThemeValue(value) {
  if (Array.isArray(value)) return value.map(publicThemeValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !PRIVATE_CAPABILITY_FIELDS.has(key))
    .map(([key, child]) => [key, publicThemeValue(child)]));
}

function publicReflections(reflections) {
  if (!reflections || typeof reflections !== 'object' || Array.isArray(reflections)) return {};
  // Every nonblank string is a reader note, including arbitrary legacy labels.
  // Never classify a note as metadata merely because its label names a field.
  return Object.fromEntries(Object.entries(reflections)
    .filter(([, note]) => typeof note === 'string' && note.trim()));
}

function publicPattern(pattern) {
  return {
    ...publicScalars(pattern, ['type', 'description']),
    ...(Array.isArray(pattern?.contexts) ? { contexts: pattern.contexts.filter(value => typeof value === 'string') } : {}),
    ...(Array.isArray(pattern?.entries) ? {
      entries: pattern.entries.map(entry => publicScalars(entry, ['date', 'question', 'narrative', 'similarity']))
    } : {})
  };
}

function publicJournalContext(context) {
  const result = publicScalars(context, ['entriesSearched']);
  // Saved turns include both the public response's patternsFound and older
  // server context's patterns. Preserve their reader-facing evidence only.
  for (const key of ['patternsFound', 'patterns']) {
    if (Array.isArray(context?.[key])) result[key] = context[key].map(publicPattern);
  }
  return result;
}

function publicCard(card) {
  return {
    ...publicScalars(card, ['position', 'slot', 'name', 'card', 'canonicalName', 'canonicalKey', 'displayName', 'number', 'suit', 'rank', 'rankValue',
      'orientation', 'isReversed', 'upright', 'reversed', 'meaning', 'userReflection', 'callerMeaning']),
    ...(card?.decisionPath && typeof card.decisionPath === 'object' ? {
      decisionPath: publicScalars(card.decisionPath, ['key', 'label', 'rawLabel'])
    } : {})
  };
}

function publicFollowUp(turn) {
  return {
    ...publicScalars(turn, ['turnNumber', 'question', 'answer', 'canonicalAnswer', 'createdAt', 'isInterrupted']),
    ...(turn?.journalContext && typeof turn.journalContext === 'object' ? {
      journalContext: publicJournalContext(turn.journalContext)
    } : {})
  };
}

/** One saved reading's public content, including legacy card identities. */
export function toJournalExportRecord(entry) {
  const fields = publicScalars(entry, ['id', 'spread', 'spreadName', 'spreadKey', 'question', 'personalReading', 'context', 'provider', 'deckId']);
  return {
    id: fields.id ?? null,
    ts: getTimestamp(entry),
    spread: fields.spread || fields.spreadName || null,
    spreadKey: fields.spreadKey || null,
    question: fields.question || null,
    cards: Array.isArray(entry.cards) ? entry.cards.map(publicCard) : [],
    personalReading: fields.personalReading || null,
    themes: publicThemeValue(entry.themes) || null,
    reflections: publicReflections(entry.reflections),
    context: fields.context || null,
    provider: fields.provider || null,
    deckId: fields.deckId || null,
    followUps: Array.isArray(entry.followUps) ? entry.followUps.map(publicFollowUp) : []
  };
}

/**
 * The journal-only JSON export document, newest entry first.
 * @param {Array<object>} entries
 * @param {{ generatedAt?: Date, scope?: string }} [options]
 */
export function buildJournalJson(entries, { generatedAt = new Date(), scope } = {}) {
  const records = newestFirst(entries).map(toJournalExportRecord);
  return {
    exportedAt: generatedAt.toISOString(),
    entryCount: records.length,
    ...(scope ? { scope } : {}),
    entries: records
  };
}

