import type { z } from 'zod';
import {
  type AnyPreparedPlan,
  ModelCandidate,
  type AnyContentBundle,
  type WriterReceiptV2,
} from '../../contracts/index.ts';
import {
  READING_PROVIDER_POLICY,
  READING_V2_EVALUATION_POLICY,
} from '../../contracts/provider-policy.ts';
import { buildPlan, type BuildPlanInput, validatePlanIntegrity } from '../../domain/tarot/plan.ts';
import { buildPlanV2, validatePlanV2 } from '../../domain/tarot/context-v2.ts';
import { composeTemplate, projectWriterPayload } from '../../domain/tarot/render.ts';
import {
  composeTemplateV2,
  prepareWriterV2,
  writerIdentitiesV2,
} from '../../domain/tarot/writer-v2.ts';
import { validateCandidate } from '../../domain/tarot/safety.ts';
import { validateCandidateV2 } from '../../domain/tarot/safety-v2.ts';

export type VersionedPlan = z.infer<typeof AnyPreparedPlan>;
export function planPolicy(plan: VersionedPlan) {
  return plan.version === 'tarot-plan.v2' ? READING_V2_EVALUATION_POLICY : READING_PROVIDER_POLICY;
}
export async function buildLocalPlan(
  input: Omit<BuildPlanInput, 'content'> & { content: z.infer<typeof AnyContentBundle> },
) {
  if (input.content.schemaVersion === 1) return buildPlan({ ...input, content: input.content });
  const identities = await writerIdentitiesV2();
  return buildPlanV2(
    {
      ...input,
      content: input.content,
      promptHash: identities.promptHash,
      validatorHash: identities.validatorHash,
    },
    true,
  );
}
export function validateLocalPlan(plan: VersionedPlan) {
  return plan.version === 'tarot-plan.v2' ? validatePlanV2(plan) : validatePlanIntegrity(plan);
}
export async function prepareLocalWriter(
  plan: VersionedPlan,
): Promise<{ payload: Uint8Array; receipt: WriterReceiptV2 | null }> {
  return plan.version === 'tarot-plan.v2'
    ? prepareWriterV2(plan)
    : { payload: await projectWriterPayload(plan, READING_PROVIDER_POLICY), receipt: null };
}
export async function localTemplate(plan: VersionedPlan) {
  if (plan.version === 'tarot-plan.v2') return composeTemplateV2(plan);
  const body = await composeTemplate(plan);
  return ModelCandidate.parse({
    schemaVersion: 1,
    kind: 'tarot.interpretation.v1',
    units: body.units.map(({ basisText: _text, ...unit }) => unit),
    closing: body.closing,
  });
}
export async function checkLocalCandidate(
  plan: VersionedPlan,
  candidate: unknown,
  receipt: WriterReceiptV2 | null,
  template = false,
) {
  return plan.version === 'tarot-plan.v2'
    ? validateCandidateV2(plan, candidate, receipt, template)
    : validateCandidate(plan, candidate, template);
}
