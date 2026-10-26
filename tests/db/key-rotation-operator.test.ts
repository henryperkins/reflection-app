import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, expect, test } from 'vitest';
import { IdentityCrypto, randomToken } from '../../src/worker/identity/crypto.ts';
import { LocalKeyRotation } from '../../src/worker/recovery/key-rotation.ts';
import { OfflineRestore } from '../../src/worker/recovery/restore.ts';
import { objects } from '../../src/worker/recovery/ledger.ts';
import { clearDatabase } from '../fixtures/database.ts';
import { IDENTITY_SECRETS } from '../fixtures/identity.ts';
import { ROTATED_KEYRING } from '../fixtures/keyring.ts';
import { readingAccount, readingBindings } from '../fixtures/reading-client.ts';

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await clearDatabase(env.DB);
  for (const item of await objects(env.RECOVERY, '')) await env.RECOVERY.delete(item.key);
});
const bindings = () => ({ ...readingBindings, RESTORE_MODE: 'offline' });

test('local KEK rotation preserves both account keys, validates retained checkpoints, and resumes without rewriting completed rows', async () => {
  const { kit } = await readingAccount();
  const old = await env.DB.prepare(
    'SELECT wrapped_key_enc,wrapped_index_key_enc FROM account_keys WHERE owner_id=?',
  )
    .bind(kit.subjectId)
    .first<{ wrapped_key_enc: string; wrapped_index_key_enc: string }>();
  await new OfflineRestore(bindings()).prepare();
  const rotation = new LocalKeyRotation(bindings(), ROTATED_KEYRING);
  const result = await rotation.rewrap();
  expect(result).toMatchObject({
    changedRows: 1,
    activeKeyId: 'synthetic-v2',
    stillOffline: true,
    deploymentAllowed: false,
  });
  const updated = await env.DB.prepare(
    'SELECT wrap_key_id,wrapped_key_enc,wrapped_index_key_enc FROM account_keys WHERE owner_id=?',
  )
    .bind(kit.subjectId)
    .first<{ wrap_key_id: string; wrapped_key_enc: string; wrapped_index_key_enc: string }>();
  expect(updated?.wrap_key_id).toBe('synthetic-v2');
  const source = new IdentityCrypto(IDENTITY_SECRETS),
    candidate = new IdentityCrypto(ROTATED_KEYRING);
  for (const [field, purpose] of [
    ['wrapped_key_enc', 'data'],
    ['wrapped_index_key_enc', 'index'],
  ] as const)
    expect(await candidate.unwrapAccountKey(kit.subjectId, updated![field], purpose)).toEqual(
      await source.unwrapAccountKey(kit.subjectId, old![field], purpose),
    );
  expect(await rotation.rewrap()).toMatchObject({ changedRows: 0 });
  expect(
    await env.DB.prepare('SELECT wrapped_key_enc FROM account_keys WHERE owner_id=?')
      .bind(kit.subjectId)
      .first('wrapped_key_enc'),
  ).toBe(updated?.wrapped_key_enc);
});

test('rotation refuses dropping prior keys even after active rows have been rewrapped', async () => {
  await readingAccount();
  await new OfflineRestore(bindings()).prepare();
  await new LocalKeyRotation(bindings(), ROTATED_KEYRING).rewrap();
  const source = { ...bindings(), IDENTITY_SECRETS: JSON.stringify(ROTATED_KEYRING) };
  const removed = {
    ...ROTATED_KEYRING,
    keys: ROTATED_KEYRING.keys.filter((k) => k.keyId === ROTATED_KEYRING.activeKeyId),
  };
  await expect(new LocalKeyRotation(source, removed).check()).rejects.toThrow('retirement');
});

test('rotation refuses changing existing key material or the stable identity verifier secret', async () => {
  const altered = {
    ...ROTATED_KEYRING,
    keys: ROTATED_KEYRING.keys.map((k) => ({ ...k, wrapKey: ROTATED_KEYRING.keys[1]!.wrapKey })),
  };
  await expect(new LocalKeyRotation(bindings(), altered).check()).rejects.toThrow('Existing key');
  await expect(
    new LocalKeyRotation(bindings(), {
      ...ROTATED_KEYRING,
      identityHmacKey: ROTATED_KEYRING.keys[1]!.hmacKey,
    }).check(),
  ).rejects.toThrow('identity HMAC');
});

test('rewrap refuses an online database before mutating account keys', async () => {
  const { kit } = await readingAccount();
  await expect(new LocalKeyRotation(bindings(), ROTATED_KEYRING).rewrap()).rejects.toThrow(
    'offline',
  );
  expect(
    await env.DB.prepare('SELECT wrap_key_id FROM account_keys WHERE owner_id=?')
      .bind(kit.subjectId)
      .first('wrap_key_id'),
  ).toBe('synthetic-v1');
});

test('corrupt retained identity objects block the entire rotation before any key rewrite', async () => {
  await readingAccount();
  await new OfflineRestore(bindings()).prepare();
  expect(await new LocalKeyRotation(bindings(), ROTATED_KEYRING).check()).toMatchObject({
    keyRows: 1,
  });
  const object = (await env.RECOVERY.list({ prefix: 'identity/' })).objects[0]!;
  await env.RECOVERY.put(object.key, '{}');
  await expect(new LocalKeyRotation(bindings(), ROTATED_KEYRING).rewrap()).rejects.toThrow();
  expect(
    await env.DB.prepare('SELECT count(*) AS n FROM account_keys WHERE wrap_key_id=?')
      .bind('synthetic-v2')
      .first('n'),
  ).toBe(0);
});

test('an erased account checkpoint marker does not block rewrapping a surviving account', async () => {
  const { client } = await readingAccount();
  await readingAccount();
  expect(
    (
      await client.request(
        '/account',
        { receiptId: crypto.randomUUID(), receiptToken: randomToken() },
        { method: 'DELETE' },
      )
    ).status,
  ).toBe(202);
  await new OfflineRestore(bindings()).prepare();
  expect(await new LocalKeyRotation(bindings(), ROTATED_KEYRING).rewrap()).toMatchObject({
    changedRows: 1,
    keyRows: 1,
  });
});

test('logout-all leaves a restorable identity checkpoint before local key rotation', async () => {
  const { client } = await readingAccount();
  expect((await client.request('/auth/logout-all', {})).status).toBe(204);
  await new OfflineRestore(bindings()).prepare();
  expect(await new LocalKeyRotation(bindings(), ROTATED_KEYRING).rewrap()).toMatchObject({
    changedRows: 1,
  });
});

test('offline restore accepts the committed logout-all checkpoint and keeps sessions revoked', async () => {
  const { client } = await readingAccount();
  expect((await client.request('/auth/logout-all', {})).status).toBe(204);
  const restore = new OfflineRestore(bindings());
  await restore.prepare();
  expect(await restore.replay()).toMatchObject({ status: 'verified', generationEnabled: false });
  expect(await env.DB.prepare('SELECT count(*) AS n FROM auth_sessions').first('n')).toBe(0);
});
