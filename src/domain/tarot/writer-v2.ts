import { z } from 'zod';
import {
  ModelCandidateV2,
  ModelUnitV2,
  ReferencedText,
  WriterReceiptV2,
  type PreparedPlanV2,
} from '../../contracts/index.ts';
import { READING_V2_EVALUATION_POLICY } from '../../contracts/provider-policy.ts';
import { sha256Bytes, sha256Json } from '../json.ts';
import { providerPolicyHash } from '../provider-policy.ts';
import { validatePlanV2 } from './context-v2.ts';
import { renderFacts } from './facts.ts';

export async function writerIdentitiesV2(policy = READING_V2_EVALUATION_POLICY) {
  return {
    promptHash: await sha256Json(policy.prompt),
    validatorHash: await sha256Json({
      version: policy.validatorVersion,
      outputSchema: z.toJSONSchema(ModelCandidateV2),
    }),
    generationPolicyHash: await providerPolicyHash(policy),
  };
}
export function candidateSchemaV2(plan: PreparedPlanV2, relationshipIds: string[]) {
  const ids = plan.sources.map((s) => s.id) as [string, ...string[]];
  const refs = z.array(z.enum(ids)).min(1).max(3);
  const relationshipRefs = relationshipIds.length
    ? z.array(z.enum(relationshipIds as [string, ...string[]])).max(2)
    : z.array(z.string()).max(0);
  return z.toJSONSchema(
    ModelCandidateV2.extend({
      units: z.array(ModelUnitV2.extend({ sourceIds: refs.length(1) })).length(3),
      synthesis: ModelCandidateV2.shape.synthesis.extend({
        sourceIds: refs.min(2),
        relationshipIds: relationshipRefs,
      }),
      action: ReferencedText.extend({ sourceIds: refs, text: z.string().min(1).max(500) }),
      reflectionQuestion: ReferencedText.extend({
        sourceIds: refs,
        text: z.string().min(1).max(200),
      }).nullable(),
    }),
  );
}
/** Allowlisted projection; the full editorial record and receipt never enter model input. */
export async function prepareWriterV2(
  value: PreparedPlanV2,
  policy = READING_V2_EVALUATION_POLICY,
): Promise<{ payload: Uint8Array; receipt: WriterReceiptV2 }> {
  const plan = await validatePlanV2(value),
    identities = await writerIdentitiesV2(policy);
  if (
    plan.promptHash !== identities.promptHash ||
    plan.validatorHash !== identities.validatorHash ||
    (plan.diagnosticOnly && !policy.evaluationOnly)
  )
    throw new Error('POLICY_MISMATCH: v2 writer identity');
  const data = {
    reader: { id: plan.reader.id, text: plan.reader.text },
    draw: plan.draw.map((c) => ({ ...c })),
    facts: renderFacts(plan.basis),
    spread: {
      version: plan.spread.version,
      positions: plan.spread.positions.map((p) => ({ position: p.position, text: p.text })),
    },
    meanings: plan.sources.map((s, i) => ({
      sourceId: s.id,
      version: s.version,
      factId: plan.basis.cards[i]!.id,
      cardId: s.cardId,
      orientation: s.orientation,
      position: plan.basis.cards[i]!.position,
      core: s.meaning.core,
      distinctions: [...s.meaning.distinctions],
      positive: s.meaning.positive,
      limits: [...s.meaning.limits],
      imagery: s.meaning.imagery
        ? { text: s.meaning.imagery.text, reference: s.meaning.imagery.reference }
        : null,
      attribution: s.rights.attribution,
    })),
    relationships: plan.relationships.map((r) => ({
      id: r.id,
      version: r.version,
      sourceIds: [...r.sourceIds],
      conditions: {
        deckEdition: r.deckEdition,
        cards: r.cards.map((c) => ({ cardId: c.cardId, orientations: [...c.orientations] })),
        themes: [...r.themes],
      },
      text: r.text,
      limits: r.limits,
      attribution: r.rights.attribution,
    })),
    selected: [],
    preferences: {
      language: 'en',
      style: 'concise-developed',
      targetWords: { minimum: 220, maximum: 320 },
    },
  };
  const omissions: WriterReceiptV2['omissions'] = [];
  for (;;) {
    const schema = candidateSchemaV2(
      plan,
      data.relationships.map((r) => r.id),
    );
    const payload = new TextEncoder().encode(
      JSON.stringify({
        model: policy.model,
        ...policy.request,
        input: [
          { role: 'system', content: policy.prompt.system },
          { role: 'developer', content: policy.prompt.developer },
          { role: 'user', content: JSON.stringify(data) },
        ],
        text: {
          format: { type: 'json_schema', name: 'tarot_interpretation', strict: true, schema },
        },
      }),
    );
    const estimatedInputTokens = payload.length + policy.estimator.framingTokens;
    if (
      payload.length <= policy.estimator.maxPayloadBytes &&
      estimatedInputTokens <= policy.estimator.maxInputTokens
    ) {
      return {
        payload,
        receipt: WriterReceiptV2.parse({
          version: 'writer-packet.v2',
          diagnosticOnly: plan.diagnosticOnly,
          contextHash: plan.contextHash,
          contentHash: plan.contentHash,
          deckEdition: plan.basis.deckEdition,
          spreadVersion: plan.spread.version,
          sources: plan.sources.map((s) => ({ id: s.id, version: s.version, hash: s.hash })),
          relationships: plan.relationships
            .filter((r) => data.relationships.some((s) => s.id === r.id))
            .map((r) => ({ id: r.id, version: r.version, hash: r.hash })),
          omissions,
          promptHash: identities.promptHash,
          schemaHash: await sha256Json(schema),
          validatorHash: identities.validatorHash,
          policyHash: identities.generationPolicyHash,
          transmissionHash: await sha256Bytes(payload),
          estimatedInputTokens,
          payloadBytes: payload.length,
        }),
      };
    }
    const relationship = data.relationships.pop();
    if (relationship) {
      omissions.push({ kind: 'relationship', id: relationship.id });
      continue;
    }
    const imagery = [...data.meanings].reverse().find((m) => m.imagery !== null);
    if (imagery) {
      imagery.imagery = null;
      omissions.push({ kind: 'imagery', id: imagery.sourceId });
      continue;
    }
    throw new Error('INPUT_TOO_LARGE: required v2 writer context');
  }
}
export async function composeTemplateV2(value: PreparedPlanV2): Promise<ModelCandidateV2> {
  const plan = await validatePlanV2(value),
    contextRefs = ['reader:question'] as const;
  const refs = { sourceIds: plan.sources.map((s) => s.id), contextRefs: [...contextRefs] };
  return ModelCandidateV2.parse({
    schemaVersion: 2,
    kind: 'tarot.interpretation.v2',
    units: plan.basis.cards.map((c, i) => ({
      position: c.position,
      factIds: [c.id],
      sourceIds: [plan.sources[i]!.id],
      contextRefs: [...contextRefs],
      interpretation: plan.sources[i]!.fallbackText,
    })),
    synthesis: { ...refs, relationshipIds: [], text: plan.fallbackV2.synthesis },
    action: { ...refs, text: plan.fallbackV2.action },
    reflectionQuestion: plan.fallbackV2.question
      ? { ...refs, text: plan.fallbackV2.question }
      : null,
  });
}
