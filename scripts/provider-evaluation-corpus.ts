import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AnyPreparedPlan, WriterReceiptV2, WritingProvider } from '../src/contracts/index.ts';
import { prepareReadingV2 } from './provider-evaluation-v2.ts';
import {
  FAST_XHIGH_EVALUATION_POLICY,
  READING_PROVIDER_POLICY,
  UNCERTAINTY_EVALUATION_POLICY,
  CONCISE_UNCERTAINTY_EVALUATION_POLICY,
  type WriterProviderPolicy,
} from '../src/contracts/provider-policy.ts';
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
  plan: z.infer<typeof AnyPreparedPlan>;
  contextReceipt?: WriterReceiptV2;
  input: Parameters<WritingProvider['write']>[0];
  payloadHash: string;
  estimatedInputTokens: number;
};
export type EvaluationManifest = {
  version: 'reflection-evaluation-manifest.v1';
  profile:
    | 'baseline'
    | 'smoke'
    | 'human-review'
    | 'human-review-fast-xhigh'
    | 'source-diagnostic-fast-xhigh'
    | 'prompt-comparison-fast-xhigh'
    | 'independent-context-fast-xhigh'
    | 'reading-v2-development-fast-xhigh';
  independentContexts?: {
    parentManifestHash: string;
    contextsHash: string;
    scope: 'new-contexts-same-source-draws';
  };
  promptComparison?: {
    parentManifestHash: string;
    oldPolicyHash: string;
    revisedPolicyHash: string;
    order: 'alternating-within-case-and-repeat';
  };
  sourceDiagnostic?: {
    sourceBundleHash: string;
    parentManifestHash: string;
    supersedesProposalHash: string;
    reviewKind: 'ai-editorial-recommendation';
    humanApproval: false;
  };
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
  policy: WriterProviderPolicy;
  manifest: EvaluationManifest;
  manifestHash: string;
  requests: EvaluationRequest[];
};

/** Synthetic-only evaluator. These fixtures cannot pass production content activation. */
export async function prepareEvaluation(
  profile: EvaluationManifest['profile'] = 'baseline',
  sourceBundle?: unknown,
): Promise<PreparedEvaluation> {
  if (profile === 'reading-v2-development-fast-xhigh') {
    if (sourceBundle !== undefined) throw new Error('V2 uses the pinned local draft only');
    return prepareReadingV2(INDEPENDENT_READING_CONTEXTS);
  }
  if (profile === 'source-diagnostic-fast-xhigh') return prepareSourceDiagnostic(sourceBundle);
  if (profile === 'prompt-comparison-fast-xhigh') return preparePromptComparison(sourceBundle);
  if (profile === 'independent-context-fast-xhigh') return prepareIndependentContexts(sourceBundle);
  if (sourceBundle !== undefined) throw new Error('Source bundle requires a diagnostic profile');
  const policy =
    profile === 'human-review-fast-xhigh' ? FAST_XHIGH_EVALUATION_POLICY : READING_PROVIDER_POLICY;
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
    if (
      (profile === 'human-review' || profile === 'human-review-fast-xhigh') &&
      !c.humanReviewRequired
    )
      continue;
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
            reasoning: policy.request.reasoning.effort,
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
  return { policy, manifest, manifestHash: digest(canonicalJson(manifest)), requests };
}

const SourceDiagnosticBundle = z.strictObject({
  version: z.literal('reflection-source-diagnostic-bundle.v1'),
  parentManifestHash: z.string().regex(/^[a-f0-9]{64}$/),
  supersedesProposalHash: z.string().regex(/^[a-f0-9]{64}$/),
  review: z.strictObject({
    kind: z.literal('ai-editorial-recommendation'),
    humanApproval: z.literal(false),
    productionApproval: z.literal(false),
  }),
  sources: z
    .array(
      z.strictObject({
        caseId: z.enum(['A07-2', 'A08-1']),
        position: z.enum(['situation', 'tension', 'possibility']),
        factId: z.string(),
        sourceId: z.string(),
        cardId: z.string(),
        orientation: z.enum(['upright', 'reversed']),
        text: z
          .string()
          .min(1)
          .max(2000)
          .startsWith('SYNTHETIC LOCAL SIMULATION — never production editorial approval. '),
      }),
    )
    .length(6),
});

/** Evaluation-only wire substitution. No human-approved canon or application plan is created. */
async function prepareSourceDiagnostic(value: unknown): Promise<PreparedEvaluation> {
  const bundle = SourceDiagnosticBundle.parse(value);
  const parent = await prepareEvaluation('human-review-fast-xhigh');
  if (bundle.parentManifestHash !== parent.manifestHash) throw new Error('Diagnostic parent drift');
  const sourceBundleHash = digest(canonicalJson(bundle));
  const manifest: EvaluationManifest = {
    ...parent.manifest,
    profile: 'source-diagnostic-fast-xhigh',
    sourceDiagnostic: {
      sourceBundleHash,
      parentManifestHash: parent.manifestHash,
      supersedesProposalHash: bundle.supersedesProposalHash,
      reviewKind: bundle.review.kind,
      humanApproval: false,
    },
    contentHash: digest(
      canonicalJson({ originalContentHash: parent.manifest.contentHash, sourceBundleHash }),
    ),
    counts: { mustAccept: 2, adversarial: 0, nonReading: 0, lifecycle: 0 },
    splits: { development: 2, calibration: 0, holdout: 0 },
    humanReviewRequired: 2,
    maximumScheduledMicrousd: 1440000,
    schedule: [],
    lifecycle: [],
    blockers: [
      'AI editorial recommendation only; no human or production approval',
      'Source bundles vary in length, content and differentiation; this is not model qualification',
    ],
  };
  const requests: EvaluationRequest[] = [];
  for (const caseId of ['A07-2', 'A08-1']) {
    const original = parent.requests.find((r) => r.caseId === caseId)!;
    const replacements = original.plan.basis.cards.map((card, index) => {
      const matches = bundle.sources.filter(
        (s) => s.caseId === caseId && s.position === card.position,
      );
      const source = matches[0];
      if (
        matches.length !== 1 ||
        !source ||
        source.cardId !== card.cardId ||
        source.orientation !== card.orientation ||
        source.factId !== card.id ||
        source.sourceId !== original.plan.sources[index]!.id
      )
        throw new Error('Diagnostic source binding mismatch');
      return source;
    });
    if (
      new Set(replacements.map((s) => s.text.normalize('NFKC').replace(/\s+/gu, ' ').trim()))
        .size !== 3
    )
      throw new Error('Duplicate diagnostic source text');
    for (const variant of ['original-fixture', 'distinct-source']) {
      let payload = new Uint8Array(original.input.payload);
      if (variant === 'distinct-source') {
        const body = JSON.parse(new TextDecoder().decode(payload));
        const data = JSON.parse(body.input[2].content);
        for (const [index, source] of data.sources.entries())
          source.text = replacements[index]!.text;
        body.input[2].content = JSON.stringify(data);
        payload = new TextEncoder().encode(JSON.stringify(body));
      }
      const estimatedInputTokens = payload.length + parent.policy.estimator.framingTokens;
      if (
        payload.length > parent.policy.estimator.maxPayloadBytes ||
        estimatedInputTokens > parent.policy.estimator.maxInputTokens
      )
        throw new Error('INPUT_TOO_LARGE: diagnostic source payload');
      const payloadHash = digest(payload);
      for (let repeat = 1; repeat <= 3; repeat++) {
        const id = `${caseId}.${variant}.${repeat}`;
        // The unmodified fixture plan is for mechanical fact/source-ID checks only.
        // Exact source evidence is the manifest-bound, archived wire request above.
        requests.push({
          ...original,
          id,
          payloadHash,
          estimatedInputTokens,
          input: { ...original.input, dispatchId: id, payload: new Uint8Array(payload) },
        });
        const slot = parent.manifest.schedule.find((s) => s.caseId === caseId)!;
        manifest.schedule.push({ ...slot, id, variant, repeat, payloadHash });
      }
    }
  }
  return {
    policy: parent.policy,
    manifest,
    manifestHash: digest(canonicalJson(manifest)),
    requests,
  };
}

/** Both arms share accounting/settings; only the developer prompt and its identity differ. */
async function preparePromptComparison(value: unknown): Promise<PreparedEvaluation> {
  const parent = await prepareSourceDiagnostic(value);
  const manifest: EvaluationManifest = {
    ...parent.manifest,
    profile: 'prompt-comparison-fast-xhigh',
    promptComparison: {
      parentManifestHash: parent.manifestHash,
      oldPolicyHash: parent.manifest.policyHash,
      revisedPolicyHash: await providerPolicyHash(UNCERTAINTY_EVALUATION_POLICY),
      order: 'alternating-within-case-and-repeat',
    },
    schedule: [],
    blockers: [
      'AI editorial recommendation only; no human or production approval',
      'Two-case prompt comparison is diagnostic evidence, not provider qualification',
    ],
  };
  const requests: EvaluationRequest[] = [];
  for (const caseId of ['A07-2', 'A08-1'])
    for (let repeat = 1; repeat <= 3; repeat++) {
      const original = parent.requests.find((r) => r.id === `${caseId}.distinct-source.${repeat}`)!;
      const variants =
        repeat % 2 ? ['old-prompt', 'revised-prompt'] : ['revised-prompt', 'old-prompt'];
      for (const variant of variants) {
        let payload = new Uint8Array(original.input.payload);
        if (variant === 'revised-prompt') {
          const body = JSON.parse(new TextDecoder().decode(payload));
          body.input[1].content = UNCERTAINTY_EVALUATION_POLICY.prompt.developer;
          payload = new TextEncoder().encode(JSON.stringify(body));
        }
        const estimatedInputTokens = payload.length + parent.policy.estimator.framingTokens;
        if (
          payload.length > parent.policy.estimator.maxPayloadBytes ||
          estimatedInputTokens > parent.policy.estimator.maxInputTokens
        )
          throw new Error('INPUT_TOO_LARGE: prompt comparison payload');
        const id = `${caseId}.${variant}.${repeat}`,
          payloadHash = digest(payload);
        requests.push({
          ...original,
          id,
          payloadHash,
          estimatedInputTokens,
          input: { ...original.input, dispatchId: id, payload },
        });
        const slot = parent.manifest.schedule.find((s) => s.id === original.id)!;
        manifest.schedule.push({ ...slot, id, variant, payloadHash });
      }
    }
  return {
    policy: parent.policy,
    manifest,
    manifestHash: digest(canonicalJson(manifest)),
    requests,
  };
}

export function evaluationPolicyForRequest(
  prepared: PreparedEvaluation,
  dispatchId: string,
): WriterProviderPolicy {
  if (prepared.manifest.profile !== 'prompt-comparison-fast-xhigh') return prepared.policy;
  const slot = prepared.manifest.schedule.find((s) => s.id === dispatchId);
  if (slot?.variant === 'revised-prompt') return UNCERTAINTY_EVALUATION_POLICY;
  if (slot?.variant === 'old-prompt') return prepared.policy;
  throw new Error('Unknown prompt comparison arm');
}

export const INDEPENDENT_READING_CONTEXTS = [
  {
    id: 'I01',
    sourceCaseId: 'A07-2',
    question:
      'I am comparing my illustration newsletter with a small print project. The newsletter is running smoothly. The workload is manageable. My goal is to finish a cohesive collection. How can I compare the formats while preserving what already works?',
  },
  {
    id: 'I02',
    sourceCaseId: 'A07-2',
    question:
      'I ended an unused study group and kept its shared resource list. I am choosing between paired reading sessions and a discussion channel. How can I compare these formats without taking on extra commitments?',
  },
  {
    id: 'I03',
    sourceCaseId: 'A08-1',
    question:
      'My writing group is welcoming, my desk setup works, and I am not discouraged. I feel stuck on the opening of a short story. What could I try while keeping those supports?',
  },
  {
    id: 'I04',
    sourceCaseId: 'A08-1',
    question:
      'I feel discouraged after my sketches did not match what I imagined, but a drawing session with a friend helped. How can I approach another sketch without abandoning my current routine?',
  },
] as const;

async function prepareIndependentContexts(value: unknown): Promise<PreparedEvaluation> {
  const parent = await prepareSourceDiagnostic(value),
    policy = CONCISE_UNCERTAINTY_EVALUATION_POLICY;
  const policyHash = await providerPolicyHash(policy),
    contextsHash = digest(canonicalJson(INDEPENDENT_READING_CONTEXTS));
  const manifest: EvaluationManifest = {
    ...parent.manifest,
    profile: 'independent-context-fast-xhigh',
    policyHash,
    independentContexts: {
      parentManifestHash: parent.manifestHash,
      contextsHash,
      scope: 'new-contexts-same-source-draws',
    },
    corpusHash: digest(
      canonicalJson({ parentCorpusHash: parent.manifest.corpusHash, contextsHash }),
    ),
    counts: { mustAccept: 4, adversarial: 0, nonReading: 0, lifecycle: 0 },
    splits: { development: 4, calibration: 0, holdout: 0 },
    humanReviewRequired: 4,
    maximumScheduledMicrousd: 480000,
    schedule: [],
    blockers: [
      'New synthetic contexts reuse the same source/draw bundles; no statistical independence or qualification claimed',
      'AI source review and single attempts do not establish human acceptance',
    ],
  };
  const requests: EvaluationRequest[] = [];
  for (const context of INDEPENDENT_READING_CONTEXTS) {
    if (inputAdmission(context.question, 'en'))
      throw new Error('Independent context failed admission');
    const original = parent.requests.find(
      (r) => r.id === `${context.sourceCaseId}.distinct-source.1`,
    )!;
    const body = JSON.parse(new TextDecoder().decode(original.input.payload)),
      data = JSON.parse(body.input[2].content);
    data.question = context.question;
    body.input[2].content = JSON.stringify(data);
    body.input[1].content = policy.prompt.developer;
    const payload = new TextEncoder().encode(JSON.stringify(body)),
      estimatedInputTokens = payload.length + policy.estimator.framingTokens;
    if (
      payload.length > policy.estimator.maxPayloadBytes ||
      estimatedInputTokens > policy.estimator.maxInputTokens
    )
      throw new Error('INPUT_TOO_LARGE: independent context');
    const id = `${context.id}.concise-prompt.1`,
      payloadHash = digest(payload);
    const plan = {
      ...original.plan,
      question: context.question,
      generationPolicyHash: policyHash,
      promptHash: await sha256Json(policy.prompt),
    };
    requests.push({
      ...original,
      id,
      caseId: context.id,
      plan,
      payloadHash,
      estimatedInputTokens,
      input: { ...original.input, dispatchId: id, payload },
    });
    manifest.schedule.push({
      id,
      caseId: context.id,
      group: context.sourceCaseId,
      split: 'development',
      variant: 'concise-prompt',
      repeat: 1,
      payloadHash,
      admission: null,
    });
  }
  return { policy, manifest, manifestHash: digest(canonicalJson(manifest)), requests };
}
