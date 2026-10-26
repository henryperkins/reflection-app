/** Private, bounded syntax classification; these offsets and prose are never telemetry. */
import { canonicalCardKey } from '../../shared/vision/cardNameMapping.js';
import {
  AMBIGUOUS_CARD_NAMES, TAROT_TERMINOLOGY_EXCLUSIONS, hasExplicitCardContext
} from './cardContextDetection.js';
import {
  buildDeckAwarePatterns, CARD_NAMES_REQUIRING_CARD_CASE, findFuzzyCardMentions
} from './readingQuality.js';

function drawnCardKeys(cardsInfo, deckStyle) {
  return new Set((Array.isArray(cardsInfo) ? cardsInfo : []).map(card => {
    // Resolved identities already use RWS canonical space; projecting again changes Thoth Knights.
    if (card?.canonicalKey) return card.canonicalKey.toLowerCase();
    if (card?.canonicalName) return card.canonicalName.toLowerCase();
    return canonicalCardKey(card?.card, deckStyle);
  }).filter(Boolean));
}

function isReportedQuotation(text, mention) {
  for (const pattern of [/“[^”]*”/g, /"[^"\n]*"/g, /‘[^’]*’/g, /(?<!\w)'[^'\n]+'(?!\w)/g]) {
    for (const match of text.matchAll(pattern)) {
      if (mention.start <= match.index || mention.end >= match.index + match[0].length) continue;
      const attribution = text.slice(Math.max(0, match.index - 120), match.index);
      if (/\b(?:you|the user|the querent|the reader)\s+(?:said|wrote|asked|reported|quoted|mentioned)\s*[,;:]?\s*$/i.test(attribution)
        || /\b(?:your (?:words|question|quotation)|you (?:said|wrote) earlier)\s*[,;:]?\s*$/i.test(attribution)) return true;
    }
  }
  return false;
}

function classifyOccurrence(text, mention, allMentions) {
  if (isReportedQuotation(text, mention)) return 'reported-quotation';
  // Sentence and contrast boundaries prevent a nearby negation from authorizing another claim.
  const boundaries = /[.!?;\n]|\b(?:but|while|whereas|although|yet)\b/gi;
  let start = 0;
  let end = text.length;
  for (const match of text.matchAll(boundaries)) {
    if (match.index < mention.start) start = match.index + match[0].length;
    else if (match.index >= mention.end) { end = match.index; break; }
  }
  const enclosingPrefix = text.slice(start, mention.start);
  for (const other of allMentions.filter(row => row.start >= start && row.end <= end)) {
    const preceding = text.slice(start, other.start);
    const bridge = /(?:,\s*(?:and\s+)?|\band\s+)[*_“”"'\s]*$/i.exec(preceding);
    const following = text.slice(other.end, end).replace(/[*_`“”"()]/g, '').replace(/^\s*(?:card\b\s*)?(?:(?:upright|reversed)\b\s*)?/i, '');
    if (!bridge || !/^(?:is|are|was|were|does|do|appears?|occupies?)\b/i.test(following)
      || !/\b(?:draw|drew|drawn|pulled|selected|appears?|is|are|was|were)\b/i.test(preceding.slice(0, bridge.index))) continue;
    const boundary = start + bridge.index;
    if (boundary < mention.start) start = boundary + bridge[0].length;
    else if (boundary >= mention.end) { end = boundary; break; }
  }
  // Mask other card titles so coordinated names can share their actual predicate.
  const before = allMentions.filter(row => row.start >= start && row.end <= mention.start);
  const after = allMentions.filter(row => row.start >= mention.end && row.end <= end);
  const mask = (from, to, rows) => {
    let result = '';
    let cursor = from;
    for (const row of rows) {
      result += text.slice(cursor, row.start) + 'CARD';
      cursor = row.end;
    }
    return result + text.slice(cursor, to);
  };
  const clean = value => value.replace(/[*_`“”"()]/g, '').replace(/\b(?:upright|reversed)\b/gi, '').replace(/\bnot\s+only\b/gi, '').replace(/\s+/g, ' ').trim();
  let prefix = clean(mask(start, mention.start, before));
  let suffix = clean(mask(mention.end, end, after));
  // Remove only a coordinated list, never another card's independent clause.
  suffix = suffix.replace(/^card\b\s*/i, '').replace(/^(?:(?:,?\s*(?:and|or|nor)|,)\s*(?:the\s+)?CARD(?:\s+card)?\s*)+/i, '');
  // The list may begin immediately after a draw verb, e.g. "you drew X and Y".
  prefix = prefix.replace(/(?:\bCARD(?:\s+card)?\s*(?:,?\s*(?:and|or|nor)|,)\s*(?:the\s+)?)+$/i, '').trim();

  const outerNegative = /\b(?:not (?:true|the case)|false) that\b/i.test(prefix) && !/\bnot false that\b/i.test(prefix);
  const withOuterPolarity = value => outerNegative ? value === 'present' ? 'absent' : value === 'absent' ? 'present' : value : value;

  if (/\b(?:if|hypothetically|hypothetical|imagine|suppose|supposing)\b|\bhad you (?:drawn|pulled)\b/i.test(prefix)
    || /\b(?:if|hypothetically|hypothetical|imagine|suppose|supposing)\b|\bhad you (?:drawn|pulled)\b/i.test(enclosingPrefix)
    || /\bhypothetical\s+(?:draw|example|spread)\b/i.test(suffix)) return 'hypothetical';
  if (/\b(?:unlike|compared (?:with|to)|rather than|instead of|as opposed to|echoes?|resembles?)\s*(?:the\s+)?$/i.test(prefix)) return 'comparison';

  if (/^(?:is|are|was|were)\s+(?:not|never)\s+(?:absent|missing|undrawn|not drawn)\b/i.test(suffix)
    || /\b(?:did|does)\s+not\s+fail\s+to\s+draw\s*$/i.test(prefix)) return withOuterPolarity('present');

  if (/^(?:(?:is|are|was|were|has been|have been)\s+(?:(?:not|never)\s+(?:drawn|pulled|selected|present|in|among|here)|absent|missing|undrawn)|(?:isn['’]t|aren['’]t|wasn['’]t|weren['’]t)\s+(?:drawn|present|in|among)|(?:does|do|did)\s+(?:not|never)\s+appear)\b/i.test(suffix)
    || /\b(?:you\s+)?(?:(?:did|do|have|had)\s+not|didn['’]t|haven['’]t|never)\s+(?:drawn?|pull(?:ed)?|select(?:ed)?)\s*$/i.test(prefix)
    || /\bneither\s*$/i.test(prefix)) return withOuterPolarity('absent');

  if (/\b(?:you\s+(?:have\s+)?(?:drew|drawn|pulled|selected)|your\s+(?:draw|spread|cards)\s+(?:includes?|contains?))\s*$/i.test(prefix)
    || /^(?:(?:is|are|was|were)\s+(?:drawn|pulled|selected|among your cards|in (?:your|this|the) (?:spread|reading|draw)|your (?:\w+\s+)?card)|(?:appears?|appeared|shows? up)\s+(?:in (?:your|this|the) (?:spread|reading|draw)|among your cards|here|as (?:a |the )?(?:second |additional )?(?:tarot )?card)|(?:occupies?|sits? in|lies? in|falls? in)\s+(?:the |your )?[\w -]{0,40}position)\b/i.test(suffix)
    || /^(?:(?:is|are|was|were)\s+)?in (?:the|your) (?:past|present|future|challenge|outcome|advice|anchor|core|heart|\d+) position\b/i.test(suffix)
    || /\byour (?:past|present|future|challenge|outcome|advice|anchor|core|heart) (?:card|position) (?:is|contains|shows)\s*$/i.test(prefix)
    || /\b(?:past|present|future|challenge|outcome|advice|anchor|core|heart|position(?:\s+\d+)?|card\s*\d+)\s*[:\-–—]\s*$/i.test(prefix)) return withOuterPolarity('present');
  return 'unclassified';
}

export function classifyCardMentions(text, { cardsInfo = [], deckStyle = 'rws-1909' } = {}) {
  if (typeof text !== 'string' || !text) return [];
  const drawn = drawnCardKeys(cardsInfo, deckStyle);
  const terminology = TAROT_TERMINOLOGY_EXCLUSIONS.flatMap(pattern =>
    Array.from(text.matchAll(new RegExp(pattern.source, 'gi'))).map(match => [match.index, match.index + match[0].length]));
  // "The Fool" in "the Fool's Journey" starts before the term, so test overlap, not the start.
  const inTerminology = (start, end) => terminology.some(([termStart, termEnd]) => start < termEnd && end > termStart);
  const candidates = [];
  for (const entry of buildDeckAwarePatterns(deckStyle)) {
    for (const match of text.matchAll(new RegExp(entry.pattern.source, 'gi'))) {
      if (inTerminology(match.index, match.index + match[0].length)) continue;
      candidates.push({ ...entry, start: match.index, end: match.index + match[0].length, observed: match[0] });
    }
  }
  candidates.push(...findFuzzyCardMentions(text, deckStyle).filter(mention => !inTerminology(mention.start, mention.end)));
  candidates.sort((a, b) => a.start - b.start || b.end - a.end
    || Number(drawn.has(b.canonical.toLowerCase())) - Number(drawn.has(a.canonical.toLowerCase()))
    || Number(canonicalCardKey(b.name, deckStyle) === b.canonical.toLowerCase()) - Number(canonicalCardKey(a.name, deckStyle) === a.canonical.toLowerCase()));
  const unique = [];
  for (const row of candidates) {
    if (unique.some(previous => row.start >= previous.start && row.end <= previous.end)) continue;
    unique.push(row);
  }
  return unique.flatMap(mention => {
    const classification = classifyOccurrence(text, mention, unique);
    const explicit = hasExplicitCardContext(text, mention.observed, mention);
    if (classification === 'unclassified') {
      if ((AMBIGUOUS_CARD_NAMES.has(mention.normalized) || mention.isEpithet) && !explicit) return [];
      if (CARD_NAMES_REQUIRING_CARD_CASE.has(mention.normalized) && !explicit
        && !mention.observed.split(/\s+/).filter(word => !['the', 'of'].includes(word.toLowerCase())).every(word => /^[A-Z]/.test(word))) return [];
    }
    return [{ canonical: mention.canonical, start: mention.start, end: mention.end, classification, drawn: drawn.has(mention.canonical.toLowerCase()) }];
  });
}

export function detectUndrawnCardAssertions(text, cardsInfo, deckStyle) {
  return Array.from(new Set(classifyCardMentions(text, { cardsInfo, deckStyle })
    .filter(mention => !mention.drawn && mention.classification === 'present').map(mention => mention.canonical)));
}

