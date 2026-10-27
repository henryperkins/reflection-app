import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  validatePermit,
} from '../../scripts/provider-evaluation-state.ts';

const profile = 'source-diagnostic-fast-xhigh' as const;
const prefix = 'SYNTHETIC LOCAL SIMULATION — never production editorial approval. ';
function bundle() {
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
      ['A07-2', 'situation', 'major-13', 'upright', 'Consider which commitments remain useful.'],
      ['A07-2', 'tension', 'wands-10', 'upright', 'Consider the resources each option requires.'],
      [
        'A07-2',
        'possibility',
        'swords-14',
        'upright',
        'Compare alternatives using common criteria.',
      ],
      [
        'A08-1',
        'situation',
        'wands-04',
        'reversed',
        'Examine which surroundings support creating.',
      ],
      ['A08-1', 'tension', 'major-17', 'reversed', 'Notice modest encouragement, if useful.'],
      [
        'A08-1',
        'possibility',
        'major-16',
        'reversed',
        'Keep useful structures while testing an adjustment.',
      ],
    ].map(([caseId, position, cardId, orientation, text]) => ({
      caseId,
      position,
      cardId,
      orientation,
      sourceId: `synthetic:${cardId}:${orientation}`,
      factId: `card:${position}`,
      text: prefix + text,
    })),
  };
}
const directories: string[] = [];
const journals: EvaluationJournal[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const journal of journals.splice(0)) journal.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function directory() {
  const result = mkdtempSync(join(tmpdir(), 'source-diagnostic-'));
  directories.push(result);
  return result;
}
function decoded(bytes: Uint8Array) {
  return JSON.parse(new TextDecoder().decode(bytes));
}

test('source diagnostic dry run freezes twelve calls with only selected source text varied', async () => {
  const file = join(directory(), 'sources.json');
  writeFileSync(file, JSON.stringify(bundle()), { mode: 0o600 });
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('No network in dry run'));
  const dry = await runEvaluationCli(
    ['--dry-run', '--profile', profile, '--source-bundle', file],
    {},
  );
  expect(dry).toMatchObject({ calls: 0, mode: 'dry-run', qualificationEligible: false });
  expect(network).not.toHaveBeenCalled();
  const prepared = await prepareEvaluation(profile, bundle());
  const parent = await prepareEvaluation('human-review-fast-xhigh');
  expect(parent.manifestHash).toBe(
    '0d6d5a31de1dff21914341a69dae9783b47010092a01781e8220e97118e6ad19',
  );
  expect(prepared.requests).toHaveLength(12);
  expect(prepared.manifest).toMatchObject({
    maximumScheduledMicrousd: 1440000,
    humanApprovedExamples: 0,
    qualificationEligible: false,
    sourceDiagnostic: { reviewKind: 'ai-editorial-recommendation', humanApproval: false },
  });
  expect(new Set(prepared.requests.map((r) => r.id)).size).toBe(12);
  for (const request of prepared.requests) {
    const slot = prepared.manifest.schedule.find((s) => s.id === request.id)!;
    const original = parent.requests.find((r) => r.caseId === request.caseId)!;
    const body = decoded(request.input.payload);
    const reference = decoded(original.input.payload);
    expect(body).toMatchObject({
      reasoning: { effort: 'xhigh' },
      service_tier: 'fast',
      max_output_tokens: 8192,
    });
    const data = JSON.parse(body.input[2].content);
    const oldData = JSON.parse(reference.input[2].content);
    if (slot.variant === 'original-fixture')
      expect(request.input.payload).toEqual(original.input.payload);
    else {
      expect(slot.variant).toBe('distinct-source');
      expect(data.sources.map((s: { text: string }) => s.text)).toEqual(
        bundle()
          .sources.filter((s) => s.caseId === request.caseId)
          .map((s) => s.text),
      );
      for (const [i, source] of data.sources.entries()) source.text = oldData.sources[i].text;
      body.input[2].content = JSON.stringify(data);
      expect(body).toEqual(reference);
    }
    expect(request.plan).toEqual(original.plan);
    expect(request.estimatedInputTokens).toBeLessThanOrEqual(8000);
    expect(slot.payloadHash).toBe(digest(request.input.payload));
  }
  for (const caseId of ['A07-2', 'A08-1'])
    for (const variant of ['original-fixture', 'distinct-source'])
      expect(
        prepared.manifest.schedule
          .filter((s) => s.caseId === caseId && s.variant === variant)
          .map((s) => s.repeat),
      ).toEqual([1, 2, 3]);
});

test('editing one passage changes only its three condition payloads and invalidates prior binding', async () => {
  const first = await prepareEvaluation(profile, bundle());
  const revised = bundle();
  revised.sources[4]!.text += ' An additional observation.';
  const second = await prepareEvaluation(profile, revised);
  expect(second.manifestHash).not.toBe(first.manifestHash);
  expect(second.manifest.contentHash).not.toBe(first.manifest.contentHash);
  expect(second.manifest.policyHash).toBe(first.manifest.policyHash);
  expect(
    second.requests
      .filter((r, i) => r.payloadHash !== first.requests[i]!.payloadHash)
      .map((r) => r.id),
  ).toEqual(['A08-1.distinct-source.1', 'A08-1.distinct-source.2', 'A08-1.distinct-source.3']);
});

test('distinct-source condition rejects identical text even when every card binding is valid', async () => {
  const value = bundle();
  for (const source of value.sources.filter((s) => s.caseId === 'A07-2'))
    source.text = prefix + 'The same interpretation for every position.';
  await expect(prepareEvaluation(profile, value)).rejects.toThrow(
    'Duplicate diagnostic source text',
  );
});

test('diagnostic rejects missing, misbound, duplicate, oversized, or falsely human-approved source bundles', async () => {
  await expect(prepareEvaluation(profile)).rejects.toThrow();
  const changes = [
    (b: ReturnType<typeof bundle>) => {
      b.parentManifestHash = '0'.repeat(64);
    },
    (b: ReturnType<typeof bundle>) => {
      b.sources[0]!.cardId = 'major-00';
    },
    (b: ReturnType<typeof bundle>) => {
      b.sources[1] = b.sources[0]!;
    },
    (b: ReturnType<typeof bundle>) => {
      b.sources[0]!.text = 'Missing disclosure';
    },
    (b: ReturnType<typeof bundle>) => {
      b.sources[0]!.text = prefix + 'x'.repeat(9000);
    },
    (b: ReturnType<typeof bundle>) => {
      b.review.humanApproval = true;
    },
  ];
  for (const change of changes) {
    const value = bundle();
    change(value);
    await expect(prepareEvaluation(profile, value)).rejects.toThrow();
  }
  await expect(prepareEvaluation('human-review-fast-xhigh', bundle())).rejects.toThrow();
});

test('diagnostic binds a new capped permit and crash recovery never repeats an uncertain attempt', async () => {
  const prepared = await prepareEvaluation(profile, bundle());
  const location = directory(),
    key = new Uint8Array(32).fill(7);
  const permit: EvaluationPermit = {
    version: 'reflection-evaluation-permit.v1',
    scope: 'evaluation',
    purpose: profile,
    runId: crypto.randomUUID(),
    authorizedBy: 'synthetic diagnostic operator',
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
    outputDirectory: join(location, 'archives'),
    sourceBundlePath: join(location, 'sources.json'),
  };
  expect(validatePermit(permit, prepared)).toEqual(permit);
  for (const patch of [
    { maxCalls: 13 },
    { maxCostMicrousd: 1440001 },
    { purpose: 'human-review-fast-xhigh' },
    { sourceBundlePath: undefined },
  ])
    expect(() => validatePermit({ ...permit, ...patch }, prepared)).toThrow();
  const changed = bundle();
  changed.sources[4]!.text += ' Different.';
  expect(() => validatePermit(permit, { ...prepared, manifestHash: '0'.repeat(64) })).toThrow();
  const changedPrepared = await prepareEvaluation(profile, changed);
  expect(() => validatePermit(permit, changedPrepared)).toThrow();
  const options = {
    stateDirectory: join(location, 'state'),
    checkoutRoot: process.cwd(),
    key,
    prepared,
  };
  const open = (resume = false) => {
    const journal = new EvaluationJournal(permit, options, resume);
    journals.push(journal);
    return journal;
  };
  const first = open();
  first.reserve(prepared.requests[0]!.id);
  first.close();
  const dispatched: string[] = [];
  const summary = await runEvaluation(
    permit,
    {
      write: async (input) => {
        dispatched.push(input.dispatchId);
        return { kind: 'uncertain', reason: 'network', receipt: null };
      },
    },
    open(true),
  );
  expect(dispatched).toHaveLength(11);
  expect(dispatched).not.toContain(prepared.requests[0]!.id);
  expect(summary).toMatchObject({
    attempts: 12,
    unknown: 12,
    chargedMicrousd: 1440000,
    qualificationEligible: false,
  });
  let resumedCalls = 0;
  await runEvaluation(
    permit,
    {
      write: async () => {
        resumedCalls++;
        throw new Error('Must not redispatch');
      },
    },
    open(true),
  );
  expect(resumedCalls).toBe(0);
  expect(readFileSync(join(location, 'state', 'journal.sqlite')).byteLength).toBeGreaterThan(0);
});
