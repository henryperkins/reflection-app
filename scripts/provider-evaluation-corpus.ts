import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { PreparedPlan, WritingProvider } from '../src/contracts/index.ts';
import { READING_PROVIDER_POLICY as policy } from '../src/contracts/provider-policy.ts';
import { providerPolicyHash } from '../src/domain/provider-policy.ts';
import { canonicalJson, sha256Json } from '../src/domain/json.ts';
import { drawTarot } from '../src/domain/tarot/draw.ts';
import { buildPlan } from '../src/domain/tarot/plan.ts';
import { projectWriterPayload } from '../src/domain/tarot/render.ts';
import { inputAdmission } from '../src/domain/tarot/safety.ts';
import { syntheticBundle } from '../src/worker/readings/local-content.ts';
import { projectRoot } from './schemas.ts';

export const digest = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');
const Case = z.object({
  id: z.string(),
  group: z.string(),
  category: z.enum(['mustAccept', 'adversarial', 'nonReading', 'lifecycle']),
  split: z.enum(['development', 'calibration', 'holdout']),
  review: z.literal('unreviewed-synthetic'),
  humanReviewRequired: z.boolean(),
  quiet: z.boolean().optional(),
  question: z.string().optional(),
  language: z.string().optional(),
  operation: z.enum(['initial', 'followup']).optional(),
  expected: z.string(),
  sequence: z.array(z.string()).optional(),
  offlineSuite: z.string().optional(),
  interleaving: z.string().optional(),
});
export type EvaluationRequest = {
  id: string;
  caseId: string;
  plan: PreparedPlan;
  input: Parameters<WritingProvider['write']>[0];
  payloadHash: string;
  estimatedInputTokens: number;
};
export type EvaluationManifest = {
  version: 'reflection-evaluation-manifest.v1';
  profile: 'baseline' | 'smoke' | 'human-review';
  model: string;
  policyHash: string;
  contentHash: string;
  corpusHash: string;
  counts: Record<'mustAccept' | 'adversarial' | 'nonReading' | 'lifecycle', number>;
  splits: Record<'development' | 'calibration' | 'holdout', number>;
  humanApprovedExamples: number;
  humanReviewRequired: number;
  qualificationEligible: false;
  blockers: string[];
  reservationMicrousd: number;
  maximumScheduledMicrousd: number;
  schedule: Array<{
    id: string;
    caseId: string;
    group: string;
    split: string;
    variant: string;
    repeat: number;
    payloadHash: string | null;
    admission: string | null;
  }>;
  lifecycle: Array<{
    caseId: string;
    sequence: string[];
    interleaving: string;
    offlineSuite: string;
  }>;
};
export type PreparedEvaluation = {
  manifest: EvaluationManifest;
  manifestHash: string;
  requests: EvaluationRequest[];
};

/** Synthetic-only evaluator. These fixtures cannot pass production content activation. */
export async function prepareEvaluation(
  profile: EvaluationManifest['profile'] = 'baseline',
): Promise<PreparedEvaluation> {
  const bytes = readFileSync(resolve(projectRoot, 'evaluation/corpus.json'));
  const corpus = z
    .object({
      version: z.literal('reflection-evaluation-corpus.v2'),
      cases: z.array(Case).length(240),
    })
    .parse(JSON.parse(bytes.toString('utf8')));
  if (new Set(corpus.cases.map((c) => c.id)).size !== 240)
    throw new Error('Duplicate evaluation cases');
  const groups = new Map<string, string>();
  const counts = { mustAccept: 0, adversarial: 0, nonReading: 0, lifecycle: 0 };
  const splits = { development: 0, calibration: 0, holdout: 0 };
  for (const c of corpus.cases) {
    if (groups.has(c.group) && groups.get(c.group) !== c.split)
      throw new Error('Evaluation split leakage');
    groups.set(c.group, c.split);
    counts[c.category]++;
    splits[c.split]++;
  }
  if (
    canonicalJson(counts) !==
      canonicalJson({ mustAccept: 80, adversarial: 80, nonReading: 40, lifecycle: 40 }) ||
    canonicalJson(splits) !== canonicalJson({ development: 144, calibration: 48, holdout: 48 }) ||
    corpus.cases.filter((c) => c.quiet && c.category === 'mustAccept').length !== 20 ||
    corpus.cases.filter((c) => c.operation === 'followup').length !== 20
  )
    throw new Error('Evaluation composition changed');
  const content = await syntheticBundle();
  const policyHash = await providerPolicyHash(policy);
  const manifest: EvaluationManifest = {
    version: 'reflection-evaluation-manifest.v1',
    profile,
    model: policy.model,
    policyHash,
    contentHash: content.editionHash,
    corpusHash: digest(bytes),
    counts,
    splits,
    humanApprovedExamples: 0,
    humanReviewRequired: corpus.cases.filter((c) => c.humanReviewRequired).length,
    qualificationEligible: false,
    blockers: [
      '20 genuinely human-approved examples and cleared launch content are absent',
      'Rendering alternatives require separately frozen policies',
      'Lifecycle results require the offline D1/contract suites; this manifest is not their execution evidence',
    ],
    reservationMicrousd: policy.reservationMicrousd,
    maximumScheduledMicrousd: 0,
    schedule: [],
    lifecycle: [],
  };
  const requests: EvaluationRequest[] = [];
  const smoke = new Set(['A01-1', 'A11-1', 'A16-1']);
  for (const c of corpus.cases) {
    if (c.category === 'lifecycle') {
      manifest.lifecycle.push({
        caseId: c.id,
        sequence: c.sequence!,
        interleaving: c.interleaving!,
        offlineSuite: c.offlineSuite!,
      });
      continue;
    }
    if (profile === 'smoke' && !smoke.has(c.id)) continue;
    if (profile === 'human-review' && !c.humanReviewRequired) continue;
    const id = `${c.id}.controlled.1`;
    let admission = inputAdmission(c.question!, c.language);
    let payloadHash: string | null = null;
    if (!admission) {
      const plan = await buildPlan({
        basis: await drawTarot({
          deck: content.deck.map((d) => d.id),
          deckEdition: content.deckEdition,
          basisId: '00000000-0000-4000-8000-000000000002',
          drawnAt: '2026-10-26T00:00:00Z',
          reversals: true,
          seed: new Uint8Array(createHash('sha256').update(c.group).digest()),
        }),
        content,
        requestId: '00000000-0000-4000-8000-000000000001',
        question: c.question!,
        language: 'en',
        operation: c.operation!,
        parentEditionId: c.operation === 'followup' ? '00000000-0000-4000-8000-000000000003' : null,
        selected: [],
        permissionRevision: 1,
        keyVersion: 1,
        promptHash: await sha256Json(policy.prompt),
        validatorHash: await sha256Json(policy.validatorVersion),
        generationPolicyHash: policyHash,
      });
      try {
        const payload = await projectWriterPayload(plan, policy);
        payloadHash = digest(payload);
        requests.push({
          id,
          caseId: c.id,
          plan,
          payloadHash,
          estimatedInputTokens: payload.length + policy.estimator.framingTokens,
          input: {
            dispatchId: id,
            payload,
            model: policy.model,
            timeoutMs: policy.timeoutMs,
            maxOutputTokens: policy.request.max_output_tokens,
            store: false,
            reasoning: 'none',
            signal: new AbortController().signal,
          },
        });
      } catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith('INPUT_TOO_LARGE:')) throw error;
        admission = 'INPUT_TOO_LARGE';
      }
    }
    manifest.schedule.push({
      id,
      caseId: c.id,
      group: c.group,
      split: c.split,
      variant: 'controlled-facts',
      repeat: 1,
      payloadHash,
      admission,
    });
  }
  manifest.maximumScheduledMicrousd = requests.length * policy.reservationMicrousd;
  return { manifest, manifestHash: digest(canonicalJson(manifest)), requests };
}
