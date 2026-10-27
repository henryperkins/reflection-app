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
  type ReadingProviderPolicy,
  type ReadingV2WriterPolicy,
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
export async function buildWriterPlan(
  input: Omit<BuildPlanInput, 'content'> & { content: z.infer<typeof AnyContentBundle> },
  policy: ReadingV2WriterPolicy | ReadingProviderPolicy = READING_V2_EVALUATION_POLICY,
  diagnosticOnly = true,
) {
  if (input.content.schemaVersion === 1) return buildPlan({ ...input, content: input.content });
  if (policy.schemaVersion !== 'tarot.interpretation.v2') throw new Error('POLICY_MISMATCH');
  const identities = await writerIdentitiesV2(policy);
  return buildPlanV2(
    {
      ...input,
      content: input.content,
      promptHash: identities.promptHash,
      validatorHash: identities.validatorHash,
    },
    diagnosticOnly,
  );
}
export function validateWriterPlan(plan: VersionedPlan) {
  return plan.version === 'tarot-plan.v2' ? validatePlanV2(plan) : validatePlanIntegrity(plan);
}
export async function prepareWriter(
  plan: VersionedPlan,
  policy: ReadingV2WriterPolicy | ReadingProviderPolicy = planPolicy(plan),
): Promise<{ payload: Uint8Array; receipt: WriterReceiptV2 | null }> {
  if (plan.version === 'tarot-plan.v2' && policy.schemaVersion !== 'tarot.interpretation.v2')
    throw new Error('POLICY_MISMATCH');
  return plan.version === 'tarot-plan.v2' && policy.schemaVersion === 'tarot.interpretation.v2'
    ? prepareWriterV2(plan, policy)
    : {
        payload: await projectWriterPayload(
          plan as Extract<VersionedPlan, { version: 'tarot-plan.v1' }>,
          policy,
        ),
        receipt: null,
      };
}
export async function preparedTemplate(plan: VersionedPlan) {
  if (plan.version === 'tarot-plan.v2') return composeTemplateV2(plan);
  const body = await composeTemplate(plan);
  return ModelCandidate.parse({
    schemaVersion: 1,
    kind: 'tarot.interpretation.v1',
    units: body.units.map(({ basisText: _text, ...unit }) => unit),
    closing: body.closing,
  });
}
export async function checkWriterCandidate(
  plan: VersionedPlan,
  candidate: unknown,
  receipt: WriterReceiptV2 | null,
  template = false,
) {
  return plan.version === 'tarot-plan.v2'
    ? validateCandidateV2(plan, candidate, receipt, template)
    : validateCandidate(plan, candidate, template);
}
