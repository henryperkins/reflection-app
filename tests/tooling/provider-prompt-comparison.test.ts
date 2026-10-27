import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createDecipheriv } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { prepareEvaluation, runEvaluationCli } from '../../scripts/provider-evaluate.ts';
import {
  EvaluationJournal,
  type EvaluationPermit,
  digest,
  validatePermit,
} from '../../scripts/provider-evaluation-state.ts';

const profile = 'prompt-comparison-fast-xhigh' as const;
function sources() {
  return {
    version: 'reflection-source-diagnostic-bundle.v1',
    parentManifestHash: '0d6d5a31de1dff21914341a69dae9783b47010092a01781e8220e97118e6ad19',
    supersedesProposalHash: 'f'.repeat(64),
    review: {
      kind: 'ai-editorial-recommendation',
      humanApproval: false,
      productionApproval: false,
    },
    sources: [
      ['A07-2', 'situation', 'major-13', 'upright'],
      ['A07-2', 'tension', 'wands-10', 'upright'],
      ['A07-2', 'possibility', 'swords-14', 'upright'],
      ['A08-1', 'situation', 'wands-04', 'reversed'],
      ['A08-1', 'tension', 'major-17', 'reversed'],
      ['A08-1', 'possibility', 'major-16', 'reversed'],
    ].map(([caseId, position, cardId, orientation], i) => ({
      caseId,
      position,
      cardId,
      orientation,
      sourceId: `synthetic:${cardId}:${orientation}`,
      factId: `card:${position}`,
      text: `SYNTHETIC LOCAL SIMULATION — never production editorial approval. Distinct test idea ${i}: examine this possibility if it applies.`,
    })),
  };
}
const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'prompt-comparison-'));
  directories.push(directory);
  const sourceBundlePath = join(directory, 'sources.json');
  writeFileSync(sourceBundlePath, JSON.stringify(sources()), { mode: 0o600 });
  const prepared = await prepareEvaluation(profile, sources()),
    key = new Uint8Array(32).fill(15);
  const permit: EvaluationPermit = {
    version: 'reflection-evaluation-permit.v1',
    scope: 'evaluation',
    purpose: profile,
    runId: crypto.randomUUID(),
    authorizedBy: 'synthetic test operator',
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
    maxCalls: 12,
    maxConcurrency: 2,
    maxCostMicrousd: 1440000,
    outputDirectory: join(directory, 'archives'),
    sourceBundlePath,
  };
  const permitPath = join(directory, 'permit.json');
  writeFileSync(permitPath, JSON.stringify(permit), { mode: 0o600 });
  const stateDirectory = join(directory, 'state');
  const env = {
    OPENAI_API_KEY: 'synthetic-key',
    OPENAI_PROJECT_ID: 'proj_synthetic',
    REFLECTION_EVALUATION_KEY: Buffer.from(key).toString('base64'),
    REFLECTION_EVALUATION_STATE_DIR: stateDirectory,
  };
  return {
    prepared,
    permit,
    permitPath,
    sourceBundlePath,
    env,
    options: { prepared, key, stateDirectory, checkoutRoot: process.cwd() },
  };
}
const decode = (payload: Uint8Array) => JSON.parse(new TextDecoder().decode(payload));

test('prompt comparison freezes twelve fresh calls with all data and settings fixed across prompt arms', async () => {
  const f = await fixture();
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network'));
  const dry = await runEvaluationCli(
    ['--dry-run', '--profile', profile, '--source-bundle', f.sourceBundlePath],
    {},
  );
  expect(dry).toMatchObject({
    calls: 0,
    manifestHash: f.prepared.manifestHash,
    qualificationEligible: false,
  });
  expect(network).not.toHaveBeenCalled();
  const parent = await prepareEvaluation('source-diagnostic-fast-xhigh', sources());
  expect(f.prepared.requests).toHaveLength(12);
  expect(f.prepared.manifest.maximumScheduledMicrousd).toBe(1440000);
  expect(f.prepared.manifest.contentHash).toBe(parent.manifest.contentHash);
  expect(f.prepared.manifest.promptComparison).toMatchObject({
    parentManifestHash: parent.manifestHash,
  });
  const revisedPrompts = new Set<string>();
  for (const request of f.prepared.requests) {
    const slot = f.prepared.manifest.schedule.find((s) => s.id === request.id)!;
    const original = parent.requests.find(
      (r) => r.id === `${request.caseId}.distinct-source.${slot.repeat}`,
    )!;
    const actual = decode(request.input.payload),
      expected = decode(original.input.payload);
    if (slot.variant === 'old-prompt')
      expect(request.input.payload).toEqual(original.input.payload);
    else {
      expect(slot.variant).toBe('revised-prompt');
      expect(actual.input[1].content).not.toBe(expected.input[1].content);
      expect(actual.input[1].content.startsWith(expected.input[1].content)).toBe(true);
      revisedPrompts.add(actual.input[1].content);
      actual.input[1].content = expected.input[1].content;
      expect(actual).toEqual(expected);
    }
    expect(request.plan).toEqual(original.plan);
    expect(request.estimatedInputTokens).toBeLessThanOrEqual(8000);
    expect(slot.payloadHash).toBe(digest(request.input.payload));
  }
  expect(revisedPrompts.size).toBe(1);
  for (const caseId of ['A07-2', 'A08-1'])
    for (const variant of ['old-prompt', 'revised-prompt'])
      expect(
        f.prepared.manifest.schedule
          .filter((s) => s.caseId === caseId && s.variant === variant)
          .map((s) => s.repeat),
      ).toEqual([1, 2, 3]);
});

test('comparison permit cannot substitute source content, prompt policy, purpose or budget', async () => {
  const f = await fixture();
  expect(validatePermit(f.permit, f.prepared)).toEqual(f.permit);
  for (const patch of [
    { purpose: 'source-diagnostic-fast-xhigh' },
    { maxCalls: 13 },
    { maxCostMicrousd: 1440001 },
    { sourceBundlePath: undefined },
  ])
    expect(() => validatePermit({ ...f.permit, ...patch }, f.prepared)).toThrow();
  const changed = sources();
  changed.sources[4]!.text += ' A changed source.';
  const changedPrepared = await prepareEvaluation(profile, changed);
  expect(() => validatePermit(f.permit, changedPrepared)).toThrow();
  const forged = structuredClone(f.prepared.manifest);
  forged.promptComparison!.revisedPolicyHash = 'a'.repeat(64);
  // Even a recomputed manifest cannot substitute a different policy for this bounded comparison.
  const { canonicalJson } = await import('../../src/domain/json.ts');
  const manifestHash = digest(canonicalJson(forged));
  expect(() =>
    validatePermit(
      { ...f.permit, manifestHash },
      { ...f.prepared, manifest: forged, manifestHash },
    ),
  ).toThrow();
});

test.each([false, true])(
  'CLI selects each arm’s strict transport policy and resumes without redispatch (crash=%s)',
  async (crash) => {
    const f = await fixture(),
      calls: string[] = [];
    if (crash) {
      const journal = new EvaluationJournal(f.permit, f.options);
      journal.reserve(f.prepared.requests[0]!.id);
      journal.close();
    }
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(new TextDecoder().decode(init!.body as Uint8Array));
      calls.push(body.input[1].content);
      return new Response(
        JSON.stringify({
          model: 'gpt-6.1-terra',
          service_tier: 'fast',
          status: 'completed',
          usage: {
            input_tokens: 100,
            output_tokens: 10,
            total_tokens: 110,
            input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
          output: [
            {
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'refusal', refusal: 'Synthetic refusal test.' }],
            },
          ],
        }),
        {
          status: 200,
          headers: { 'openai-project': 'proj_synthetic', 'x-request-id': 'req_synthetic' },
        },
      );
    });
    const args = ['--execute', '--permit', f.permitPath];
    const result = await runEvaluationCli([...args, ...(crash ? ['--resume'] : [])], f.env);
    expect(result).toMatchObject({
      attempts: 12,
      refused: crash ? 11 : 12,
      unknown: crash ? 1 : 0,
      receipts: crash ? 11 : 12,
      chargedMicrousd: crash ? 123300 : 3600,
    });
    expect(calls).toHaveLength(crash ? 11 : 12);
    expect(new Set(calls).size).toBe(2);
    const db = new DatabaseSync(join(f.options.stateDirectory, 'journal.sqlite'), {
      readOnly: true,
    });
    const events = db
      .prepare('SELECT kind,data FROM events WHERE run_id=? ORDER BY seq')
      .all(f.permit.runId);
    db.close();
    for (const event of events.filter((e) => e.kind === 'reserved' || e.kind === 'receipt'))
      expect(JSON.parse(event.data as string).recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const receipt = JSON.parse(events.find((e) => e.kind === 'receipt')!.data as string);
    const encrypted = JSON.parse(readFileSync(receipt.rawArtifact.path, 'utf8'));
    const decipher = createDecipheriv(
      'aes-256-gcm',
      f.options.key,
      Buffer.from(encrypted.iv, 'base64'),
    );
    decipher.setAAD(Buffer.from(encrypted.aad));
    decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'));
    const capture = JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(encrypted.data, 'base64')),
        decipher.final(),
      ]).toString('utf8'),
    );
    expect(capture).toMatchObject({ fetchInvocations: 1, providerRequestId: 'req_synthetic' });
    const times = [
      capture.startedAt,
      capture.fetchStartedAt,
      capture.responseHeadersAt,
      capture.finishedAt,
    ].map((t) => Date.parse(t));
    expect(times.every(Number.isFinite)).toBe(true);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    calls.length = 0;
    expect(await runEvaluationCli([...args, '--resume'], f.env)).toEqual(result);
    expect(calls).toEqual([]);
  },
);
