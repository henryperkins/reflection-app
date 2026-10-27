import { createHash } from 'node:crypto';
import { canonicalJson } from '../src/domain/json.ts';
import { providerPolicyHash } from '../src/domain/provider-policy.ts';
import { drawTarot } from '../src/domain/tarot/draw.ts';
import { buildPlanV2 } from '../src/domain/tarot/context-v2.ts';
import { prepareWriterV2, writerIdentitiesV2 } from '../src/domain/tarot/writer-v2.ts';
import { inputAdmission } from '../src/domain/tarot/safety.ts';
import { localDevelopmentBundle } from '../src/worker/readings/local-content.ts';
import { READING_V2_EVALUATION_POLICY } from '../src/contracts/provider-policy.ts';
import type {
  PreparedEvaluation,
  EvaluationManifest,
  EvaluationRequest,
} from './provider-evaluation-corpus.ts';
const hash = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex');

/** New combined product experiment. No production content, history, or retry authorization. */
export async function prepareReadingV2(
  contexts: readonly { id: string; sourceCaseId: string; question: string }[],
): Promise<PreparedEvaluation> {
  const policy = READING_V2_EVALUATION_POLICY,
    content = localDevelopmentBundle();
  const policyHash = await providerPolicyHash(policy),
    identities = await writerIdentitiesV2(policy);
  const corpusHash = hash(canonicalJson(contexts));
  const manifest: EvaluationManifest = {
    version: 'reflection-evaluation-manifest.v1',
    profile: 'reading-v2-development-fast-xhigh',
    model: policy.model,
    policyHash,
    contentHash: content.editionHash,
    corpusHash,
    counts: { mustAccept: 4, adversarial: 0, nonReading: 0, lifecycle: 0 },
    splits: { development: 4, calibration: 0, holdout: 0 },
    humanApprovedExamples: 0,
    humanReviewRequired: 4,
    qualificationEligible: false,
    blockers: [
      'Agent-reviewed draft meanings have unknown rights and no human approval; not production content',
      'Combined context, prompt and output change on four previously used development contexts; no isolated causal or general reliability claim',
      'Larger estimator and reservation policy remain unqualified for production',
    ],
    reservationMicrousd: policy.reservationMicrousd,
    maximumScheduledMicrousd: 640000,
    schedule: [],
    lifecycle: [],
  };
  const requests: EvaluationRequest[] = [];
  for (const context of contexts) {
    if (inputAdmission(context.question, 'en')) throw new Error('V2 context failed admission');
    const group =
      context.sourceCaseId === 'A07-2'
        ? 'review-choices'
        : context.sourceCaseId === 'A08-1'
          ? 'review-creativity'
          : null;
    if (!group) throw new Error('Unknown v2 draw group');
    const basis = await drawTarot({
      deck: content.deck.map((c) => c.id),
      deckEdition: content.deckEdition,
      basisId: '00000000-0000-4000-8000-000000000002',
      drawnAt: '2026-10-26T00:00:00Z',
      reversals: true,
      seed: new Uint8Array(createHash('sha256').update(group).digest()),
    });
    const plan = await buildPlanV2(
      {
        basis,
        content,
        requestId: '00000000-0000-4000-8000-000000000001',
        question: context.question,
        language: 'en',
        operation: 'initial',
        parentEditionId: null,
        selected: [],
        permissionRevision: 1,
        keyVersion: 1,
        ...identities,
      },
      true,
    );
    const { payload, receipt } = await prepareWriterV2(plan, policy);
    const id = `${context.id}.reading-v2.1`,
      payloadHash = hash(payload);
    requests.push({
      id,
      caseId: context.id,
      plan,
      contextReceipt: receipt,
      payloadHash,
      estimatedInputTokens: receipt.estimatedInputTokens,
      input: {
        dispatchId: id,
        payload,
        model: policy.model,
        timeoutMs: policy.timeoutMs,
        maxOutputTokens: policy.request.max_output_tokens,
        reasoning: policy.request.reasoning.effort,
        store: false,
        signal: new AbortController().signal,
      },
    });
    manifest.schedule.push({
      id,
      caseId: context.id,
      group,
      split: 'development',
      variant: 'reading-context-v2',
      repeat: 1,
      payloadHash,
      admission: null,
    });
  }
  if (requests.length !== 4) throw new Error('V2 probe requires four fixed cases');
  return { policy, manifest, manifestHash: hash(canonicalJson(manifest)), requests };
}
