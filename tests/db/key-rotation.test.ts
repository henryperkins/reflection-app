import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, expect, test } from 'vitest';
import { z } from 'zod';
import { IdentityCrypto, encode, randomToken } from '../../src/worker/identity/crypto.ts';
import { IdentityCheckpoints } from '../../src/worker/identity/checkpoint.ts';
import { localIdentity } from '../../src/worker/identity/routes.ts';
import { RecordCrypto } from '../../src/worker/readings/crypto.ts';
import { OfflineRestore } from '../../src/worker/recovery/restore.ts';
import { objects } from '../../src/worker/recovery/ledger.ts';
import { clearDatabase } from '../fixtures/database.ts';
import { IDENTITY_SECRETS } from '../fixtures/identity.ts';
import { NEXT_IDENTITY_SECRETS, ROTATED_KEYRING } from '../fixtures/keyring.ts';
import { ReadingClient, readingAccount, readingBindings } from '../fixtures/reading-client.ts';

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await clearDatabase(env.DB);
  for (const item of await objects(env.RECOVERY, '')) await env.RECOVERY.delete(item.key);
});

test('new wraps use the active environment key while retained wraps and identity verifiers remain usable', async () => {
  const old = new IdentityCrypto(IDENTITY_SECRETS),
    next = new IdentityCrypto(ROTATED_KEYRING),
    owner = crypto.randomUUID(),
    wrapped = await old.createAccountKeys(owner);
  expect(await next.unwrapAccountKey(owner, wrapped.wrappedKey, 'data')).toEqual(
    await old.unwrapAccountKey(owner, wrapped.wrappedKey, 'data'),
  );
  expect(await next.hash('recovery-code', ['handle', 'code'])).toBe(
    await old.hash('recovery-code', ['handle', 'code']),
  );
  const created = await next.createAccountKeys(owner);
  expect(created.wrapKeyId).toBe('synthetic-v2');
  await expect(old.unwrapAccountKey(owner, created.wrappedKey, 'data')).rejects.toThrow();
});

test('retained version-one account wraps written before keyring support remain readable', async () => {
  const previous = new IdentityCrypto(IDENTITY_SECRETS),
    owner = crypto.randomUUID(),
    bytes = new Uint8Array(32).fill(7);
  const legacy = await previous.seal(
    { key: encode(bytes) },
    [IDENTITY_SECRETS.environment, 'account-key.v1', owner, 1, 'data'],
    IDENTITY_SECRETS.wrapKey,
  );
  expect(await new IdentityCrypto(ROTATED_KEYRING).unwrapAccountKey(owner, legacy, 'data')).toEqual(
    bytes,
  );
});

test('account key versions are authenticated and record decryption selects the named version', async () => {
  const identity = new IdentityCrypto(IDENTITY_SECRETS),
    owner = crypto.randomUUID(),
    wrapped = await identity.createAccountKeys(owner, 7);
  await env.DB.prepare(
    'INSERT INTO accounts(id,key_version,recovery_handle_hash,created_at,updated_at) VALUES (?,7,?,1,1)',
  )
    .bind(owner, owner)
    .run();
  await env.DB.prepare(
    'INSERT INTO account_keys(owner_id,version,wrap_key_id,wrapped_key_enc,wrapped_index_key_enc,created_at) VALUES (?,7,?,?,?,1)',
  )
    .bind(owner, wrapped.wrapKeyId, wrapped.wrappedKey, wrapped.wrappedIndexKey)
    .run();
  const records = new RecordCrypto(env.DB, identity),
    id = crypto.randomUUID();
  const encrypted = await records.seal(
    {
      ownerId: owner,
      table: 'reflection_revisions',
      column: 'body_enc',
      recordId: id,
      aadRevision: 2,
    },
    { text: 'Synthetic version seven' },
    7,
  );
  expect(
    await records.open(
      {
        ownerId: owner,
        table: 'reflection_revisions',
        column: 'body_enc',
        recordId: id,
        aadRevision: 2,
      },
      encrypted,
      z.object({ text: z.string() }),
    ),
  ).toEqual({ text: 'Synthetic version seven' });
  await expect(identity.unwrapAccountKey(owner, wrapped.wrappedKey, 'data', 1)).rejects.toThrow();
  await expect(
    identity.unwrapAccountKey(crypto.randomUUID(), wrapped.wrappedKey, 'data', 7),
  ).rejects.toThrow();
  await expect(
    identity.unwrapAccountKey(owner, wrapped.wrappedIndexKey, 'data', 7),
  ).rejects.toThrow();
  await expect(records.hash(owner, 'payload', { text: 'same index identity' })).resolves.toMatch(
    /^[a-f0-9]{64}$/,
  );
});

test('completed deletion receipts remain verifiable after environment key rotation with a surviving D1 projection', async () => {
  const { client } = await readingAccount(),
    { started } = await client.create();
  const proof = { receiptId: crypto.randomUUID(), receiptToken: randomToken() };
  expect(
    (
      await client.request(`/sessions/${started.sessionId}`, proof, {
        method: 'DELETE',
        revision: 1,
      })
    ).status,
  ).toBe(202);
  const rotated = new ReadingClient({
    ...readingBindings,
    IDENTITY_SECRETS: JSON.stringify(ROTATED_KEYRING),
  });
  const response = await rotated.request(`/deletions/${proof.receiptId}`, undefined, {
    headers: { 'X-Deletion-Token': proof.receiptToken },
  });
  expect(response.status, await response.clone().text()).toBe(200);
  expect(await response.json()).toMatchObject({ state: 'complete' });
  expect(
    (
      await rotated.request(`/deletions/${proof.receiptId}`, undefined, {
        headers: { 'X-Deletion-Token': randomToken() },
      })
    ).status,
  ).toBe(404);
  const missingOld = new ReadingClient({
    ...readingBindings,
    IDENTITY_SECRETS: JSON.stringify({
      ...ROTATED_KEYRING,
      keys: ROTATED_KEYRING.keys.filter((k) => k.keyId === NEXT_IDENTITY_SECRETS.keyId),
    }),
  });
  expect(
    (
      await missingOld.request(`/deletions/${proof.receiptId}`, undefined, {
        headers: { 'X-Deletion-Token': proof.receiptToken },
      })
    ).status,
  ).toBe(503);
});

test('checkpoint recovery authenticates each envelope key when old and new bundles share a subject HMAC key', async () => {
  const { client, kit } = await readingAccount();
  const shared = {
    ...ROTATED_KEYRING,
    keys: ROTATED_KEYRING.keys.map((key) => ({ ...key, hmacKey: IDENTITY_SECRETS.hmacKey })),
  };
  const rotatedBindings = { ...readingBindings, IDENTITY_SECRETS: JSON.stringify(shared) };
  const rotatedClient = new ReadingClient(rotatedBindings);
  rotatedClient.cookies = new Map(client.cookies);
  await rotatedClient.me();
  expect((await rotatedClient.request('/auth/recovery-codes', {})).status).toBe(200);
  const restore = new OfflineRestore({ ...rotatedBindings, RESTORE_MODE: 'offline' });
  const inventory = await restore.inventory();
  const snapshots = await restore.checkpoints(inventory.identity, [kit.subjectId], new Set());
  expect(snapshots.get(kit.subjectId)?.epoch).toBeGreaterThan(1);
});

test('a checkpoint fenced before rotation resumes using its retained envelope key and original object name', async () => {
  const { kit } = await readingAccount(),
    identity = localIdentity(readingBindings)!;
  const expected = await identity.snapshot(kit.subjectId),
    next = {
      ...expected,
      operationId: crypto.randomUUID(),
      epoch: expected.epoch + 1,
      createdAt: new Date().toISOString(),
    };
  const unavailable = {
    put: async () => {
      throw new Error('Synthetic checkpoint outage');
    },
  } as unknown as R2Bucket;
  await expect(
    new IdentityCheckpoints(env.DB, unavailable, identity.crypt).commit(next, { expected }),
  ).rejects.toThrow('Synthetic checkpoint outage');
  await new IdentityCheckpoints(env.DB, env.RECOVERY, new IdentityCrypto(ROTATED_KEYRING)).apply(
    next.operationId,
  );
  expect(
    await env.DB.prepare('SELECT auth_epoch,write_fence FROM accounts WHERE id=?')
      .bind(kit.subjectId)
      .first(),
  ).toEqual({ auth_epoch: next.epoch, write_fence: null });
  expect(await env.RECOVERY.head(await identity.crypt.checkpointKey(next))).not.toBeNull();
});
