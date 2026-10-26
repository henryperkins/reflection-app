import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, expect, test } from 'vitest';
import { IdentityCrypto, decode, encode } from '../../src/worker/identity/crypto.ts';
import { IdentityCheckpoints } from '../../src/worker/identity/checkpoint.ts';
import { clearDatabase } from '../fixtures/database.ts';
import { IDENTITY_SECRETS } from '../fixtures/identity.ts';

const cryptoService = new IdentityCrypto(IDENTITY_SECRETS);
const checkpoints = new IdentityCheckpoints(env.DB, env.RECOVERY, cryptoService);
beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await clearDatabase(env.DB);
  const objects = await env.RECOVERY.list();
  for (const item of objects.objects) await env.RECOVERY.delete(item.key);
});
async function proposed() {
  const subjectId = crypto.randomUUID();
  const now = new Date().toISOString();
  return {
    v: 1 as const,
    operationId: crypto.randomUUID(),
    subjectId,
    epoch: 1,
    createdAt: now,
    recoveryHandleHash: await cryptoService.hash('recovery-handle', 'RAW_HANDLE_MARKER'),
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
    recoveryCodes: [
      {
        codeHash: await cryptoService.hash('recovery-code', 'RAW_CODE_MARKER'),
        usedAt: null,
        createdAt: now,
      },
    ],
  };
}
test('account keys and checkpoint ciphertext authenticate their owner and purpose', async () => {
  const wrapped = await cryptoService.createAccountKeys('owner');
  const key = await cryptoService.unwrapAccountKey('owner', wrapped.wrappedKey, 'data');
  expect(key).toHaveLength(32);
  await expect(
    cryptoService.unwrapAccountKey('other', wrapped.wrappedKey, 'data'),
  ).rejects.toThrow();
  await expect(
    cryptoService.unwrapAccountKey('owner', wrapped.wrappedKey, 'index'),
  ).rejects.toThrow();
  expect(decode(encode(key))).toEqual(key);
  expect(await cryptoService.hash('session', 'value')).not.toBe(
    await cryptoService.hash('code', 'value'),
  );
});
test('commits identity only after immutable independent encrypted checkpoint durability', async () => {
  const snapshot = await proposed();
  await checkpoints.commit(snapshot, {
    initialKeys: await cryptoService.createAccountKeys(snapshot.subjectId),
  });
  const account = await env.DB.prepare('SELECT * FROM accounts WHERE id=?')
    .bind(snapshot.subjectId)
    .first();
  expect(account?.write_fence).toBeNull();
  expect(account?.auth_epoch).toBe(1);
  expect(
    await env.DB.prepare('SELECT model_allowed FROM permission_revisions').first('model_allowed'),
  ).toBe(0);
  const operation = await env.DB.prepare('SELECT * FROM security_operations').first();
  expect(operation?.state).toBe('applied');
  const stored = await env.RECOVERY.get(String(operation?.ledger_key));
  expect(stored).not.toBeNull();
  const raw = await stored!.text();
  for (const secret of ['RAW_HANDLE_MARKER', 'RAW_CODE_MARKER', snapshot.credentials[0]!.publicKey])
    expect(raw).not.toContain(secret);
  expect(
    await cryptoService.openCheckpoint(
      snapshot.subjectId,
      snapshot.epoch,
      snapshot.operationId,
      raw,
    ),
  ).toEqual(snapshot);
});
test('R2 failure leaves a resumable fence without applying credentials or granting sessions', async () => {
  const snapshot = await proposed();
  const unavailable = {
    put: async () => {
      throw new Error('synthetic outage');
    },
  } as unknown as R2Bucket;
  await expect(
    new IdentityCheckpoints(env.DB, unavailable, cryptoService).commit(snapshot, {
      initialKeys: await cryptoService.createAccountKeys(snapshot.subjectId),
    }),
  ).rejects.toThrow();
  expect(await env.DB.prepare('SELECT count(*) AS n FROM credentials').first('n')).toBe(0);
  expect(await env.DB.prepare('SELECT count(*) AS n FROM auth_sessions').first('n')).toBe(0);
  expect(await env.DB.prepare('SELECT write_fence FROM accounts').first('write_fence')).toBe(
    `security:${snapshot.operationId}`,
  );
  await checkpoints.resumePending();
  expect(await env.DB.prepare('SELECT state FROM security_operations').first('state')).toBe(
    'applied',
  );
});
test('replaying apply is idempotent and stale epochs cannot replace current identity', async () => {
  const snapshot = await proposed();
  await checkpoints.commit(snapshot, {
    initialKeys: await cryptoService.createAccountKeys(snapshot.subjectId),
  });
  const keys = await env.DB.prepare('SELECT * FROM account_keys').first();
  const next = {
    ...snapshot,
    operationId: crypto.randomUUID(),
    epoch: 2,
    recoveryAcknowledgedAt: new Date().toISOString(),
  };
  await checkpoints.commit(next, { expected: snapshot });
  await Promise.all([checkpoints.resumePending(), checkpoints.resumePending()]);
  expect(await env.DB.prepare('SELECT * FROM account_keys').first()).toEqual(keys);
  await expect(
    checkpoints.commit({ ...next, operationId: crypto.randomUUID() }, { expected: snapshot }),
  ).rejects.toThrow();
  expect(await env.DB.prepare('SELECT auth_epoch FROM accounts').first('auth_epoch')).toBe(2);
});
