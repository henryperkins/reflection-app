import { z } from 'zod';
import { ModelCandidate, ModelUnit, type PreparedPlan } from '../../contracts/index.ts';
import type { ReadingProviderPolicy } from '../../contracts/provider-policy.ts';
import { renderFacts, type RenderedFact } from './facts.ts';
import { validateCandidateBindings, validatePlanIntegrity } from './plan.ts';
export type PreparedTemplate = {
  label: 'Prepared reflection template';
  question: string;
  facts: RenderedFact[];
  units: Array<{
    position: 'situation' | 'tension' | 'possibility';
    basisText: string;
    factIds: string[];
    sourceIds: string[];
    interpretation: string;
    reflectionQuestion: string;
  }>;
  closing: string;
};
export async function composeTemplate(value: PreparedPlan): Promise<PreparedTemplate> {
  const plan = await validatePlanIntegrity(value);
  const facts = renderFacts(plan.basis);
  const units = plan.basis.cards.map((card, i) => ({
    position: card.position,
    basisText: facts[i]!.text,
    factIds: [card.id],
    sourceIds: [plan.sources[i]!.id],
    interpretation: plan.sources[i]!.fallbackText,
    reflectionQuestion: plan.sources[i]!.reflectionQuestion,
  }));
  const closing =
    plan.fallbackClosing ??
    (plan.operation === 'followup'
      ? 'This provides another reflection prompt based on the original draw.'
      : 'Use these prompts to reflect on what feels relevant to you.');
  validateCandidateBindings(plan, {
    schemaVersion: 1,
    kind: 'tarot.interpretation.v1',
    units: units.map(({ basisText: _basisText, ...unit }) => unit),
    closing,
  });
  return { label: 'Prepared reflection template', question: plan.question, facts, units, closing };
}
/** Closed allowlist projection. It deliberately never serializes a plan/source/fragment wholesale. */
export async function projectWriterPayload(
  value: PreparedPlan,
  policy: ReadingProviderPolicy,
): Promise<Uint8Array> {
  const plan = await validatePlanIntegrity(value);
  const sourceIds = plan.sources.map((s) => s.id) as [string, ...string[]];
  const schema = z.toJSONSchema(
    ModelCandidate.extend({
      units: z
        .array(ModelUnit.extend({ sourceIds: z.array(z.enum(sourceIds)).length(1) }))
        .length(3),
    }),
  );
  const data = {
    facts: renderFacts(plan.basis),
    positions: plan.basis.cards.map((card, i) => ({
      position: card.position,
      factId: card.id,
      sourceId: plan.sources[i]!.id,
    })),
    sources: plan.sources.map((source, i) => ({
      id: source.id,
      factId: plan.basis.cards[i]!.id,
      text: source.text,
    })),
    question: plan.question,
    selected: plan.selected.map((fragment) => ({
      label: `selection:${fragment.ordinal}`,
      authorship: fragment.authorship,
      text: fragment.text,
    })),
  };
  const body = {
    model: policy.model,
    ...policy.request,
    input: [
      { role: 'system', content: policy.prompt.system },
      { role: 'developer', content: policy.prompt.developer },
      { role: 'user', content: JSON.stringify(data) },
    ],
    text: { format: { type: 'json_schema', name: 'tarot_interpretation', strict: true, schema } },
  };
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  // utf8-byte-upper-bound.v1: one token per UTF-8 byte plus 256 framing tokens.
  // Deliberately conservative local baseline; live model tokenizer/usage qualification is outside M1.
  if (
    bytes.length > policy.estimator.maxPayloadBytes ||
    bytes.length + policy.estimator.framingTokens > policy.estimator.maxInputTokens
  )
    throw new Error('INPUT_TOO_LARGE: writer payload; shorten question or selected context');
  return bytes;
}
