import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { editorialBundle, signedApproval } from '../fixtures/content-approval.ts';
import { seedDatabase, OWNER } from '../fixtures/database.ts';
import { SyntheticGenerationPrototype } from '../../src/worker/db/prototype.ts';
import { verificationEnvironment } from '../../scripts/verification-environment.ts';
import { READING_PROVIDER_POLICY as policy } from '../../src/contracts/provider-policy.ts';
import { providerPolicyHash } from '../../src/domain/provider-policy.ts';
import { sha256Bytes } from '../../src/domain/json.ts';
import { providerReceipt } from '../fixtures/provider.ts';
const run = (script: string, args: string[]) =>
  spawnSync(process.execPath, ['--import', 'tsx', resolve('scripts', script), ...args], {
    encoding: 'utf8',
    env: verificationEnvironment(process.env),
    timeout: 10000,
  });
test('explicit operator commands activate and reconcile persistent local D1 without enabling generation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reflection-reading-operator-')),
    state = join(root, 'state');
  mkdirSync(state);
  const { Miniflare, convertV4MiniflareOptions } = await import('miniflare');
  const { unstable_splitSqlQuery: split } = await import('wrangler');
  const runtime = () =>
    new Miniflare(
      convertV4MiniflareOptions({
        script: '',
        modules: true,
        compatibilityDate: '2026-10-23',
        cf: false,
        resourcePersistencePath: state,
        d1Databases: { DB: 'DB' },
      }),
    );
  let mf = runtime();
  try {
    const db = await mf.getD1Database('DB');
    for (const file of readdirSync('src/worker/db/migrations')
      .filter((f) => f.endsWith('.sql'))
      .sort())
      await db.batch(
        split(readFileSync(join('src/worker/db/migrations', file), 'utf8')).map((s) =>
          db.prepare(s),
        ),
      );
    const plan = await seedDatabase(db),
      service = new SyntheticGenerationPrototype(
        db,
        { write: async () => ({ kind: 'uncertain', reason: 'timeout', receipt: null }) },
        {
          beforeReceipt: async () => {
            throw new Error('worker lost');
          },
        },
      );
    const request = await service.start(plan),
      lease = (await service.claim(OWNER, request))!;
    await expect(service.dispatch(lease, new Uint8Array([1]))).rejects.toThrow('worker lost');
    const dispatchId = (await db
      .prepare('SELECT id FROM provider_dispatches')
      .first<string>('id'))!;
    await mf.dispose();
    const bundle = await editorialBundle(),
      a = await signedApproval(bundle),
      evidence = new TextEncoder().encode('Operator reviewed bill evidence');
    const files = {
      bundle: 'bundle.json',
      approval: 'approval.json',
      publicKey: 'public.json',
      rights: 'rights.txt',
      bill: 'bill.json',
      evidence: 'bill.txt',
    };
    const path = (key: keyof typeof files) => join(root, files[key]);
    writeFileSync(path('bundle'), JSON.stringify(bundle));
    writeFileSync(path('approval'), JSON.stringify(a.signed));
    writeFileSync(
      path('publicKey'),
      JSON.stringify(await crypto.subtle.exportKey('jwk', a.keys.publicKey)),
    );
    writeFileSync(path('rights'), a.options.rightsEvidence);
    writeFileSync(path('evidence'), evidence);
    writeFileSync(
      path('bill'),
      JSON.stringify({
        version: 'provider-cost-import.v1',
        reviewerId: 'operator-a',
        reviewedAt: '2026-10-26T00:00:00Z',
        policyHash: await providerPolicyHash(policy),
        evidenceHash: await sha256Bytes(evidence),
        receipts: [
          {
            dispatchId,
            receiptId: 'bill-line-1',
            receipt: providerReceipt({
              returnedModel: policy.model,
              responseId: 'PRIVATE_RESPONSE_ID',
              usage: {
                inputTokens: 1000,
                cachedInputTokens: 200,
                cacheWriteTokens: 300,
                outputTokens: 100,
                reasoningTokens: 0,
              },
            }),
          },
        ],
      }),
      { mode: 0o600 },
    );
    const activated = run('content-activate.ts', [
      '--activate',
      '--bundle',
      path('bundle'),
      '--approval',
      path('approval'),
      '--public-key',
      path('publicKey'),
      '--rights-evidence',
      path('rights'),
      '--environment',
      'test-environment',
      '--reviewer',
      'editor-a',
      '--expected-revision',
      '1',
      '--persist-to',
      state,
    ]);
    expect(activated.status, activated.stderr).toBe(0);
    expect(JSON.parse(activated.stdout)).toMatchObject({ revision: 2, generationActivated: false });
    for (let i = 0; i < 2; i++) {
      const result = run('provider-reconcile.ts', [
        '--apply',
        '--input',
        path('bill'),
        '--evidence',
        path('evidence'),
        '--persist-to',
        state,
      ]);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ actual: 1, unknown: 0, applied: true });
      expect(result.stdout + result.stderr).not.toContain('PRIVATE_RESPONSE_ID');
    }
    mf = runtime();
    const checked = await mf.getD1Database('DB');
    expect(
      await checked
        .prepare('SELECT generation_enabled,active_content_hash FROM system_state')
        .first(),
    ).toEqual({ generation_enabled: 0, active_content_hash: bundle.editionHash });
    expect(
      await checked.prepare('SELECT sum(committed_microusd) n FROM spend_buckets').first('n'),
    ).toBe(2770);
    expect(await checked.prepare('SELECT count(*) n FROM cost_adjustments').first('n')).toBe(1);
  } finally {
    await mf.dispose();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
