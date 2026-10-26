import {
  ModelCandidate,
  type PreparedPlan,
  type ErrorCode,
  type Rejection,
} from '../../contracts/index.ts';
import { validateCandidateBindings } from './plan.ts';

/** Versioned local screening, not a semantic entailment proof or a clinical classifier. */
export const SAFETY_VERSION = 'bounded-english-reflection.v1';
export class CandidateRejection extends Error {
  constructor(readonly code: typeof Rejection._output) {
    super(`INVALID_CANDIDATE: ${code}`);
  }
}
const reject = (code: typeof Rejection._output): never => {
  throw new CandidateRejection(code);
};
const normalized = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[’]/g, "'");
const nonEnglish = (text: string) =>
  /\p{L}/u.test(text) &&
  (/[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u.test(text) ||
    /\b(je|dois|comprendre|pourquoi|quiero|cómo|porque|necesito|warum|möchte|nicht|perché)\b/u.test(
      normalized(text),
    ));
const crisis =
  /\b(?:i\s+(?:(?:want|plan|intend)\s+to|will|am going to)\s+(?:kill|hurt|harm)\s+myself|(?:end|take)\s+my\s+life|suicid(?:e|al)|self[ -]harm)\b/;
const medical =
  /\b(?:medication|medicine|diagnos(?:e|is)|dosage|medical treatment|treatment (?:for|of) (?:cancer|diabetes|depression|anxiety|disease)|prescription|insulin|antidepressants?)\b/;
const financial =
  /\b(?:buy|sell|invest|borrow|trade)\b.{0,80}\b(?:stocks?|shares?|crypto|bitcoin|funds?|loans?)\b/;
const legal =
  /\b(?:legal advice|(?:should i|can i|how (?:can|do) i|must i|you should) sue|plead guilty|plead innocent|evade taxes|sign (?:this|the) contract)\b/;
export function inputAdmission(question: string, languageConfirmed: unknown): ErrorCode | null {
  if (typeof question !== 'string' || !question.trim()) return 'BAD_INPUT';
  if (question.length > 500) return 'INPUT_TOO_LARGE';
  if (languageConfirmed !== 'en' || nonEnglish(question)) return 'UNSUPPORTED_LANGUAGE';
  const text = normalized(question);
  if (crisis.test(text) || medical.test(text) || financial.test(text) || legal.test(text))
    return 'SAFETY_REVIEW';
  return null;
}

/** Check structural work bounds before stringify/parse or an untrusted adapter can recurse. */
export function boundedCandidateJson(value: unknown): string {
  const pending = [{ value, depth: 0 }],
    seen = new Set<object>();
  let nodes = 0,
    textBytes = 0;
  while (pending.length) {
    const next = pending.pop()!;
    if (++nodes > 4000 || next.depth > 12) reject('LENGTH');
    if (typeof next.value === 'string') {
      textBytes += new TextEncoder().encode(next.value).length;
      if (textBytes > 65536) reject('LENGTH');
    } else if (next.value !== null && typeof next.value === 'object') {
      if (seen.has(next.value)) reject('SCHEMA');
      seen.add(next.value);
      for (const [key, child] of Object.entries(next.value)) {
        textBytes += key.length;
        pending.push({ value: child, depth: next.depth + 1 });
      }
    } else if (next.value !== null && !['boolean', 'number'].includes(typeof next.value))
      reject('SCHEMA');
  }
  const json = JSON.stringify(value);
  if (typeof json !== 'string' || new TextEncoder().encode(json).length > 65536) reject('LENGTH');
  return json;
}
const technical =
  /\b(?:major-\d{2}|(?:wands|cups|swords|pentacles)-\d{2}|(?:ace|two|three|four|five|six|seven|eight|nine|ten|page|knight|queen|king) of (?:wands|cups|swords|pentacles)|the (?:fool|magician|high priestess|empress|emperor|hierophant|lovers|chariot|hermit|wheel of fortune|hanged man|devil|tower|star|moon|sun|world)|upright|reversed|(?:situation|tension|possibility) (?:card|position)|(?:\d+|one|two|three) (?:wands|cups|swords|pentacles)|astrolog(?:y|ical)|ascendant|transit|retrograde)\b/i;
const biography =
  /\b(?:you (?:are|were|have been|have always|had|suffer|suffered)|your (?:partner|family|parent|child|boss|friend) (?:is|was|has|caused))\b/;
const future =
  /\b(?:you(?:'ll| will| are going to)|will (?:happen|receive|be offered|become|meet|return)|destined|guaranteed|tomorrow|next (?:week|month|year))\b/;
const causal = /\b(?:prove[sd]?|caused|causes|guarantees|certainly|definitely)\b/;
// A direct legal instruction is distinct from referring to a person named Sue.
const legalDirective =
  /(?:^|[,;:]|\b(?:then|and|please|must|should|need to|ought to))\s*sue\s+(?:your|the|a|an|him|her|them|someone|anyone)\b/;
const imperative =
  /\b(?:stop|start|take|increase|decrease|change|ignore|avoid|must|should|need to)\b/;
function prose(text: string, plan: PreparedPlan) {
  if (!text.trim()) reject('LENGTH');
  if (/\{\{|\}\}|<[^>]*>|https?:\/\/|www\.|\[[^\]]*\]\(|```|\[\[(?:[^\]]*)\]\]/i.test(text))
    reject('PROMPT_INJECTION');
  if (nonEnglish(text)) reject('LANGUAGE');
  // Only exact, explicitly attributed text supplied in this request can be quoted.
  const supplied = [plan.question, ...plan.selected.map((s) => s.text ?? '')];
  let unquoted = text.replace(
    /\bYou (?:wrote|said),?\s*[“"]([^”"]+)[”"]/gi,
    (_whole, quote: string) => {
      if (!supplied.some((source) => source.includes(quote))) reject('BIOGRAPHY_UNSUPPORTED');
      return 'An attributed user quotation';
    },
  );
  unquoted = normalized(unquoted);
  if (technical.test(unquoted)) reject('TECHNICAL_PROSE');
  const clauses = unquoted.split(/[.!?;]|\bbut\b|\bhowever\b/).filter((s) => s.trim());
  if (clauses.length > 100) reject('LENGTH');
  for (const clause of clauses) {
    if (
      (medical.test(clause) && imperative.test(clause)) ||
      financial.test(clause) ||
      legal.test(clause) ||
      legalDirective.test(clause)
    )
      reject('SENSITIVE_ADVICE');
    if (biography.test(clause)) reject('BIOGRAPHY_UNSUPPORTED');
    // Explicit negation scopes to its clause; a later positive claim is still checked.
    const disclaimer =
      /\b(?:not evidence that|does not (?:mean|prove)|cannot (?:predict|prove))\b/.test(clause);
    if (future.test(clause) && !disclaimer) reject('PREDICTION');
    if (causal.test(clause) && !disclaimer) reject('RELATIONSHIP_UNSUPPORTED');
  }
}
export function validateCandidate(plan: PreparedPlan, value: unknown, template = false) {
  boundedCandidateJson(value);
  const parsed = ModelCandidate.safeParse(value);
  if (!parsed.success) throw new CandidateRejection('SCHEMA');
  validateCandidateBindings(plan, parsed.data);
  const fields = parsed.data.units.flatMap((unit) => [
    unit.interpretation,
    unit.reflectionQuestion,
  ]);
  if (parsed.data.closing) fields.push(parsed.data.closing);
  const all = fields.join(' ');
  if (all.split(/\s+/u).length > 4000) reject('LENGTH');
  const sentences = new Set<string>();
  for (const field of fields) {
    prose(field, plan);
    for (const sentence of field.split(/[.!?]+/u)) {
      const key = normalized(sentence)
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
      if (!key) continue;
      if (!template && sentences.has(key)) reject('REPETITION');
      sentences.add(key);
    }
  }
  return parsed.data;
}
