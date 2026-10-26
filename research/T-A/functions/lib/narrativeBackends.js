import { buildGraphContext } from './graphContext.js';
import { selectMemoriesForReading } from './readingMemorySelection.js';
import { prepareReadingContextSources } from './readingContextSources.js';
import { resolveDecisionPathContext, decisionPathRoleCards } from './decisionPathContext.js';
/**
 * Narrative Backend Dispatch and Generation
 *
 * Manages the fallback chain of narrative generation backends:
 * 1. claude-api - Claude (Opus 5.5 by default) via the Anthropic Messages API
 * 2. modal-qwen - Qwen via Modal Chat Completions
 * 3. openai-native - native OpenAI via Responses API
 * 4. local-composer - Deterministic local narrative builder
 *
 * Extracted from tarot-reading.js to maintain <900 line limit.
 */

import { buildEnhancedClaudePrompt } from './narrativeBuilder.js';
import {
  buildCelticCrossReading,
  buildThreeCardReading,
  buildFiveCardReading,
  buildRelationshipReading,
  buildDecisionReading,
  buildSingleCardReading,
  buildPositionCardText,
  buildElementalRemedies,
  shouldOfferElementalRemedies,
  formatReversalLens,
  computeRemedyRotationIndex
} from './narrativeBuilder.js';
import { enhanceSection } from './narrativeSpine.js';
import { callOpenAIResponses, getReasoningEffort, getTextVerbosity, OPENAI_DEFAULT_MODEL } from './openaiResponses.js';
import { callModalChatCompletions, ensureModalConfig, isModalConfigured } from './modalChatCompletions.js';
import { callPersonalTextProvider, getPersonalTextProvider } from './personalTextProvider.js';
import { callClaudeMessages, isAnthropicConfigured } from './anthropicMessages.js';
import {
  buildReasoningAwareOpening,
  buildReasoningSynthesis,
  buildReadingWithReasoning
} from './narrative/reasoningIntegration.js';
import {
  buildExperienceLine,
  getToneStyle,
  buildPersonalizedClosing,
  getDepthProfile,
  sanitizeDisplayName,
  TONE_STYLES,
  FRAME_VOCABULARY
} from './narrative/styleHelpers.js';
import { buildOpening, buildReflectionsSection, prepareReflectionsText, sanitizeQuestionForNarrative } from './narrative/helpers.js';
import { sanitizeQueryCoverage, sanitizeContextSelection, sanitizeGraphRAGDiagnostics } from '../../shared/readingSourceUsage.js';
import { buildMemorySourceUsage, buildUserContextSourceUsage } from './narrative/sourceUsage.js';
import { formatPassagesForPrompt } from './graphRAG.js';
import { buildReadingRedactionOptions } from './promptEngineering.js';
import { evaluateVisionInsightPromptEligibility } from './readingQuality.js';
import {
  resolveSemanticScoring,
  maybeLogPromptPayload
} from './readingTelemetry.js';
import { withSpan } from './tracingSpans.js';
import { getSpreadKey } from './readingQuality.js';
import { resolveContextSelection } from './contextDetection.js';
import { collectQuerentReflections } from './querentReflections.js';

// ============================================================================
// Backend Registry
// ============================================================================

/**
 * Ordered list of backend IDs to try (first available wins).
 * Frozen to prevent accidental mutation.
 */
export const NARRATIVE_BACKEND_ORDER = Object.freeze(['claude-api', 'modal-qwen', 'openai-native', 'local-composer']);
export const LOCAL_COMPOSER_UNSUPPORTED_LANGUAGE_CODE = 'local_composer_unsupported_language';

// Thinking counts toward max_tokens, so a reading needs room for both.
export const CLAUDE_API_READING_MAX_TOKENS = 32000;

/**
 * Backend definitions with availability checks.
 * Frozen to prevent accidental mutation.
 */
export const NARRATIVE_BACKENDS = Object.freeze({
  'claude-code': Object.freeze({
    id: 'claude-code',
    label: 'Claude Code (personal subscription)',
    isAvailable: env => getPersonalTextProvider(env) === 'claude-code'
  }),
  'codex-subscription': Object.freeze({
    id: 'codex-subscription',
    label: 'Codex (ChatGPT subscription)',
    isAvailable: env => getPersonalTextProvider(env) === 'codex-subscription'
  }),
  'claude-api': Object.freeze({
    id: 'claude-api',
    label: 'Claude via the Anthropic Messages API',
    isAvailable: isAnthropicConfigured
  }),
  'modal-qwen': Object.freeze({
    id: 'modal-qwen',
    label: 'Qwen 3.8 Max VL Thinking via Modal Chat Completions',
    isAvailable: isModalConfigured
  }),
  'openai-native': Object.freeze({
    id: 'openai-native',
    label: 'OpenAI Responses API',
    isAvailable: (env) => {
      return Boolean(typeof env?.OPENAI_API_KEY === 'string' && env.OPENAI_API_KEY.trim());
    }
  }),
  'local-composer': Object.freeze({
    id: 'local-composer',
    label: 'Local Narrative Composer',
    isAvailable: () => true
  })
});

/**
 * Get list of available narrative backends for the current environment.
 *
 * @param {Object} env - Cloudflare environment bindings
 * @returns {Array} Array of available backend objects
 */
export function getAvailableNarrativeBackends(env) {
  // A missing gateway must surface as a failed subscription attempt, never select a
  // configured paid provider merely because it is available.
  const personalProvider = getPersonalTextProvider(env);
  if (personalProvider) return [NARRATIVE_BACKENDS[personalProvider], NARRATIVE_BACKENDS['local-composer']];
  return NARRATIVE_BACKEND_ORDER
    .map((id) => {
      const backend = NARRATIVE_BACKENDS[id];
      if (!backend) return null;
      if (!backend.isAvailable(env)) return null;
      return backend;
    })
    .filter(Boolean);
}

const LOCAL_COMPOSER_SCRIPT_PROFILES = Object.freeze([
  {
    code: 'ja',
    label: 'Japanese',
    pattern: /[\p{Script=Hiragana}\p{Script=Katakana}]/gu
  },
  {
    code: 'han',
    label: 'Han-script language',
    pattern: /\p{Script=Han}/gu
  },
  {
    code: 'hangul',
    label: 'Korean',
    pattern: /\p{Script=Hangul}/gu
  },
  {
    code: 'cyrillic',
    label: 'Cyrillic-script language',
    pattern: /\p{Script=Cyrillic}/gu
  },
  {
    code: 'arabic',
    label: 'Arabic',
    pattern: /\p{Script=Arabic}/gu
  },
  {
    code: 'hebrew',
    label: 'Hebrew',
    pattern: /\p{Script=Hebrew}/gu
  },
  {
    code: 'greek',
    label: 'Greek',
    pattern: /\p{Script=Greek}/gu
  },
  {
    code: 'devanagari',
    label: 'Devanagari-script language',
    pattern: /\p{Script=Devanagari}/gu
  }
]);

const LOCAL_COMPOSER_LANGUAGE_PROFILES = Object.freeze([
  {
    code: 'es',
    label: 'Spanish',
    accentPattern: /[¿¡ñáéíóú]/u,
    strongTokens: new Set(['puedo', 'debo', 'quiero', 'necesito', 'siento', 'estoy', 'esta', 'avanzar', 'necesitas', 'puedes']),
    weakTokens: new Set(['como', 'relacion', 'trabajo', 'amor', 'lectura'])
  },
  {
    code: 'fr',
    label: 'French',
    accentPattern: /[àâçéèêëîïôùûüÿœ]/u,
    strongTokens: new Set(['puis', 'dois', 'avec', 'sans', 'cette', 'dans', 'besoin', 'ressens', 'voudrais', 'peux']),
    weakTokens: new Set(['comment', 'relation', 'travail', 'amour', 'lecture', 'avance'])
  },
  {
    code: 'pt',
    label: 'Portuguese',
    accentPattern: /[ãõáàâêéíóôúç]/u,
    strongTokens: new Set(['posso', 'devo', 'preciso', 'estou', 'sinto', 'nesta', 'nessa', 'relacao', 'avancar']),
    weakTokens: new Set(['como', 'trabalho', 'amor', 'leitura'])
  },
  {
    code: 'de',
    label: 'German',
    accentPattern: /[äöüß]/u,
    strongTokens: new Set(['wie', 'kann', 'soll', 'beziehung', 'arbeit', 'liebe', 'fuhle', 'mochte', 'brauche']),
    weakTokens: new Set(['lesen'])
  },
  {
    code: 'it',
    label: 'Italian',
    accentPattern: /[àèéìòù]/u,
    strongTokens: new Set(['posso', 'devo', 'relazione', 'lavoro', 'amore', 'lettura', 'sento', 'bisogno', 'avanzare']),
    weakTokens: new Set(['come'])
  }
]);

function tokenizeLanguageHintText(text) {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .match(/\p{L}+/gu) || [];
}

function buildUnsupportedLocalComposerLanguageResult(language, label, score, reason) {
  return {
    supported: false,
    language,
    label,
    score,
    reason,
    userFacingMessage: 'Non-English questions require an AI narrative provider because the local fallback only supports English.'
  };
}

function countScriptMatches(text, pattern) {
  return (text.match(pattern) || []).length;
}

function detectUnsupportedNonLatinScript(question) {
  const latinLetterCount = countScriptMatches(question, /\p{Script=Latin}/gu);

  for (const profile of LOCAL_COMPOSER_SCRIPT_PROFILES) {
    const scriptCharCount = countScriptMatches(question, profile.pattern);
    if (scriptCharCount === 0) continue;

    const likelyPrimaryScript = latinLetterCount === 0 ||
      scriptCharCount >= 4 ||
      scriptCharCount > latinLetterCount;
    if (!likelyPrimaryScript) {
      continue;
    }

    const reason = `Local composer only supports English question prompts. Detected likely ${profile.label} input; same-language output requires an AI narrative provider.`;
    return buildUnsupportedLocalComposerLanguageResult(
      profile.code,
      profile.label,
      scriptCharCount + latinLetterCount,
      reason
    );
  }

  return null;
}

function scoreLanguageProfile(question, tokens, profile) {
  const accentHit = profile.accentPattern.test(question) ? 1 : 0;
  let strongHits = 0;
  let weakHits = 0;

  for (const token of tokens) {
    if (profile.strongTokens.has(token)) {
      strongHits += 1;
      continue;
    }
    if (profile.weakTokens.has(token)) {
      weakHits += 1;
    }
  }

  return {
    accentHit,
    strongHits,
    weakHits,
    score: (accentHit * 3) + (strongHits * 2) + weakHits
  };
}

function normalizeLocalComposerLanguageInput(input) {
  if (typeof input === 'string') {
    return input.trim();
  }
  if (!input || typeof input !== 'object') {
    return '';
  }

  return [
    input.userQuestion,
    input.reflectionsText,
    input.decisionPaths?.a,
    input.decisionPaths?.b
  ]
    .filter((value) => typeof value === 'string' && value.trim())
    .join('\n')
    .trim();
}

export function getLocalComposerLanguageSupport(input) {
  const text = normalizeLocalComposerLanguageInput(input);
  if (!text) {
    return {
      supported: true,
      language: 'unknown',
      label: 'Unknown',
      score: 0,
      reason: null,
      userFacingMessage: null
    };
  }

  // Be conservative about blocking: a false positive is worse than falling back
  // to English when the signal is weak or just a borrowed noun.
  const unsupportedScriptResult = detectUnsupportedNonLatinScript(text);
  if (unsupportedScriptResult) {
    return unsupportedScriptResult;
  }

  const tokens = tokenizeLanguageHintText(text);
  let bestMatch = null;

  for (const profile of LOCAL_COMPOSER_LANGUAGE_PROFILES) {
    const profileScore = scoreLanguageProfile(text, tokens, profile);

    if (!bestMatch || profileScore.score > bestMatch.score) {
      bestMatch = {
        code: profile.code,
        label: profile.label,
        score: profileScore.score,
        accentHit: profileScore.accentHit,
        strongHits: profileScore.strongHits,
        weakHits: profileScore.weakHits
      };
    }
  }

  const shouldBlock = Boolean(bestMatch) && (
    (bestMatch.accentHit >= 1 && (bestMatch.strongHits + bestMatch.weakHits) >= 1) ||
    bestMatch.strongHits >= 2 ||
    (bestMatch.strongHits >= 1 && bestMatch.weakHits >= 1)
  );

  if (!shouldBlock) {
    return {
      supported: true,
      language: 'en',
      label: 'English or unknown',
      score: bestMatch?.score || 0,
      reason: null,
      userFacingMessage: null
    };
  }

  const reason = `Local composer only supports English question prompts. Detected likely ${bestMatch.label} input; same-language output requires an AI narrative provider.`;
  return buildUnsupportedLocalComposerLanguageResult(bestMatch.code, bestMatch.label, bestMatch.score, reason);
}

// ============================================================================
// Spread Reading Builders (for local composer)
// ============================================================================

/**
 * Map of spread keys to their builder functions.
 */
const SPREAD_READING_BUILDERS = {
  celtic: ({ spreadAnalysis, cardsInfo, userQuestion, reflectionsText, themes, context, spreadInfo }, options = {}) =>
    spreadAnalysis
      ? buildCelticCrossReading({
        cardsInfo,
        userQuestion,
        reflectionsText,
        celticAnalysis: spreadAnalysis,
        themes,
        context,
        spreadInfo
      }, options)
      : null,
  threeCard: ({ spreadAnalysis, cardsInfo, userQuestion, reflectionsText, themes, context, spreadInfo }, options = {}) =>
    spreadAnalysis
      ? buildThreeCardReading({
        cardsInfo,
        userQuestion,
        reflectionsText,
        threeCardAnalysis: spreadAnalysis,
        themes,
        context,
        spreadInfo
      }, options)
      : null,
  fiveCard: ({ spreadAnalysis, cardsInfo, userQuestion, reflectionsText, themes, context, spreadInfo }, options = {}) =>
    spreadAnalysis
      ? buildFiveCardReading({
        cardsInfo,
        userQuestion,
        reflectionsText,
        fiveCardAnalysis: spreadAnalysis,
        themes,
        context,
        spreadInfo
      }, options)
      : null,
  relationship: ({ spreadAnalysis, cardsInfo, userQuestion, reflectionsText, themes, context, spreadInfo }, options = {}) =>
    buildRelationshipReading({ spreadAnalysis, cardsInfo, userQuestion, reflectionsText, themes, context, spreadInfo }, options),
  decision: ({ spreadAnalysis, cardsInfo, userQuestion, reflectionsText, themes, context, spreadInfo }, options = {}) =>
    buildDecisionReading({ spreadAnalysis, cardsInfo, userQuestion, reflectionsText, themes, context, spreadInfo, decisionPaths: options.decisionPaths }, options),
  single: ({ spreadAnalysis, cardsInfo, userQuestion, reflectionsText, themes, context, spreadInfo }, options = {}) =>
    buildSingleCardReading({ spreadAnalysis, cardsInfo, userQuestion, reflectionsText, themes, context, spreadInfo }, options)
};

function parseBooleanFlag(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value > 0;
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function shouldAppendGraphRAGDebugOutput(env) {
  return parseBooleanFlag(
    env?.LOCAL_COMPOSER_APPEND_GRAPHRAG_DEBUG ?? env?.DEBUG_LOCAL_COMPOSER_GRAPHRAG,
    false
  );
}

function hasMeaningfulGraphData(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'boolean') return value === true;
  if (typeof value === 'number') return Number.isFinite(value) && value > 0;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.some((entry) => hasMeaningfulGraphData(entry));
  if (typeof value === 'object') {
    return Object.values(value).some((entry) => hasMeaningfulGraphData(entry));
  }
  return false;
}

function hasMeaningfulGraphKeys(graphKeys) {
  return hasMeaningfulGraphData(graphKeys);
}

function hasMeaningfulGraphRAGPayload(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (Array.isArray(payload.passages) && payload.passages.length > 0) return true;
  if (typeof payload.formattedBlock === 'string' && payload.formattedBlock.trim()) return true;
  if (typeof payload.initialPassageCount === 'number' && payload.initialPassageCount > 0) return true;
  if (typeof payload.maxPassages === 'number' && payload.maxPassages > 0) return true;
  if (payload.semanticScoringRequested === true || payload.semanticScoringFallback === true || payload.enableSemanticScoring === true) {
    return true;
  }
  return payload.retrievalSummary && typeof payload.retrievalSummary === 'object'
    ? Object.keys(payload.retrievalSummary).length > 0
    : false;
}

function summarizeVisionPromptEligibility(visionInsights) {
  if (!Array.isArray(visionInsights) || visionInsights.length === 0) {
    return {
      eligibleUploads: 0,
      telemetryOnlyUploads: 0,
      suppressionReasons: null
    };
  }

  const suppressionReasons = {};
  let eligibleUploads = 0;
  let telemetryOnlyUploads = 0;

  visionInsights.forEach((entry) => {
    const eligibility = evaluateVisionInsightPromptEligibility(entry);
    if (eligibility.promptEligible) {
      eligibleUploads += 1;
      return;
    }
    telemetryOnlyUploads += 1;
    if (eligibility.suppressionReason) {
      suppressionReasons[eligibility.suppressionReason] = (suppressionReasons[eligibility.suppressionReason] || 0) + 1;
    }
  });

  return {
    eligibleUploads,
    telemetryOnlyUploads,
    suppressionReasons: Object.keys(suppressionReasons).length > 0 ? suppressionReasons : null
  };
}

function buildLocalComposerSourceUsage(payload, promptMeta, graphRAGPayload, { focusAreasSuppressed = false, renderedReading = '' } = {}) {
  const analysis = payload?.analysis || {};
  const personalization = payload?.personalization || {};
  const rawUserQuestion = typeof payload?.userQuestion === 'string' ? payload.userQuestion : '';
  const rawReflections = collectQuerentReflections(payload?.reflectionsText, payload?.cardsInfo);
  const generalReflections = typeof payload?.reflectionsText === 'string' ? payload.reflectionsText.trim() : '';
  // Match collectQuerentReflections' case/whitespace-insensitive deduplication.
  const normalizeReflection = text => text.toLowerCase().replace(/\s+/g, ' ').trim();
  const includedReflections = normalizeReflection(prepareReflectionsText(rawReflections));
  const completeReflections = normalizeReflection(prepareReflectionsText(rawReflections, { maxLength: rawReflections.length || 1 }));
  let nextReflectionOffset = 0;
  const reflectionFields = Object.fromEntries([
    ['reflections', generalReflections],
    ...(payload?.cardsInfo || []).map((card, index) => [`card-${index}`, card?.userReflection || ''])
  ].map(([key, value]) => {
    const text = typeof value === 'string' ? value : '';
    const inputStats = payload?.userContextInputStats?.[key];
    const originalLength = inputStats?.originalLength ?? text.length;
    const prepared = normalizeReflection(prepareReflectionsText(text, { maxLength: text.length || 1 }));
    // Locate each complete note in composition order before measuring the cap.
    // A shared prefix in an earlier note is not evidence for a later note.
    const representedByGeneral = key !== 'reflections' && prepared
      && normalizeReflection(generalReflections).includes(normalizeReflection(text));
    const start = prepared ? completeReflections.indexOf(prepared, representedByGeneral ? 0 : nextReflectionOffset) : -1;
    if (start >= 0 && !representedByGeneral) nextReflectionOffset = start + prepared.length;
    let includedLength = 0;
    if (start >= 0) {
      while (includedLength < prepared.length && prepared[includedLength] === includedReflections[start + includedLength]) includedLength += 1;
    }
    return [key, {
      originalLength, sanitizedLength: text.length, includedLength,
      sanitizationChanged: Boolean(inputStats?.sanitizationChanged),
      sanitizationTruncated: Boolean(inputStats?.sanitizationTruncated),
      limitApplied: Boolean(prepared && includedLength < prepared.length),
      omitted: Boolean(originalLength && includedLength === 0),
      reason: originalLength && !prepared ? 'sanitized_empty' : prepared && includedLength < prepared.length ? 'input_limit' : null
    }];
  }));
  const pathContext = resolveDecisionPathContext({ spreadKey: analysis.spreadKey, cardsInfo: payload.cardsInfo, decisionPaths: payload.decisionPaths });
  for (const [id, key] of [['pathA', 'a'], ['pathB', 'b']]) {
    const stats = payload?.userContextInputStats?.[id] || pathContext.inputStats[id];
    if (!stats) continue;
    const text = pathContext.decisionPaths[key] || '';
    reflectionFields[id] = {
      ...stats, sanitizedLength: stats.sanitizedLength ?? text.length,
      eligibleLength: text.length, includedLength: text.length,
      omitted: Boolean(stats.originalLength && !text),
      reason: !text && stats.originalLength ? 'sanitized_empty' : stats.limitApplied ? 'input_limit' : null
    };
  }
  for (const [index, card] of (payload?.cardsInfo || []).entries()) {
    if (!card?.callerMeaning) continue;
    reflectionFields[`interpretation-${index}`] = { originalLength: card.callerMeaning.length, sanitizedLength: card.callerMeaning.length, includedLength: 0, omitted: true, reason: 'not_used_by_backend' };
  }
  const cardFields = Object.entries(reflectionFields).filter(([key]) => key.startsWith('card-')).map(([, field]) => field);
  const rawFocusAreas = Array.isArray(personalization?.focusAreas)
    ? personalization.focusAreas.filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
    : [];
  const rawDisplayName = typeof personalization?.displayName === 'string' ? personalization.displayName : '';
  const safeDisplayName = sanitizeDisplayName(rawDisplayName);
  const sanitizedQuestion = sanitizeQuestionForNarrative(rawUserQuestion);
  const toneKey = typeof personalization?.readingTone === 'string' ? personalization.readingTone : '';
  const frameKey = typeof personalization?.spiritualFrame === 'string' ? personalization.spiritualFrame : '';
  const experienceKey = typeof personalization?.tarotExperience === 'string' ? personalization.tarotExperience : '';
  const depthKey = typeof personalization?.preferredSpreadDepth === 'string' ? personalization.preferredSpreadDepth : '';
  const hasSupportedTone = Boolean(toneKey && Object.prototype.hasOwnProperty.call(TONE_STYLES, toneKey));
  const hasSupportedFrame = Boolean(frameKey && Object.prototype.hasOwnProperty.call(FRAME_VOCABULARY, frameKey));
  const hasSupportedExperience = Boolean(buildExperienceLine(experienceKey));
  const depthProfile = getDepthProfile(depthKey);
  const hasSupportedDepth = Boolean(depthKey) && depthProfile.key === depthKey;
  const userContext = buildUserContextSourceUsage({
    ...Object.fromEntries(['pathA', 'pathB'].map(key => [key, {
      provided: Boolean(reflectionFields[key]?.originalLength),
      used: Boolean(reflectionFields[key]?.includedLength),
      skippedReason: reflectionFields[key]?.reason
    }])),
    question: {
      provided: rawUserQuestion.trim().length > 0,
      used: Boolean(sanitizedQuestion),
      skippedReason: rawUserQuestion.trim().length > 0 && !sanitizedQuestion ? 'sanitized_empty' : null
    },
    reflections: {
      provided: reflectionFields.reflections.originalLength > 0,
      used: reflectionFields.reflections.includedLength > 0,
      skippedReason: reflectionFields.reflections.reason
    },
    callerInterpretations: {
      provided: (payload?.cardsInfo || []).some(card => Boolean(card?.callerMeaning)),
      used: false,
      skippedReason: 'not_used_by_backend'
    },
    cardReflections: {
      provided: cardFields.some(field => field.originalLength > 0),
      used: cardFields.some(field => field.includedLength > 0),
      skippedReason: cardFields.some(field => field.limitApplied) ? 'input_limit' : 'sanitized_empty'
    },
    focusAreas: {
      provided: rawFocusAreas.length > 0,
      used: rawFocusAreas.length > 0 && !focusAreasSuppressed,
      skippedReason: focusAreasSuppressed ? 'current_context_priority' : null
    },
    displayName: {
      provided: rawDisplayName.trim().length > 0,
      used: Boolean(safeDisplayName),
      skippedReason: rawDisplayName.trim().length > 0 && !safeDisplayName ? 'sanitized_empty' : null
    },
    experience: {
      provided: Boolean(experienceKey),
      used: hasSupportedExperience,
      skippedReason: experienceKey && !hasSupportedExperience ? 'unsupported_value' : null
    },
    tone: {
      provided: Boolean(toneKey),
      used: hasSupportedTone,
      skippedReason: toneKey && !hasSupportedTone ? 'unsupported_value' : null
    },
    frame: {
      provided: Boolean(frameKey),
      used: hasSupportedFrame,
      skippedReason: frameKey && !hasSupportedFrame ? 'unsupported_value' : null
    },
    depth: {
      provided: Boolean(depthKey),
      used: hasSupportedDepth,
      skippedReason: depthKey
        ? (hasSupportedDepth ? null : 'unsupported_value')
        : null
    }
  });

  const hasVisionSource = Array.isArray(payload?.visionInsights) && payload.visionInsights.length > 0;
  const visionPromptEligibility = summarizeVisionPromptEligibility(payload?.visionInsights);

  const hasGraphRAGSource = hasMeaningfulGraphRAGPayload(graphRAGPayload) || hasMeaningfulGraphKeys(analysis?.themes?.knowledgeGraph?.graphKeys);
  const graphRAGUsed = false;
  const graphRAGMode = 'none';
  const passagesProvided = Array.isArray(graphRAGPayload?.passages) ? graphRAGPayload.passages.length : 0;
  const passagesUsedInPrompt = 0;
  const suppliedHighlights = analysis.themes?.knowledgeGraph?.narrativeHighlights;
  const deckStyle = payload.deckStyle || payload.spreadInfo?.deckStyle || payload.cardsInfo?.find(card => card?.deckStyle)?.deckStyle || analysis.themes?.deckStyle || 'rws-1909';
  const safeHighlights = suppliedHighlights?.length ? (buildGraphContext(payload.cardsInfo || [], { deckStyle })?.narrativeHighlights || []).slice(0, 5) : [];
  const synthesis = renderedReading.match(/### Deeper Patterns\n([\s\S]*?)(?=\n### |$)/)?.[1] || '';
  const patternsUsedInPrompt = safeHighlights.filter(highlight => synthesis.includes(`- ${highlight.text.replace(/\*\*/g, '')}`)).length;
  const graphRAGSkippedReason = hasGraphRAGSource ? 'not_used_by_backend' : 'not_requested';

  const ephemerisContext = analysis?.ephemerisContext || null;
  const ephemerisForecast = analysis?.ephemerisForecast || null;
  const ephemerisRequested = Boolean(ephemerisContext);
  const forecastRequested = Boolean(ephemerisForecast);

  return {
    spreadCards: {
      requested: true,
      used: true,
      skippedReason: null
    },
    vision: {
      requested: hasVisionSource,
      used: false,
      eligibleUploads: visionPromptEligibility.eligibleUploads,
      telemetryOnlyUploads: visionPromptEligibility.telemetryOnlyUploads,
      suppressionReasons: visionPromptEligibility.suppressionReasons,
      skippedReason: hasVisionSource ? 'not_used_by_backend' : 'not_provided'
    },
    userContext: { ...userContext, fields: reflectionFields },
    graphRAG: {
      ...sanitizeGraphRAGDiagnostics(promptMeta.graphRAG),
      retainedPassageCount: 0,
      requested: hasGraphRAGSource,
      used: graphRAGUsed,
      mode: graphRAGMode,
      passagesProvided,
      passagesUsedInPrompt,
      passageIndices: [],
      skippedReason: graphRAGSkippedReason
    },
    patterns: {
      requested: safeHighlights.length > 0,
      used: patternsUsedInPrompt > 0,
      patternsProvided: safeHighlights.length,
      patternsUsedInPrompt,
      skippedReason: safeHighlights.length ? (patternsUsedInPrompt ? null : 'not_used_by_backend') : 'not_requested'
    },
    ephemeris: {
      requested: ephemerisRequested,
      used: false,
      skippedReason: ephemerisRequested
        ? (ephemerisContext?.available ? 'not_used_by_backend' : 'unavailable')
        : 'not_requested'
    },
    forecast: {
      requested: forecastRequested,
      used: false,
      skippedReason: forecastRequested
        ? (ephemerisForecast?.available ? 'not_used_by_backend' : 'unavailable')
        : 'not_requested'
    }
  };
}

// ============================================================================
// Responses API Backend
// ============================================================================

/**
 * Build prompts for the Responses API backend.
 *
 * @param {Object} env - Environment bindings
 * @param {Object} payload - Reading payload
 * @param {string} requestId - Request ID for logging
 * @returns {Object} { systemPrompt, userPrompt, promptMeta }
 */
/** Direct internal callers freeze once; route callers retain the private selection. */
function ensureReadingMemorySelection(payload) {
  if (payload.useSavedMemories === false) {
    payload.memories = [];
    return;
  }
  payload.memorySelection ||= selectMemoriesForReading(payload.memories, {
    sources: prepareReadingContextSources({
      spreadKey: getSpreadKey(payload.spreadInfo?.name, payload.spreadInfo?.key),
      userQuestion: payload.userQuestion, reflectionsText: payload.reflectionsText,
      cardsInfo: payload.cardsInfo, decisionPaths: payload.decisionPaths,
      focusAreas: payload.personalization?.focusAreas
    }),
    contextSelection: payload.contextSelection,
    displayName: payload.personalization?.displayName,
    personalization: payload.personalization,
    userId: payload.memoryAccessOwnerId
  });
  payload.memories = payload.memorySelection.memories;
}

export function buildOpenAIResponsesPrompts(env, payload, requestId = 'unknown', options = {}) {
  const {
    spreadInfo,
    cardsInfo,
    userQuestion,
    reflectionsText,
    analysis,
    context,
    contextInputText,
    visionInsights,
    visionEvidence,
    contextDiagnostics = []
  } = payload;

  // Original positions can supply effective decision labels without reflections.
  const hasLegacyDecisionPaths = !payload.contextSelection && getSpreadKey(spreadInfo?.name, spreadInfo?.key) === 'decision'
    && resolveDecisionPathContext({ spreadKey: 'decision', cardsInfo, decisionPaths: payload.decisionPaths }).sources.length > 0;
  // Internal callers without a route decision derive it once for all retries.
  payload.contextSelection ||= resolveContextSelection({
    userQuestion, reflectionsText, decisionPaths: payload.decisionPaths,
    ...(hasLegacyDecisionPaths || payload.decisionPaths || reflectionsText !== undefined || cardsInfo?.some(card => card?.userReflection) ? { cardsInfo } : {}),
    focusAreas: payload.personalization?.focusAreas, contextInputText
  }, getSpreadKey(spreadInfo?.name, spreadInfo?.key));
  ensureReadingMemorySelection(payload);

  const deckStyle = payload.deckStyle || spreadInfo?.deckStyle || cardsInfo?.[0]?.deckStyle || analysis?.themes?.deckStyle || 'rws-1909';

  const promptProvider = options.providerLabel || 'OpenAI Responses';
  const backendId = options.backendId || 'openai-native';
  console.log(`[${requestId}] Building ${promptProvider} prompts...`);

  // Resolve semantic scoring: env override takes priority, then graphRAG payload setting
  const enableSemanticScoring = resolveSemanticScoring(
    env,
    analysis.graphRAGPayload?.enableSemanticScoring ?? null
  );

  const effectiveGraphRAGPayload =
    analysis?.graphRAGPayload ||
    payload?.graphRAGPayload ||
    analysis?.themes?.knowledgeGraph?.graphRAGPayload ||
    null;

  // Build enhanced prompts using narrative builder
  const { systemPrompt, userPrompt, promptMeta, memoryRetention, contextDiagnostics: promptDiagnostics } = buildEnhancedClaudePrompt({
    contextSelection: payload.contextSelection,
    userContextInputStats: payload.userContextInputStats,
    decisionPaths: payload.decisionPaths,
    spreadInfo,
    cardsInfo,
    userQuestion,
    contextInputText,
    reflectionsText,
    themes: analysis.themes,
    spreadAnalysis: analysis.spreadAnalysis,
    context,
    visionInsights,
    visionEvidence,
    deckStyle,
    graphRAGPayload: effectiveGraphRAGPayload,
    ephemerisContext: analysis.ephemerisContext,
    ephemerisForecast: analysis.ephemerisForecast,
    transitResonances: analysis.transitResonances,
    budgetTarget: options.budgetTarget || 'openai',
    contextDiagnostics,
    promptBudgetEnv: env,
    personalization: payload.personalization,
    memories: payload.memories,
    useSavedMemories: payload.useSavedMemories,
    memorySelection: payload.memorySelection,
    memoryAccessOwnerId: payload.memoryAccessOwnerId,
    enableSemanticScoring,
    subscriptionTier: payload.subscriptionTier,
    variantOverrides: payload.variantPromptOverrides
  });

  if (promptMeta) {
    payload.promptMeta = promptMeta;
  }
  payload.memoryRetention = memoryRetention;

  if (Array.isArray(promptDiagnostics) && promptDiagnostics.length) {
    payload.contextDiagnostics = Array.from(new Set([...(payload.contextDiagnostics || []), ...promptDiagnostics]));
  }

  // Card reflections can name people too, so redaction hints read every reflection.
  const querentReflections = collectQuerentReflections(reflectionsText, cardsInfo);
  const promptRedactionOptions = buildReadingRedactionOptions({
    personalization: payload.personalization,
    cardsInfo: payload.cardsInfo,
    userQuestion,
    reflectionsText: querentReflections,
    memories: payload.memories,
    decisionPaths: payload.decisionPaths
  });

  console.log(`[${requestId}] System prompt length: ${systemPrompt.length}, User prompt length: ${userPrompt.length}`);
  maybeLogPromptPayload(
    env,
    requestId,
    backendId,
    systemPrompt,
    userPrompt,
    promptMeta,
    {
      personalization: payload.personalization,
      userQuestion,
      reflectionsText: querentReflections,
      redactionOptions: promptRedactionOptions
    }
  );

  return {
    systemPrompt,
    userPrompt,
    promptMeta
  };
}

/**
 * Generate a reading with the configured Qwen endpoint on Modal.
 */
export async function generateWithModalQwen(env, payload, requestId = 'unknown') {
  const { model, reasoningEffort, stream } = ensureModalConfig(env);
  const { systemPrompt, userPrompt, promptMeta } = buildOpenAIResponsesPrompts(
    env,
    payload,
    requestId,
    {
      backendId: 'modal-qwen',
      providerLabel: 'Modal Chat Completions',
      budgetTarget: 'modal'
    }
  );

  console.log(`[${requestId}] Request config:`, {
    provider: 'modal-qwen',
    model,
    reasoning_effort: reasoningEffort,
    stream
  });

  const result = await callModalChatCompletions(env, {
    systemPrompt,
    userPrompt,
    requestId,
    signal: payload.signal
  });

  console.log(`[${requestId}] Generated Modal reading length: ${result.text.length} characters`);
  promptMeta.inference = { provider: 'modal-qwen', model: result.model };

  return {
    reading: result.text,
    reasoningSummary: null,
    prompts: {
      system: systemPrompt,
      user: userPrompt
    },
    usage: result.usage,
    model: result.model,
    promptMeta
  };
}

/**
 * Generate reading using native OpenAI via Responses API.
 *
 * @param {Object} env - Environment bindings
 * @param {Object} payload - Reading payload
 * @param {string} requestId - Request ID for logging
 * @returns {Promise<Object>} { reading, prompts, usage }
 */
export async function generateWithOpenAIResponses(env, payload, requestId = 'unknown') {
  const effectiveModel = env.OPENAI_MODEL || OPENAI_DEFAULT_MODEL;
  const { systemPrompt, userPrompt, promptMeta } = buildOpenAIResponsesPrompts(env, payload, requestId);

  const reasoningEffort = getReasoningEffort(env, effectiveModel);
  const verbosity = getTextVerbosity(env, effectiveModel);

  console.log(`[${requestId}] Request config:`, {
    provider: 'openai-native',
    model: effectiveModel,
    max_output_tokens: 'unlimited',
    reasoning_effort: reasoningEffort,
    verbosity
  });

  // Call OpenAI Responses API using consolidated helper
  const result = await callOpenAIResponses(env, {
    instructions: systemPrompt,
    input: userPrompt,
    maxTokens: null,          // No limit for full readings
    reasoningEffort,          // Env override or model default
    reasoningSummary: 'auto', // Get reasoning summary in response
    verbosity,
    signal: payload.signal,
    requestId,
    returnFullResponse: true  // Get usage data
  });

  console.log(`[${requestId}] Generated reading length: ${result.text.length} characters`);
  promptMeta.inference = { provider: 'openai-native', model: result.model, responseShape: result.responseShape };
  if (result.usage) {
    console.log(`[${requestId}] Token usage:`, {
      input_tokens: result.usage.input_tokens,
      output_tokens: result.usage.output_tokens,
      reasoning_tokens: result.usage.output_tokens_details?.reasoning_tokens,
      total_tokens: result.usage.total_tokens
    });
  }
  if (result.reasoningSummary) {
    console.log(`[${requestId}] Reasoning summary available: ${result.reasoningSummary.length} chars`);
  }

  // Return reading with captured prompts for engineering analysis
  return {
    reading: result.text,
    reasoningSummary: result.reasoningSummary || null,
    prompts: {
      system: systemPrompt,
      user: userPrompt
    },
    usage: result.usage,
    model: result.model,
    promptMeta
  };
}

// ============================================================================
// Claude API Backend (Anthropic Messages API)
// ============================================================================

/**
 * Generate a reading with Claude through the Anthropic Messages API.
 *
 * Release QA swaps `send` for the Claude Code subscription transport, so its
 * samples use this exact prompt and request; only the billing path differs.
 *
 * @param {Object} env - Environment bindings
 * @param {Object} payload - Reading payload
 * @param {string} requestId - Request ID for logging
 * @param {Object} [options]
 * @param {Function} [options.send] - Takes callClaudeMessages' arguments and result shape
 * @param {string} [options.provider] - Provider recorded in promptMeta.inference
 * @returns {Promise<Object>} { reading, prompts, usage, promptMeta, model }
 */
export async function generateWithClaudeApi(env, payload, requestId = 'unknown', {
  send = callClaudeMessages,
  provider = 'claude-api'
} = {}) {
  const { systemPrompt, userPrompt, promptMeta } = buildOpenAIResponsesPrompts(env, payload, requestId, {
    backendId: 'claude-api',
    providerLabel: 'Claude Messages API',
    budgetTarget: 'claude'
  });

  const result = await send(env, {
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
    maxTokens: CLAUDE_API_READING_MAX_TOKENS,
    signal: payload.signal,
    requestId
  });
  if (!result.text) {
    throw new Error('Claude API returned no reading text.');
  }

  console.log(`[${requestId}] Generated Claude reading length: ${result.text.length} characters`);
  if (promptMeta) {
    promptMeta.inference = { provider, model: result.model };
  }

  return {
    reading: result.text,
    reasoningSummary: null,
    prompts: {
      system: systemPrompt,
      user: userPrompt
    },
    usage: result.usage,
    promptMeta,
    model: result.model
  };
}

// ============================================================================
// Local Composer Backend
// ============================================================================

/**
 * Generate reading from spread analysis using appropriate builder.
 *
 * @param {Object} params - Analysis parameters
 * @param {Object} options - Builder options
 * @returns {Promise<string>} Generated reading text
 */
async function generateReadingFromAnalysis(
  { spreadKey, spreadAnalysis, cardsInfo, userQuestion, reflectionsText, themes, spreadInfo, context },
  options = {}
) {
  const builder = SPREAD_READING_BUILDERS[spreadKey];

  if (builder) {
    const result = await builder({
      spreadAnalysis,
      cardsInfo,
      userQuestion,
      reflectionsText,
      themes,
      spreadInfo,
      context
    }, options);

    if (typeof result === 'string' && result.trim()) {
      return result;
    }
  }

  return buildGenericReading(
    {
      spreadInfo,
      cardsInfo,
      userQuestion,
      reflectionsText,
      themes,
      context
    },
    options
  );
}

/**
 * Condense text to specified sentence count for concise depth profile.
 */
function condenseDescriptionForDepth(text, sentenceCount = 2) {
  if (!text || typeof text !== 'string') {
    return text;
  }
  const segments = text.match(/[^.!?]+[.!?]?/g);
  if (!segments || segments.length <= sentenceCount) {
    return text;
  }
  return segments.slice(0, sentenceCount).join(' ').trim();
}

/**
 * Build reflection prompt for expansive depth profile.
 */
function buildDepthReflectionPrompt(card, position) {
  if (!card) return '';
  const cardName = typeof card.card === 'string' && card.card.trim() ? card.card.trim() : 'this card';
  const orientation = typeof card.orientation === 'string' && card.orientation.trim() ? ` ${card.orientation.trim()}` : '';
  const focus = (position || 'this position').toLowerCase();
  return `Journal on how ${cardName}${orientation} wants you to engage with ${focus}.`;
}

/**
 * Build cards section with reversal framework awareness.
 */
function buildCardsSection(cardsInfo, context, options = {}) {
  const safeCards = Array.isArray(cardsInfo) ? cardsInfo : [];
  const normalizedDetail = typeof options.detailLevel === 'string' ? options.detailLevel : 'standard';
  const heading = options.heading
    || (normalizedDetail === 'concise'
      ? '**Quick Card Highlights**'
      : normalizedDetail === 'expansive'
        ? '**Layered Card Weaving**'
        : '**The Cards Speak**');

  const lines = safeCards.map((card, index) => {
    const position = (card?.position || '').trim() || `Card ${index + 1}`;
    let description = buildPositionCardText(card, position, { context });
    if (normalizedDetail === 'concise') {
      description = condenseDescriptionForDepth(description);
    } else if (normalizedDetail === 'expansive') {
      const reflectionPrompt = buildDepthReflectionPrompt(card, position);
      if (reflectionPrompt) {
        description = `${description}\n*Deep dive: ${reflectionPrompt}*`;
      }
    }
    return `**${position}**\n${description}`;
  });

  let section = `${heading}\n\n${lines.join('\n\n')}`;
  if (options.note) {
    section += `\n\n${options.note}`;
  }
  return section;
}

/**
 * Enhanced synthesis with rich theme analysis.
 */
function buildEnhancedSynthesis(cardsInfo, themes, userQuestion, context, options = {}) {
  const safeCards = Array.isArray(cardsInfo) ? cardsInfo : [];
  const depthProfile = options.depthProfile || null;
  const heading = depthProfile?.key === 'short'
    ? '**Quick Trajectory**'
    : depthProfile?.key === 'deep'
      ? '**Deep Synthesis & Guidance**'
      : '**Synthesis & Guidance**';
  let section = `${heading}\n\n`;
  const rotationIndex = Number.isFinite(options.rotationIndex)
    ? Math.abs(Math.floor(options.rotationIndex))
    : 0;

  if (context && context !== 'general') {
    const contextMap = {
      love: 'relationships and heart-centered experience',
      career: 'career, vocation, and material pathways',
      self: 'personal growth and inner landscape',
      spiritual: 'spiritual practice and meaning-making'
    };
    const descriptor = contextMap[context] || 'your life as a whole';
    section += `Focus: Interpreting the spread through the lens of ${descriptor}.\n\n`;
  }

  // Suit focus
  if (themes.suitFocus) {
    section += `${themes.suitFocus}\n\n`;
  }

  // Timing profile (soft, non-deterministic)
  if (themes.timingProfile === 'near-term-tilt') {
    section += `Pace: These influences are likely to move or clarify in the nearer term, assuming you stay engaged with them.\n\n`;
  } else if (themes.timingProfile === 'longer-arc-tilt') {
    section += `Pace: This reading leans toward a slower-burn, structural arc that unfolds over a longer chapter, not overnight.\n\n`;
  } else if (themes.timingProfile === 'developing-arc') {
    section += `Pace: Themes here describe an unfolding chapter—neither instant nor distant, but evolving as you work with them.\n\n`;
  }

  // Archetype level
  if (themes.archetypeDescription) {
    section += `${themes.archetypeDescription}\n\n`;
  }

  // Elemental balance with actionable remedies
  if (themes.elementalBalance) {
    section += `Elemental context: ${themes.elementalBalance}\n\n`;

    // Add elemental remedies if imbalanced
    if (shouldOfferElementalRemedies(themes.elementCounts, safeCards.length)) {
      const remedies = buildElementalRemedies(themes.elementCounts, safeCards.length, context, {
        rotationIndex
      });
      if (remedies) {
        section += `${remedies}\n\n`;
      }
    }
  }

  // Lifecycle stage
  if (themes.lifecycleStage) {
    section += `The cards speak to ${themes.lifecycleStage}.\n\n`;
  }

  // Actionable guidance
  const personalAnchor = userQuestion?.trim()
    ? 'Take the next small, intentional step that honors both your intuition and the practical realities at hand.'
    : 'Carry this insight gently into your next steps, allowing space for new awareness to bloom.';

  section += `${personalAnchor}\n\n`;

  // Free will reminder
  section += `Remember: These cards show a trajectory based on current patterns. Your awareness, choices, and actions shape what unfolds. You are co-creating this path.`;

  if (depthProfile?.synthesisReminder) {
    section += `\n\n${depthProfile.synthesisReminder}`;
  }

  return section;
}

/**
 * Append reversal reminder if spread contains reversed cards.
 */
function appendGenericReversalReminder(readingText, cardsInfo, themes) {
  if (!readingText) return readingText;

  const hasReversed = Array.isArray(cardsInfo) && cardsInfo.some(card =>
    (card?.orientation || '').toLowerCase() === 'reversed'
  );

  if (!hasReversed || !themes?.reversalDescription) {
    return readingText;
  }

  const lens = formatReversalLens(themes, { includeExamples: false, includeReminder: false });
  const guidanceLine = Array.isArray(lens.lines)
    ? lens.lines.find((line) => line.toLowerCase().includes('guidance'))
    : null;
  const reminderText = guidanceLine
    ? guidanceLine.replace(/^[-\s]*/, '').trim()
    : (themes.reversalDescription.guidance
      ? `Guidance: ${themes.reversalDescription.guidance}`
      : `Reversal lens: ${themes.reversalDescription.name}`);

  const reminder = `*Reversal lens reminder: ${reminderText}*`;
  if (readingText.includes(reminder)) {
    return readingText;
  }

  return `${readingText}\n\n${reminder}`;
}

/**
 * Generic enhanced reading builder (for spreads without specific builders).
 */
function buildGenericReading(
  { spreadInfo, cardsInfo, userQuestion, reflectionsText, themes, context },
  options = {}
) {
  const { collectValidation, personalization = null, reasoning = null } = options;
  const spreadName = spreadInfo?.name?.trim() || 'your chosen spread';
  const entries = [];
  const safeCards = Array.isArray(cardsInfo) ? cardsInfo : [];
  const remedyRotationIndex = computeRemedyRotationIndex({
    cardsInfo: safeCards,
    userQuestion,
    spreadInfo
  });
  const tone = getToneStyle(personalization?.readingTone);
  const depthProfile = getDepthProfile(personalization?.preferredSpreadDepth);

  // Use reasoning-aware opening if available
  const composedOpening = reasoning
    ? buildReasoningAwareOpening(spreadName, userQuestion, context, reasoning, { personalization })
    : buildOpening(spreadName, userQuestion, context, { personalization });
  const openingText = depthProfile?.openingPreface
    ? `${depthProfile.openingPreface}\n\n${composedOpening}`.trim()
    : composedOpening;

  entries.push({
    text: openingText,
    metadata: { type: 'opening', cards: safeCards.length > 0 ? [safeCards[0]] : [] }
  });

  // Cards section
  let cardsSection = buildCardsSection(safeCards, context, {
    detailLevel: depthProfile?.cardDetail,
    heading: depthProfile?.cardsHeading,
    note: depthProfile?.cardsNote
  });
  if (tone.challengeFraming) {
    cardsSection += `\n\nTreat any friction or challenge as a ${tone.challengeFraming}; the spread is highlighting choices, not fixed fate.`;
  }
  entries.push({
    text: cardsSection,
    metadata: { type: 'cards', cards: safeCards }
  });

  // Reflections
  if (reflectionsText && reflectionsText.trim()) {
    const reflectionsSection = buildReflectionsSection(reflectionsText);
    if (reflectionsSection) {
      entries.push({
        text: reflectionsSection,
        metadata: { type: 'reflections' }
      });
    }
  }

  // Use reasoning synthesis if available, otherwise fall back to enhanced synthesis
  const finalCard = safeCards.length > 0 ? safeCards[safeCards.length - 1] : null;
  const baseSynthesis = buildEnhancedSynthesis(safeCards, themes, userQuestion, context, {
    rotationIndex: remedyRotationIndex,
    depthProfile
  });
  const synthesisText = reasoning
    ? buildReasoningSynthesis(safeCards, reasoning, themes, userQuestion, context, {
      baseSynthesis
    })
    : baseSynthesis;
  entries.push({
    text: synthesisText,
    metadata: { type: 'synthesis', cards: finalCard ? [finalCard] : [] }
  });

  const enhancedSections = entries
    .map(({ text, metadata }) => {
      const result = enhanceSection(text, metadata || {});
      if (!result || !result.text) {
        return null;
      }
      const sectionRecord = {
        text: result.text,
        metadata: metadata || {},
        validation: result.validation || null
      };
      if (typeof collectValidation === 'function') {
        collectValidation(sectionRecord);
      }
      return sectionRecord;
    })
    .filter(Boolean);

  const readingBody = enhancedSections.map((section) => section.text).join('\n\n');
  const closing = buildPersonalizedClosing(personalization);
  const bodyWithClosing = closing ? `${readingBody}\n\n${closing}` : readingBody;
  return appendGenericReversalReminder(bodyWithClosing, safeCards, themes);
}

/**
 * Enhanced local composer with spread-specific narrative construction.
 *
 * @param {Object} payload - Reading payload
 * @returns {Promise<Object>} { reading, prompts, usage }
 */
export async function composeReadingEnhanced(payload, env = null) {
  const {
    spreadInfo,
    cardsInfo: rawCardsInfo,
    userQuestion,
    analysis,
    personalization = null,
    visionInsights = []
  } = payload;
  const { themes, spreadAnalysis, spreadKey } = analysis;
  // Resolve legacy facts before replacing their positions with stable roles.
  // Composition and usage must flatten the same copied card representation.
  const decisionPathContext = resolveDecisionPathContext({ spreadKey, cardsInfo: rawCardsInfo, decisionPaths: payload.decisionPaths });
  const decisionPaths = decisionPathContext.decisionPaths;
  const cardsInfo = spreadKey === 'decision' ? decisionPathRoleCards(rawCardsInfo) : rawCardsInfo;
  // The composer has no per-card reflection slot, so its reflections section
  // carries the general notes and every card's reflection together.
  const reflectionsText = collectQuerentReflections(payload.reflectionsText, cardsInfo);
  const languageSupport = getLocalComposerLanguageSupport({
    userQuestion,
    reflectionsText,
    decisionPaths
  });
  if (!languageSupport.supported) {
    const error = new Error(languageSupport.reason);
    error.code = LOCAL_COMPOSER_UNSUPPORTED_LANGUAGE_CODE;
    error.detectedLanguage = languageSupport.language;
    error.userFacingMessage = languageSupport.userFacingMessage;
    throw error;
  }
  const collectedSections = [];
  // The local composer currently renders no remembered notes. Never inherit a
  // discarded provider attempt's prompt retention.
  payload.memoryRetention = { retainedSlots: [], slotToId: {} };

  // A topic can be specific in the graph taxonomy (for example grief) while
  // its reading label remains general. Use the shared source decision instead
  // of the reading label to keep saved interests from steering any fallback.
  const contextSelection = payload.contextSelection ||= resolveContextSelection({
    userQuestion,
    reflectionsText: payload.reflectionsText,
    cardsInfo,
    decisionPaths,
    focusAreas: personalization?.focusAreas
  }, spreadKey);
  ensureReadingMemorySelection(payload);
  const hasCurrentTopic = contextSelection.source === 'question'
    || contextSelection.source === 'reflections'
    || contextSelection.source === 'decisionPaths';
  const composerPersonalization = personalization && hasCurrentTopic
    ? { ...personalization, focusAreas: [] }
    : personalization;

  const composerOptions = {
    decisionPaths,
    personalization: composerPersonalization,
    proseMode: true,
    collectValidation: (section) => {
      if (!section) return;
      collectedSections.push({
        text: section.text || '',
        metadata: section.metadata || {},
        validation: section.validation || null
      });
    }
  };

  const readingResult = await buildReadingWithReasoning(
    {
      spreadInfo,
      spreadKey,
      cardsInfo,
      userQuestion,
      reflectionsText,
      themes,
      context: contextSelection.context
    },
    async (enhancedPayload, reasoningOptions = {}) => {
      const mergedOptions = {
        ...composerOptions,
        ...reasoningOptions,
        reasoning: enhancedPayload.reasoning || reasoningOptions.reasoning || null
      };
      return generateReadingFromAnalysis(
        {
          spreadKey,
          spreadAnalysis,
          cardsInfo: enhancedPayload.cardsInfo,
          userQuestion: enhancedPayload.userQuestion,
          reflectionsText: enhancedPayload.reflectionsText,
          themes: enhancedPayload.themes,
          spreadInfo: enhancedPayload.spreadInfo,
          context: enhancedPayload.context
        },
        mergedOptions
      );
    },
    composerOptions
  );
  const readingText = typeof readingResult === 'string'
    ? readingResult
    : (readingResult?.reading || '');

  if (readingResult?.reasoning && typeof readingResult.reasoning === 'object') {
    payload.reasoningMeta = readingResult.reasoning;
  }

  payload.narrativeEnhancements = collectedSections;

  // Ensure promptMeta exists for telemetry
  payload.promptMeta = {
    backend: 'local-composer',
    contextSelection: sanitizeContextSelection(contextSelection),
    context: { provided: contextSelection.context, normalized: contextSelection.context, source: contextSelection.source, clarifiedBy: contextSelection.clarifiedBy },
    queryCoverage: sanitizeQueryCoverage(contextSelection.queryCoverage),
    estimatedTokens: null,
    slimmingSteps: []
  };

  // GraphRAG is generation context, not a user-visible postscript.
  // For local-composer parity, we track GraphRAG telemetry but do not append
  // raw passages to output unless debug mode is explicitly enabled.
  let finalReadingText = readingText;
  const graphRAGPayload = analysis.graphRAGPayload || payload.graphRAGPayload;
  const passagesProvided = graphRAGPayload?.passages?.length || 0;
  if (graphRAGPayload) {
    const retrievalSummary = graphRAGPayload.retrievalSummary || {};
    payload.promptMeta.graphRAG = {
      ...retrievalSummary,
      queryCoverage: payload.promptMeta.queryCoverage,
      contextSelection: payload.promptMeta.contextSelection,
      includedInPrompt: false,
      injectedIntoPrompt: false,
      passagesProvided,
      passagesUsedInPrompt: 0,
      retainedPassageCount: 0,
      selectedDeck: payload.deckStyle || spreadInfo?.deckStyle || themes?.deckStyle || 'rws-1909',
      sourceDecks: [...new Set((graphRAGPayload.passages || []).map(passage => passage.sourceDeck).filter(Boolean))],
      skippedReason: 'not_used_by_backend',
      disabledByEnv: retrievalSummary.disabledByEnv === true,
      parseStatus: 'absent',
      referenceBlockClosed: false,
      debugVisibleInOutput: false,
      visibleInOutput: false
    };
  }

  const debugAppendGraphRAG = shouldAppendGraphRAGDebugOutput(env);
  if (debugAppendGraphRAG && graphRAGPayload?.passages?.length > 0) {
    const formattedPassages = formatPassagesForPrompt(graphRAGPayload.passages, {
      includeSource: true,
      markdown: true,
      deckStyle: payload.deckStyle || spreadInfo?.deckStyle || themes?.deckStyle || 'rws-1909'
    });
    const debugPassagesRendered = (formattedPassages.match(/^\d+\. /gm) || []).length;
    if (formattedPassages && debugPassagesRendered) {
      finalReadingText = readingText + '\n\n## Traditional Wisdom\n\n' + formattedPassages;

      if (payload.promptMeta?.graphRAG) {
        payload.promptMeta.graphRAG = {
          ...payload.promptMeta.graphRAG,
          injectedIntoPrompt: false,
          debugVisibleInOutput: true,
          visibleInOutput: true,
          passagesUsedInPrompt: 0,
          debugPassagesRendered,
          parseStatus: 'absent',
          referenceBlockClosed: false,
          disabledByEnv: false,
          skippedReason: null
        };
      } else {
        payload.promptMeta.graphRAG = {
          ...(graphRAGPayload.retrievalSummary || {}),
          includedInPrompt: false,
          injectedIntoPrompt: false,
          passagesProvided,
          passagesUsedInPrompt: 0,
          debugPassagesRendered,
          retainedPassageCount: 0,
          disabledByEnv: false,
          skippedReason: null,
          parseStatus: 'absent',
          referenceBlockClosed: false,
          debugVisibleInOutput: true,
          visibleInOutput: true
        };
      }
    }
  }

  payload.promptMeta.memories = {
    candidateCount: payload.useSavedMemories === false ? 0 : payload.memorySelection?.candidateCount ?? payload.memories?.length ?? 0,
    selectedCount: payload.useSavedMemories === false ? 0 : payload.memorySelection?.selectedCount ?? payload.memories?.length ?? 0,
    retainedCount: 0,
    exclusionReasons: payload.memorySelection?.exclusionReasons || {}
  };

  payload.promptMeta.sourceUsage = buildLocalComposerSourceUsage(
    {
      ...payload,
      cardsInfo,
      decisionPaths,
      userContextInputStats: { ...decisionPathContext.inputStats, ...payload.userContextInputStats },
      visionInsights,
      personalization
    },
    payload.promptMeta,
    graphRAGPayload,
    { focusAreasSuppressed: hasCurrentTopic, renderedReading: readingText }
  );

  payload.promptMeta.sourceUsage.memories = buildMemorySourceUsage(payload.promptMeta.memories.candidateCount, payload.promptMeta.memories.selectedCount, 0, 'not_used_by_backend');
  if (payload.useSavedMemories === false) payload.promptMeta.sourceUsage.memories.skippedReason = 'disabled_by_request';

  // Return reading with null prompts (local composer doesn't use LLM prompts)
  return {
    reading: finalReadingText,
    prompts: null,
    usage: null,
    promptMeta: payload.promptMeta
  };
}

// ============================================================================
// Backend Dispatch
// ============================================================================

/**
 * Run a specific narrative backend.
 *
 * @param {string} backendId - Backend identifier
 * @param {Object} env - Environment bindings
 * @param {Object} payload - Reading payload
 * @param {string} requestId - Request ID for logging
 * @returns {Promise<Object>} { reading, prompts, usage }
 */
export async function runNarrativeBackend(backendId, env, payload, requestId) {
  const personalProvider = getPersonalTextProvider(env);
  if (personalProvider && ![personalProvider, 'local-composer'].includes(backendId)) {
    throw new Error('Other narrative backends are disabled in personal subscription mode.');
  }
  if (['claude-code', 'codex-subscription'].includes(backendId) && backendId !== personalProvider) {
    throw new Error('The requested personal subscription mode is not selected.');
  }
  return withSpan(`tarot.narrative.${backendId}`, {
    'tarot.request_id': requestId,
    'tarot.narrative.backend': backendId,
    'tarot.spread': payload?.analysis?.spreadKey || 'unknown',
  }, async (span) => {
    let result;
    switch (backendId) {
      case 'claude-code':
      case 'codex-subscription': {
        const { systemPrompt, userPrompt, promptMeta } = buildOpenAIResponsesPrompts(env, payload, requestId, {
          backendId, providerLabel: NARRATIVE_BACKENDS[backendId].label,
          budgetTarget: backendId === 'claude-code' ? 'claude' : 'openai'
        });
        const completion = await callPersonalTextProvider(env, {
          task: 'reading', systemPrompt, messages: [{ role: 'user', content: userPrompt }], signal: payload.signal
        });
        const modelProvenance = completion.modelSource ? { modelSource: completion.modelSource } : {};
        promptMeta.inference = { provider: backendId, model: completion.model, ...modelProvenance };
        result = { reading: completion.text, prompts: { system: systemPrompt, user: userPrompt },
          promptMeta, usage: completion.usage, model: completion.model, ...modelProvenance, reasoningSummary: null };
        break;
      }
      case 'claude-api':
        result = await generateWithClaudeApi(env, payload, requestId);
        break;
      case 'modal-qwen':
        result = await generateWithModalQwen(env, payload, requestId);
        break;
      case 'openai-native':
        result = await generateWithOpenAIResponses(env, payload, requestId);
        break;
      case 'local-composer':
      default:
        result = await composeReadingEnhanced(payload, env);
        break;
    }
    const reading = typeof result === 'object' && result.reading ? result.reading : result;
    if (span) {
      span.setAttribute('tarot.narrative.length', typeof reading === 'string' ? reading.length : 0);
    }
    return result;
  });
}

