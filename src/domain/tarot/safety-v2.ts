import { z } from 'zod';
import {
  ModelCandidateV2,
  Position,
  WriterReceiptV2,
  type PreparedPlanV2,
} from '../../contracts/index.ts';
import { canonicalJson, sha256Json } from '../json.ts';
import { validatePlanV2 } from './context-v2.ts';
import { candidateSchemaV2 } from './writer-v2.ts';
import { boundedCandidateJson, CandidateRejection, screenProse } from './safety.ts';

export const SAFETY_V2_VERSION = 'bounded-developed-reading.v2.1';
const reject = (code: ConstructorParameters<typeof CandidateRejection>[0]): never => {
  throw new CandidateRejection(code);
};
const normalize = (s: string) =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/\bi'm\b/g, 'i am')
    .replace(/\bi've\b/g, 'i have')
    .replace(/\byou're\b/g, 'you are')
    .replace(/\byou've\b/g, 'you have')
    .replace(/\baren't\b/g, 'are not')
    .replace(/\bwasn't\b/g, 'was not')
    .replace(/\bweren't\b/g, 'were not');
const personal =
  /\b(?:you (?:are|were|have been|have always|had|suffer|suffered)|your (?:partner|family|parent|child|boss|friend) (?:is|was|has|caused))\b/g;
const escapePattern = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Narrow, deterministic evidence match: entire declarative statements, never extracted keywords. */
function supportedProse(text: string, question: string) {
  const quotations: Array<{ token: string; text: string }> = [];
  const protectedText = text.replace(
    /\bYou (?:wrote|said),?\s*[“"]([^”"]+)[”"]/gi,
    (whole, quote: string) => {
      if (!question.includes(quote)) reject('BIOGRAPHY_UNSUPPORTED');
      let token = `attributedquotetoken${quotations.length}`;
      while (text.toLowerCase().includes(token)) token += 'x';
      quotations.push({ token, text: whole });
      return token;
    },
  );
  let result = normalize(protectedText);
  const sentences = [...normalize(question).matchAll(/([^.!?]+)([.!?]|$)/g)]
    .filter((m) => m[2] !== '?' && !/["“”]/.test(m[1]!))
    .map((m) => m[1]!.trim());
  // Split only explicitly asserted first-person coordination. A conditional or reported
  // sentence is never a pool of free-standing facts, even after an "and".
  const scoped =
    /\b(?:if|unless|when|whether|suppose|supposing|imagining|imagine|might|could|would|think|believe|wonder|says?|said|claims?|told|asked)\b|not sure/;
  const statements = sentences.flatMap((s) =>
    /^(?:i|my)\b/.test(s) && !scoped.test(s)
      ? [
          s,
          ...s
            .split(/(?:,\s*)?\band\s+(?=i (?:am|was|have been|have always|had|suffer|suffered)\b)/)
            .slice(1),
        ]
      : [s],
  );
  for (const source of statements) {
    if (
      !/^(?:i (?:am|was|have been|have always|had|suffer|suffered)|my (?:partner|family|parent|child|boss|friend) (?:is|was|has|caused))\b/.test(
        source,
      )
    )
      continue;
    const statement = source
      .replace(/\bi was\b/g, 'you were')
      .replace(/\bi am\b/g, 'you are')
      .replace(/\bi\b/g, 'you')
      .replace(/\bmy\b/g, 'your')
      .replace(/\bmyself\b/g, 'yourself');
    // A full matched statement retains its negation, temporal qualifiers and attribution.
    const pattern = new RegExp(
      `(^|[.!?;]\\s*|\\b(?:since|because|given that)\\s+)${escapePattern(statement)}(?=[.!?,;:]|$)`,
      'g',
    );
    result = result.replace(
      pattern,
      (_whole, prefix: string) =>
        prefix + statement.replace(personal, 'the supplied current statement describes'),
    );
  }
  // This possessive idiom refers back to an explicitly supplied imagined image;
  // it does not authorize other "you had" biography or invented past events.
  if (
    sentences.some((s) => /^i\b/.test(s) && !scoped.test(s) && /\bwhat i imagined(?=,|$)/.test(s))
  )
    result = result.replace(
      /\bthe image you had in mind\b/g,
      'the reader-described imagined image',
    );
  // Only the locally introduced hypothetical claim is exempt, not subsequent clauses.
  result = result.replace(
    /\b(if|whether)\s+(you (?:are|were|have been|had)|your (?:partner|family|parent|child|boss|friend) (?:is|was|has))\b/g,
    '$1 a possible circumstance involves',
  );
  for (const quote of quotations) result = result.replace(quote.token, quote.text);
  return result;
}
export async function validateCandidateV2(
  value: PreparedPlanV2,
  candidate: unknown,
  received: WriterReceiptV2 | null,
  template = false,
): Promise<ModelCandidateV2> {
  const plan = await validatePlanV2(value);
  if (
    plan.validatorHash !==
    (await sha256Json({
      version: SAFETY_V2_VERSION,
      outputSchema: z.toJSONSchema(ModelCandidateV2),
    }))
  )
    reject('CONTENT_CHANGED');
  boundedCandidateJson(candidate);
  const parsed = ModelCandidateV2.safeParse(candidate);
  if (!parsed.success) reject('SCHEMA');
  const output = parsed.data!,
    sourceIds = new Set(plan.sources.map((s) => s.id));
  let relationshipIds: string[] = [];
  if (received) {
    const parsedReceipt = WriterReceiptV2.safeParse(received);
    if (!parsedReceipt.success) reject('SCHEMA');
    const receipt = parsedReceipt.data!;
    if (
      receipt.contextHash !== plan.contextHash ||
      receipt.contentHash !== plan.contentHash ||
      receipt.deckEdition !== plan.basis.deckEdition ||
      receipt.spreadVersion !== plan.spread.version ||
      receipt.promptHash !== plan.promptHash ||
      receipt.validatorHash !== plan.validatorHash ||
      canonicalJson(receipt.sources) !==
        canonicalJson(plan.sources.map((s) => ({ id: s.id, version: s.version, hash: s.hash })))
    )
      reject('CONTENT_CHANGED');
    relationshipIds = receipt.relationships.map((r) => r.id);
    if (
      new Set(relationshipIds).size !== relationshipIds.length ||
      receipt.relationships.some(
        (r) =>
          !plan.relationships.some(
            (p) => p.id === r.id && p.hash === r.hash && p.version === r.version,
          ),
      ) ||
      receipt.schemaHash !== (await sha256Json(candidateSchemaV2(plan, relationshipIds)))
    )
      reject('RELATIONSHIP_UNSUPPORTED');
  } else if (!template) reject('CONTENT_CHANGED');
  const positions = new Set<string>();
  for (const unit of output.units) {
    const index = Position.options.indexOf(unit.position),
      card = plan.basis.cards[index]!,
      source = plan.sources[index]!;
    if (
      positions.has(unit.position) ||
      unit.sourceIds[0] !== source.id ||
      new Set(unit.factIds).size !== unit.factIds.length ||
      unit.factIds.filter((id) => id === card.id).length !== 1 ||
      unit.factIds.some((id) => id !== card.id && id !== `count:${card.cardId.split('-')[0]}`)
    )
      reject('POSITION_BINDING');
    positions.add(unit.position);
  }
  const attributed = [
    ...output.units,
    output.synthesis,
    output.action,
    ...(output.reflectionQuestion ? [output.reflectionQuestion] : []),
  ];
  for (const part of attributed)
    if (
      new Set(part.sourceIds).size !== part.sourceIds.length ||
      part.sourceIds.some((id) => !sourceIds.has(id))
    )
      reject('ENTITY_NOT_SUPPLIED');
  if (
    new Set(output.synthesis.relationshipIds).size !== output.synthesis.relationshipIds.length ||
    output.synthesis.relationshipIds.some(
      (id) =>
        !relationshipIds.includes(id) ||
        plan.relationships
          .find((r) => r.id === id)!
          .sourceIds.some((source) => !output.synthesis.sourceIds.includes(source)),
    )
  )
    reject('RELATIONSHIP_UNSUPPORTED');
  const fields = [
    ...output.units.map((u) => u.interpretation),
    output.synthesis.text,
    output.action.text,
    ...(output.reflectionQuestion ? [output.reflectionQuestion.text] : []),
  ];
  const sentences = new Set<string>();
  for (const field of fields) {
    screenProse(supportedProse(field, plan.question), plan);
    for (const sentence of field.split(/[.!?]+/u)) {
      const key = normalize(sentence)
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
      if (!key) continue;
      if (!template && sentences.has(key)) reject('REPETITION');
      sentences.add(key);
    }
  }
  return output;
}
