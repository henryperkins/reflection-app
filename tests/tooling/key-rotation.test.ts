import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { IDENTITY_SECRETS } from '../fixtures/identity.ts';
import { ROTATED_KEYRING } from '../fixtures/keyring.ts';
import { verificationEnvironment } from '../../scripts/verification-environment.ts';
import { IdentityCrypto, encode } from '../../src/worker/identity/crypto.ts';
import { IdentityCheckpoints } from '../../src/worker/identity/checkpoint.ts';

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function input(candidate: unknown = ROTATED_KEYRING) {
  const root = mkdtempSync(join(tmpdir(), 'reflection-key-rotation-'));
  temporary.push(root);
  const current = join(root, 'current.json'),
    next = join(root, 'candidate.json');
  writeFileSync(current, JSON.stringify(IDENTITY_SECRETS), { mode: 0o600 });
  writeFileSync(next, JSON.stringify(candidate), { mode: 0o600 });
  return { current, next };
}
function run(args: string[]) {
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', resolve('scripts/key-rotation.ts'), ...args],
    { encoding: 'utf8', env: verificationEnvironment(process.env), timeout: 10_000 },
  );
}
test('operator config validation is executable, read-only, and reports key IDs without key material', () => {
  const paths = input(),
    before = readFileSync(paths.next, 'utf8');
  const result = run(['--check-config', '--current', paths.current, '--candidate', paths.next]);
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    activeKeyId: 'synthetic-v2',
    retainedKeyIds: ['synthetic-v1'],
    deploymentAllowed: false,
    keyRetirementAllowed: false,
  });
  for (const secret of [
    IDENTITY_SECRETS.wrapKey,
    IDENTITY_SECRETS.recoveryKey,
    IDENTITY_SECRETS.hmacKey,
    ...ROTATED_KEYRING.keys.flatMap((k) => [k.wrapKey, k.recoveryKey, k.hmacKey]),
  ])
    expect(result.stdout + result.stderr).not.toContain(secret);
  expect(readFileSync(paths.next, 'utf8')).toBe(before);
});
test('operator help works without key files or opening a local database', () => {
  const result = run(['--help']);
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    scope: 'synthetic-local-only',
    deploymentAllowed: false,
  });
});
test('operator rejects dropping keys, malformed secrets, and remote modes without echoing submitted input', () => {
  const paths = input({ ...ROTATED_KEYRING, keys: [ROTATED_KEYRING.keys[1]] });
  expect(
    run(['--check-config', '--current', paths.current, '--candidate', paths.next]).status,
  ).toBe(1);
  writeFileSync(paths.next, 'SYNTHETIC_REJECTED_SECRET_CANARY');
  const malformed = run(['--check-config', '--current', paths.current, '--candidate', paths.next]);
  expect(malformed.status).toBe(1);
  expect(malformed.stdout + malformed.stderr).not.toContain('SYNTHETIC_REJECTED_SECRET_CANARY');
  expect(run(['--remote', '--current', paths.current, '--candidate', paths.next]).status).toBe(1);
});

test('standalone local operator rewraps persistent D1 keys and writes a redacted audit receipt', async () => {
  const paths = input(),
    persistence = join(paths.current, '..', 'state'),
    receipt = join(paths.current, '..', 'operation.json');
  mkdirSync(persistence);
  const { Miniflare, convertV4MiniflareOptions } = await import('miniflare');
  const { unstable_splitSqlQuery: splitSqlQuery } = await import('wrangler');
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      script: '',
      modules: true,
      compatibilityDate: '2026-10-23',
      cf: false,
      resourcePersistencePath: persistence,
      d1Databases: { DB: 'DB' },
      r2Buckets: { RECOVERY: 'reflection-identity-local-checkpoints' },
    }),
  );
  try {
    const storage = await runtime.getBindings<{ DB: D1Database; RECOVERY: R2Bucket }>();
    const migrations = resolve('src/worker/db/migrations');
    for (const file of readdirSync(migrations)
      .filter((name) => name.endsWith('.sql'))
      .sort())
      await storage.DB.batch(
        splitSqlQuery(readFileSync(join(migrations, file), 'utf8')).map((sql) =>
          storage.DB.prepare(sql),
        ),
      );
    const crypt = new IdentityCrypto(IDENTITY_SECRETS),
      owner = crypto.randomUUID(),
      now = new Date().toISOString();
    await new IdentityCheckpoints(storage.DB, storage.RECOVERY, crypt).commit(
      {
        v: 1,
        operationId: crypto.randomUUID(),
        subjectId: owner,
        epoch: 1,
        createdAt: now,
        recoveryHandleHash: 'a'.repeat(64),
        recoveryAcknowledgedAt: null,
        credentials: [
          {
            id: encode(new Uint8Array([1, 2, 3])),
            publicKey: encode(new Uint8Array([4, 5, 6])),
            signCount: 0,
            backedUp: false,
            transports: ['internal'],
            createdAt: now,
          },
        ],
        recoveryCodes: [{ codeHash: 'b'.repeat(64), usedAt: null, createdAt: now }],
      },
      { initialKeys: await crypt.createAccountKeys(owner) },
    );
  } finally {
    await runtime.dispose();
  }
  const result = run([
    '--rewrap',
    '--current',
    paths.current,
    '--candidate',
    paths.next,
    '--persist-to',
    persistence,
    '--receipt',
    receipt,
  ]);
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ changedRows: 1, stillOffline: true });
  const saved = readFileSync(receipt, 'utf8');
  expect(JSON.parse(saved)).toMatchObject({
    state: 'complete',
    changedRows: 1,
    deploymentAllowed: false,
  });
  expect(saved).not.toContain(IDENTITY_SECRETS.hmacKey);
  const checked = run([
    '--check',
    '--current',
    paths.current,
    '--candidate',
    paths.next,
    '--persist-to',
    persistence,
  ]);
  expect(checked.status, checked.stderr).toBe(0);
  expect(JSON.parse(checked.stdout)).toMatchObject({ keyRows: 1, activeKeyId: 'synthetic-v2' });
}, 20_000);
