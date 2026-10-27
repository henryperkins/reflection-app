import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, test, vi } from 'vitest';
import {
  prepareEvaluation,
  runEvaluation,
  runEvaluationCli,
} from '../../scripts/provider-evaluate.ts';
import {
  EvaluationJournal,
  type EvaluationPermit,
  digest,
  purgeExpiredEvaluationArchives,
  validatePermit,
} from '../../scripts/provider-evaluation-state.ts';
import type { WriterOutcome, WritingProvider } from '../../src/contracts/index.ts';
import { providerReceipt } from '../fixtures/provider.ts';
import { OpenAIWritingProvider } from '../../src/worker/provider/openai.ts';
import { OpenAIResponsesTransport } from '../../src/worker/provider/transport.ts';
import { READING_PROVIDER_POLICY } from '../../src/contracts/provider-policy.ts';

const directories: string[] = [];
const journals: EvaluationJournal[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const journal of journals.splice(0)) journal.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const known: WriterOutcome = {
  kind: 'refusal',
  receipt: providerReceipt({ returnedModel: 'gpt-6.1-terra' }),
};
test('v2 context development profile freezes four exact bounded requests without calling the provider', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network'));
  const result = await runEvaluationCli(
    ['--dry-run', '--profile', 'reading-v2-development-fast-xhigh'],
    {},
  );
  expect(result).toMatchObject({ calls: 0, qualificationEligible: false });
  const prepared = await prepareEvaluation('reading-v2-development-fast-xhigh');
  expect(prepared.requests).toHaveLength(4);
  expect(prepared.manifest.maximumScheduledMicrousd).toBe(640000);
  expect(prepared.manifest.humanApprovedExamples).toBe(0);
  for (const r of prepared.requests) {
    expect(r.plan.version).toBe('tarot-plan.v2');
    const body = JSON.parse(new TextDecoder().decode(r.input.payload));
    const data = JSON.parse(body.input[2].content);
    expect(data.reader.text).toBe(r.plan.question);
    expect(data.meanings).toHaveLength(3);
    expect(data.spread.positions).toHaveLength(3);
    expect(data.selected).toEqual([]);
    expect(r.estimatedInputTokens).toBeLessThanOrEqual(16384);
    expect(body).toMatchObject({ service_tier: 'fast', reasoning: { effort: 'xhigh' } });
  }
  expect(fetch).not.toHaveBeenCalled();
});

test('v2 permits enforce the four-call cap and retain a crashed attempt without resend', async () => {
  const f = await fixture(
    { purpose: 'reading-v2-development-fast-xhigh', maxCalls: 4, maxCostMicrousd: 640000 },
    'reading-v2-development-fast-xhigh',
  );
  expect(() => validatePermit({ ...f.permit, maxCalls: 5 }, f.prepared)).toThrow();
  expect(() => validatePermit({ ...f.permit, maxCostMicrousd: 640001 }, f.prepared)).toThrow();
  expect(() =>
    validatePermit({ ...f.permit, purpose: 'human-review-fast-xhigh' }, f.prepared),
  ).toThrow();
  const first = f.open();
  first.reserve(f.prepared.requests[0]!.id);
  first.close();
  const ids: string[] = [];
  const { composeTemplateV2 } = await import('../../src/domain/tarot/writer-v2.ts');
  const summary = await runEvaluation(
    f.permit,
    {
      async write(input) {
        ids.push(input.dispatchId);
        const request = f.prepared.requests.find((r) => r.id === input.dispatchId)!;
        if (request.plan.version !== 'tarot-plan.v2') throw new Error('Wrong plan');
        return {
          kind: 'candidate',
          candidate: await composeTemplateV2(request.plan),
          receipt: providerReceipt({ returnedModel: 'gpt-6.1-terra', serviceTier: 'fast' }),
        };
      },
    },
    f.open(true),
  );
  expect(ids).toHaveLength(3);
  expect(ids).not.toContain(f.prepared.requests[0]!.id);
  expect(summary).toMatchObject({ status: 'complete', attempts: 4, accepted: 3, unknown: 1 });
  expect(summary.chargedMicrousd).toBeGreaterThanOrEqual(160000);
  const again = await runEvaluation(
    f.permit,
    {
      write: async () => {
        throw new Error('Must not resend');
      },
    },
    f.open(true),
  );
  expect(again).toEqual(summary);
});
async function fixture(
  patch: Partial<EvaluationPermit> = {},
  profile: Parameters<typeof prepareEvaluation>[0] = 'smoke',
) {
  const prepared = await prepareEvaluation(profile);
  const directory = mkdtempSync(join(tmpdir(), 'reflection-evaluation-'));
  directories.push(directory);
  const key = new Uint8Array(32).fill(13);
  const permit: EvaluationPermit = {
    version: 'reflection-evaluation-permit.v1',
    scope: 'evaluation',
    purpose: 'transport-smoke',
    runId: crypto.randomUUID(),
    authorizedBy: 'synthetic-test-owner',
    authorizedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    projectId: 'proj_synthetic',
    credentialHash: digest('synthetic-key'),
    encryptionKeyHash: digest(key),
    model: 'gpt-6.1-terra',
    policyHash: prepared.manifest.policyHash,
    contentHash: prepared.manifest.contentHash,
    corpusHash: prepared.manifest.corpusHash,
    manifestHash: prepared.manifestHash,
    maxCalls: 3,
    maxConcurrency: 2,
    maxCostMicrousd: 120000,
    outputDirectory: join(directory, 'private'),
    ...patch,
  };
  const options = {
    stateDirectory: join(directory, 'state'),
    checkoutRoot: process.cwd(),
    key,
    prepared,
  };
  const open = (resume = false, value = permit) => {
    const journal = new EvaluationJournal(value, options, resume);
    journals.push(journal);
    return journal;
  };
  return { permit, prepared, options, open, directory, key };
}

test('dry run freezes 240 grouped cases and 200 baseline slots without network or credentials', async () => {
  const result = await runEvaluationCli(['--dry-run'], {});
  expect(result).toMatchObject({ mode: 'dry-run', calls: 0, qualificationEligible: false });
  const prepared = await prepareEvaluation('baseline');
  expect(prepared.manifest.counts).toEqual({
    mustAccept: 80,
    adversarial: 80,
    nonReading: 40,
    lifecycle: 40,
  });
  expect(prepared.manifest.splits).toEqual({ development: 144, calibration: 48, holdout: 48 });
  expect(prepared.manifest.schedule).toHaveLength(200);
  expect(prepared.manifest.humanApprovedExamples).toBe(0);
  expect(prepared.manifest.humanReviewRequired).toBe(20);
  expect(prepared.manifestHash).toBe((await prepareEvaluation('baseline')).manifestHash);
});

test('human-review profile freezes only the 20 explicitly requested prompts without calling the provider', async () => {
  const result = await runEvaluationCli(['--dry-run', '--profile', 'human-review'], {});
  expect(result).toMatchObject({ mode: 'dry-run', calls: 0, qualificationEligible: false });
  const prepared = await prepareEvaluation('human-review');
  const ids = Array.from({ length: 5 }, (_, i) =>
    Array.from({ length: 4 }, (_, j) => `A${String(i + 6).padStart(2, '0')}-${j + 1}`),
  ).flat();
  expect(prepared.requests.map((request) => request.caseId)).toEqual(ids);
  expect(prepared.manifest.schedule.map((slot) => slot.caseId)).toEqual(ids);
  expect(prepared.manifest.schedule.every((slot) => slot.admission === null)).toBe(true);
  expect(prepared.manifest.maximumScheduledMicrousd).toBe(800000);
  expect(prepared.manifestHash).not.toBe((await prepareEvaluation('smoke')).manifestHash);
  expect(prepared.manifestHash).not.toBe((await prepareEvaluation('baseline')).manifestHash);
});

test('fast xhigh review preserves the same 20 prompts and draws with a separately bound policy and budget', async () => {
  const result = await runEvaluationCli(['--dry-run', '--profile', 'human-review-fast-xhigh'], {});
  expect(result).toMatchObject({ mode: 'dry-run', calls: 0, qualificationEligible: false });
  const baseline = await prepareEvaluation('human-review');
  const fast = await prepareEvaluation('human-review-fast-xhigh');
  expect(baseline.manifestHash).toBe(
    '8bc5d6f4bb6d6ea645f04ee50c9ed42cdd15ca3e2801c2b3c02ff2c86aa30047',
  );
  expect(fast.manifest.policyHash).not.toBe(baseline.manifest.policyHash);
  expect(fast.manifestHash).not.toBe(baseline.manifestHash);
  expect(fast.manifest.contentHash).toBe(baseline.manifest.contentHash);
  expect(fast.manifest.maximumScheduledMicrousd).toBe(2400000);
  expect(fast.requests.map((r) => r.caseId)).toEqual(baseline.requests.map((r) => r.caseId));
  for (const [i, request] of fast.requests.entries()) {
    const body = JSON.parse(new TextDecoder().decode(request.input.payload));
    expect(body).toMatchObject({
      model: 'gpt-6.1-terra',
      reasoning: { effort: 'xhigh' },
      service_tier: 'fast',
      max_output_tokens: 8192,
      store: false,
    });
    expect(body.input).toEqual(
      JSON.parse(new TextDecoder().decode(baseline.requests[i]!.input.payload)).input,
    );
    expect(request.input).toMatchObject({
      reasoning: 'xhigh',
      timeoutMs: 60000,
      maxOutputTokens: 8192,
    });
  }
});

test('fast evaluation binds the policy and cannot reuse standard or application authorization', async () => {
  const f = await fixture({ purpose: 'human-review-fast-xhigh' }, 'human-review-fast-xhigh');
  expect(validatePermit(f.permit, f.prepared)).toEqual(f.permit);
  expect(() => validatePermit({ ...f.permit, purpose: 'human-review' }, f.prepared)).toThrow();
  expect(() =>
    validatePermit(f.permit, { ...f.prepared, policy: READING_PROVIDER_POLICY }),
  ).toThrow();
  const writer = new OpenAIWritingProvider({ enabled: true, qualification: f.permit });
  expect(await writer.write(f.prepared.requests[0]!.input)).toMatchObject({
    kind: 'rejected',
    status: 503,
  });
});

test('fast unknown calls retain the larger reservation after recovery and are never resent', async () => {
  const f = await fixture(
    { purpose: 'human-review-fast-xhigh', maxCostMicrousd: 240000 },
    'human-review-fast-xhigh',
  );
  const journal = f.open();
  journal.reserve(f.prepared.requests[0]!.id);
  journal.close();
  const ids: string[] = [];
  const result = await runEvaluation(
    f.permit,
    {
      write: async (input) => {
        ids.push(input.dispatchId);
        return { kind: 'uncertain', reason: 'network', receipt: null };
      },
    },
    f.open(true),
  );
  expect(ids).toEqual([f.prepared.requests[1]!.id]);
  expect(result).toMatchObject({
    attempts: 2,
    unknown: 2,
    chargedMicrousd: 240000,
    status: 'budget-exhausted',
  });
});

test('fast journal reconciles actual premium costs and halts if the returned tier changes', async () => {
  const f = await fixture({ purpose: 'human-review-fast-xhigh' }, 'human-review-fast-xhigh');
  const journal = f.open();
  const [first, second] = f.prepared.requests;
  journal.reserve(first!.id);
  journal.recordReceipt(first!.id, {
    kind: 'refusal',
    receipt: providerReceipt({ returnedModel: 'gpt-6.1-terra', serviceTier: 'fast' }),
  });
  expect(journal.summary()).toMatchObject({
    receipts: 1,
    refused: 1,
    chargedMicrousd: 340,
    status: 'budget-exhausted',
  });
  // Insufficient allowance must stop before reserving a second fast request.
  expect(journal.reserve(second!.id)).toBeNull();
  const drift = await fixture({ purpose: 'human-review-fast-xhigh' }, 'human-review-fast-xhigh');
  const driftJournal = drift.open();
  driftJournal.reserve(drift.prepared.requests[0]!.id);
  driftJournal.recordReceipt(drift.prepared.requests[0]!.id, known);
  expect(driftJournal.summary()).toMatchObject({
    receipts: 0,
    unknown: 1,
    chargedMicrousd: 120000,
    status: 'halted',
  });
});

test.each([
  {},
  { authorizedBy: '' },
  { scope: 'application' },
  { purpose: 'human-review' },
  { expiresAt: '2000-01-01T00:00:00Z' },
  { maxCalls: 721 },
  { maxConcurrency: 3 },
  { maxCostMicrousd: 40000001 },
  { contentHash: 'a'.repeat(64) },
  { manifestHash: 'a'.repeat(64) },
])('invalid approval is rejected before reservation: %j', async (patch) => {
  const f = await fixture();
  expect(() =>
    f.open(false, (Object.keys(patch).length ? { ...f.permit, ...patch } : {}) as EvaluationPermit),
  ).toThrow();
});

test('execute refuses absent credentials and wrong project before opening a journal', async () => {
  const f = await fixture();
  const file = join(f.directory, 'permit.json');
  writeFileSync(file, JSON.stringify(f.permit), { mode: 0o600 });
  await expect(runEvaluationCli(['--execute', '--permit', file], {})).rejects.toThrow(
    'Evaluation credentials are missing',
  );
  await expect(
    runEvaluationCli(['--execute', '--permit', file], {
      OPENAI_API_KEY: 'synthetic-key',
      OPENAI_PROJECT_ID: 'proj_wrong',
      REFLECTION_EVALUATION_KEY: Buffer.from(f.key).toString('base64'),
    }),
  ).rejects.toThrow('Evaluation project or credential mismatch');
});

test('permits cannot authorize the application provider', async () => {
  const f = await fixture();
  const writer = new OpenAIWritingProvider({ enabled: true, qualification: f.permit });
  expect(await writer.write(f.prepared.requests[0]!.input)).toMatchObject({
    kind: 'rejected',
    status: 503,
  });
});

test('duplicate run IDs are rejected even when the output location changes; resume requires the exact permit', async () => {
  const f = await fixture();
  f.open().close();
  expect(() => f.open()).toThrow();
  expect(() =>
    f.open(false, { ...f.permit, outputDirectory: join(f.directory, 'other') }),
  ).toThrow();
  expect(() => f.open(true, { ...f.permit, maxCalls: 2 })).toThrow();
  expect(f.open(true).summary().attempts).toBe(0);
});

test.each([{ maxCalls: 1 }, { maxCostMicrousd: 40000 }])(
  'unknown calls stop at the hard budget %j',
  async (patch) => {
    const f = await fixture(patch);
    let calls = 0;
    const result = await runEvaluation(
      f.permit,
      {
        write: async () => {
          calls++;
          return { kind: 'uncertain', reason: 'network', receipt: null };
        },
      },
      f.open(),
    );
    expect(calls).toBe(1);
    expect(result).toMatchObject({
      attempts: 1,
      unknown: 1,
      receipts: 0,
      chargedMicrousd: 40000,
      status: 'budget-exhausted',
    });
  },
);

test('a durable reservation is never sent on resume', async () => {
  const f = await fixture();
  const journal = f.open();
  journal.reserve(f.prepared.requests[0]!.id);
  journal.close();
  const resumed = f.open(true);
  const ids: string[] = [];
  const result = await runEvaluation(
    f.permit,
    {
      write: async (input) => {
        ids.push(input.dispatchId);
        return known;
      },
    },
    resumed,
  );
  expect(ids).toHaveLength(2);
  expect(ids).not.toContain(f.prepared.requests[0]!.id);
  expect(result).toMatchObject({ attempts: 3, unknown: 1, receipts: 2, chargedMicrousd: 40340 });
  expect(
    await runEvaluation(
      f.permit,
      {
        write: async () => {
          throw new Error('must never resend');
        },
      },
      resumed,
    ),
  ).toEqual(result);
});

test.each(['reserved', 'returned'] as const)(
  'SIGKILL after %s leaves liability and the original attempt is never resent',
  async (phase) => {
    const f = await fixture({ maxConcurrency: 1 });
    const setup = join(f.directory, 'setup.json');
    writeFileSync(
      setup,
      JSON.stringify({
        permit: f.permit,
        stateDirectory: f.options.stateDirectory,
        key: Array.from(f.key),
        phase,
      }),
    );
    const script = join(f.directory, 'crash.mjs');
    writeFileSync(
      script,
      `
import { readFileSync } from 'node:fs';
import { prepareEvaluation, runEvaluation } from ${JSON.stringify(join(process.cwd(), 'scripts/provider-evaluate.ts'))};
import { EvaluationJournal } from ${JSON.stringify(join(process.cwd(), 'scripts/provider-evaluation-state.ts'))};
const config=JSON.parse(readFileSync(process.argv[2],'utf8'));
const prepared=await prepareEvaluation('smoke');
const journal=new EvaluationJournal(config.permit,{stateDirectory:config.stateDirectory,checkoutRoot:process.cwd(),key:new Uint8Array(config.key),prepared});
if(config.phase==='reserved') { journal.reserve(prepared.requests[0].id); process.kill(process.pid,'SIGKILL'); }
journal.recordReceipt=()=>{process.kill(process.pid,'SIGKILL');};
await runEvaluation(config.permit,{write:async()=>({kind:'refusal',receipt:null})},journal);
`,
    );
    const child = spawnSync(process.execPath, ['--import', 'tsx', script, setup], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(child.signal).toBe('SIGKILL');
    const resumed = f.open(true),
      sent: string[] = [];
    const result = await runEvaluation(
      f.permit,
      {
        write: async (input) => {
          sent.push(input.dispatchId);
          return known;
        },
      },
      resumed,
    );
    expect(sent).toHaveLength(2);
    expect(sent).not.toContain(f.prepared.requests[0]!.id);
    expect(result).toMatchObject({ unknown: 1, chargedMicrousd: 40340 });
  },
);

test('another process cannot acquire the run lock until the executor releases it', async () => {
  const f = await fixture();
  const first = f.open(),
    second = f.open(true);
  first.acquire();
  expect(() => second.acquire()).toThrow('Evaluation already executing');
  first.release();
  second.acquire();
  second.release();
});

test('the transport owns the 18-second deadline so evaluator cancellation cannot misclassify timeouts', async () => {
  const f = await fixture({ maxCalls: 1, maxConcurrency: 1 });
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), ms);
    return controller.signal;
  });
  const transport = new OpenAIResponsesTransport({
    apiKey: 'synthetic-key',
    policy: READING_PROVIDER_POLICY,
    fetch: async () => new Promise<Response>(() => {}),
  });
  const outcomes: WriterOutcome[] = [];
  const pending = runEvaluation(
    f.permit,
    {
      write: async (input) => {
        expect(input.signal).toBeInstanceOf(AbortSignal);
        // AbortSignal.timeout uses Node's native timer, outside Vitest's clock. The CLI must
        // leave timing to the tested transport rather than introducing a racing second timer.
        const outcome = await transport.write(input);
        outcomes.push(outcome);
        return outcome;
      },
    },
    f.open(),
  );
  await vi.advanceTimersByTimeAsync(18000);
  expect(await pending).toMatchObject({ attempts: 1, unknown: 1, chargedMicrousd: 40000 });
  expect(outcomes).toEqual([{ kind: 'uncertain', reason: 'timeout', receipt: null }]);
});

test('archive failure waits for all in-flight workers before releasing the execution lock', async () => {
  const f = await fixture();
  const journal = f.open();
  let finished = 0;
  const pending = runEvaluation(
    f.permit,
    {
      write: async (input) => {
        if (input.dispatchId === f.prepared.requests[0]!.id) {
          await new Promise((resolve) => setTimeout(resolve, 5));
          rmSync(join(f.permit.outputDirectory, f.permit.runId), { recursive: true });
        } else await new Promise((resolve) => setTimeout(resolve, 40));
        finished++;
        return known;
      },
    },
    journal,
  );
  await expect(pending).rejects.toThrow();
  expect(finished).toBe(2);
});

test('duplicate receipts are idempotent and conflicting receipts cannot refund liability twice', async () => {
  const f = await fixture();
  const journal = f.open(),
    id = f.prepared.requests[0]!.id;
  journal.reserve(id);
  journal.recordReceipt(id, known);
  journal.recordReceipt(id, known);
  expect(journal.summary()).toMatchObject({ receipts: 1, chargedMicrousd: 170 });
  expect(() =>
    journal.recordReceipt(id, { kind: 'uncertain', reason: 'timeout', receipt: null }),
  ).toThrow('Conflicting');
});

test('a changed persisted request cannot be substituted after the manifest is authorized', async () => {
  const f = await fixture();
  const journal = f.open(),
    request = f.prepared.requests[0]!;
  request.input.payload = new TextEncoder().encode('CHANGED_PRIVATE_PROMPT');
  request.payloadHash = digest(request.input.payload);
  expect(() => journal.reserve(request.id)).toThrow();
});

test('90-day cleanup removes private archives while retaining the run-ID tombstone', async () => {
  const f = await fixture();
  const journal = f.open();
  await runEvaluation(f.permit, { write: async () => known }, journal);
  journal.close();
  expect(
    purgeExpiredEvaluationArchives(
      f.options.stateDirectory,
      Date.parse(f.permit.authorizedAt) + 90 * 86400000,
    ),
  ).toBe(1);
  expect(() => f.open()).toThrow();
  expect(() => f.open(true)).toThrow();
});

test('SQLite reservations serialize competing connections without exceeding call or money caps', async () => {
  const f = await fixture({ maxCalls: 1 });
  const a = f.open(),
    b = f.open(true);
  const reserved = await Promise.all(
    f.prepared.requests.map(async (r, i) => (i % 2 ? b : a).reserve(r.id)),
  );
  expect(reserved.filter(Boolean)).toHaveLength(1);
  expect(a.summary()).toMatchObject({ attempts: 1, chargedMicrousd: 40000 });
});

test('parallel execution respects the permit concurrency and accounts refusal usage', async () => {
  const f = await fixture();
  let active = 0,
    maximum = 0;
  const writer: WritingProvider = {
    write: async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return known;
    },
  };
  const result = await runEvaluation(f.permit, writer, f.open());
  expect(maximum).toBe(2);
  expect(result).toMatchObject({
    attempts: 3,
    receipts: 3,
    unknown: 0,
    chargedMicrousd: 510,
    status: 'complete',
  });
});

test('protocol drift stops new dispatch and remains stopped after resume', async () => {
  const f = await fixture({ maxConcurrency: 1 });
  const journal = f.open();
  const outcome: WriterOutcome = {
    kind: 'uncertain',
    reason: 'lost_response',
    haltGeneration: true,
    receipt: null,
  };
  expect(await runEvaluation(f.permit, { write: async () => outcome }, journal)).toMatchObject({
    attempts: 1,
    status: 'halted',
  });
  journal.close();
  expect(
    await runEvaluation(
      f.permit,
      {
        write: async () => {
          throw new Error('must not dispatch');
        },
      },
      f.open(true),
    ),
  ).toMatchObject({ attempts: 1, status: 'halted' });
});

test('private prompts and responses are encrypted outside checkout; tampering and expired retention fail closed', async () => {
  const f = await fixture();
  const journal = f.open();
  await runEvaluation(f.permit, { write: async () => known }, journal);
  const artifacts = journal.artifacts();
  expect(artifacts.length).toBeGreaterThanOrEqual(6);
  for (const artifact of artifacts) {
    expect(readFileSync(artifact.path, 'utf8')).not.toMatch(
      /Consider|responseId|synthetic-key|kind.*refusal/,
    );
    expect(artifact.expiresAt).toBe(
      new Date(Date.parse(f.permit.authorizedAt) + 90 * 86400000).toISOString(),
    );
  }
  expect(journal.verifyArtifacts()).toBe(true);
  writeFileSync(artifacts[0]!.path, '{}');
  expect(() => journal.verifyArtifacts()).toThrow();
  expect(() => f.open(true)).toThrow();
  expect(
    () =>
      new EvaluationJournal(
        { ...f.permit, outputDirectory: join(process.cwd(), 'evaluation', 'private') },
        f.options,
      ),
  ).toThrow();
});

test('normal verification cannot reach the live CLI even with a key', async () => {
  const f = await fixture();
  const file = join(f.directory, 'permit.json');
  writeFileSync(file, JSON.stringify(f.permit), { mode: 0o600 });
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/provider-evaluate.ts', '--execute', '--permit', file],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, OPENAI_API_KEY: 'synthetic-key', REFLECTION_NETWORK: 'deny' },
    },
  );
  expect(result.status).not.toBe(0);
  expect(result.stdout + result.stderr).not.toContain('synthetic-key');
});
