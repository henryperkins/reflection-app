import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, expect, test } from 'vitest';
import {
  inventoryKeyReferences,
  rolloverIdentityCheckpoint,
} from '../../src/worker/recovery/key-inventory.ts';
import {
  createRuntime,
  createRuntimeWorker,
  type RuntimeBindings,
} from '../../src/worker/runtime/application.ts';
import { objects } from '../../src/worker/recovery/ledger.ts';
import { bytesDigest } from '../../src/worker/recovery/digest.ts';
import { runtimeManifest, runtimeSecrets } from '../fixtures/runtime.ts';
import { backupInventoryFixture } from '../fixtures/backup-inventory.ts';
import { readingAccount, ReadingClient } from '../fixtures/reading-client.ts';
import { clearDatabase } from '../fixtures/database.ts';
import type { BackupManifest } from '../../src/worker/recovery/backup-inventory.ts';
beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await clearDatabase(env.DB);
  for (const object of await objects(env.RECOVERY, '')) await env.RECOVERY.delete(object.key);
});
async function fixture() {
  const m = runtimeManifest();
  m.environmentId = 'inventory-' + crypto.randomUUID();
  m.ingress = 'on';
  m.generation = 'intercepted';
  const first = runtimeSecrets(m.environmentId),
    second = { ...runtimeSecrets(m.environmentId), keyId: 'unused-retained' };
  const { environment: _, ...active } = first,
    { environment: __, ...unused } = second;
  const keyring = {
    v: 1 as const,
    environment: m.environmentId,
    activeKeyId: active.keyId,
    identityHmacKey: first.hmacKey,
    keys: [active, unused],
  };
  const b: RuntimeBindings = {
    DB: env.DB,
    RECOVERY: env.RECOVERY,
    OFFLINE_COORDINATOR: env.OFFLINE_COORDINATOR,
    RECOVERY_CONTROL_SECRET: 'synthetic-offline-control-token-not-a-deployed-secret',
    RUNTIME_MANIFEST: JSON.stringify(m),
    RUNTIME_RESOURCE_IDENTITIES: JSON.stringify(m.resources),
    IDENTITY_ORIGIN: m.origin,
    IDENTITY_SECRETS: JSON.stringify(keyring),
  };
  const client = new ReadingClient(b, createRuntimeWorker()),
    account = await readingAccount(true, true, client);
  await client.create('Synthetic key reference inventory.');
  const runtime = await createRuntime(b),
    context = await runtime.coordinator!.acquire('retirement');
  const owner = (await env.DB.prepare('SELECT id FROM accounts').first<string>('id'))!;
  const backups = await backupInventoryFixture(0, m.environmentId);
  async function attest() {
    for (const old of [...backups.manifests])
      if (old.purpose === 'inventory') {
        await env.BACKUP_INVENTORY.delete(backups.prefix + 'manifests/' + old.id + '.json');
        await env.BACKUP_INVENTORY.delete(old.objectKey);
        backups.manifests.splice(backups.manifests.indexOf(old), 1);
        backups.index.manifestIds.splice(backups.index.manifestIds.indexOf(old.id), 1);
      }

    const recoveryObjects = [];
    for (const object of await objects(env.RECOVERY, '')) {
      const body = await env.RECOVERY.get(object.key);
      if (!body) throw new Error('Missing fixture object');
      recoveryObjects.push({
        key: object.key,
        sha256: await bytesDigest(await body.arrayBuffer()),
      });
    }
    const id = crypto.randomUUID(),
      objectKey = 'snapshots/' + m.environmentId + '/' + id,
      bytes = new TextEncoder().encode(
        JSON.stringify({ version: 1, environmentId: m.environmentId, objects: recoveryObjects }),
      );
    const manifest: BackupManifest = {
      version: 1,
      id,
      environmentId: m.environmentId,
      kind: 'recovery',
      purpose: 'inventory',
      coordinatorEpoch: context.epoch,
      recoveryObjects,
      objectKey,
      sha256: await bytesDigest(bytes),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      recoveryEpoch: 0,
      requiredEnvironmentKeyIds: [],
      requiredAccountKeys: [],
    };
    await env.BACKUP_INVENTORY.put(objectKey, bytes);
    await env.BACKUP_INVENTORY.put(
      backups.prefix + 'manifests/' + id + '.json',
      JSON.stringify(await backups.sign(manifest)),
    );
    backups.manifests.push(manifest);
    backups.index.manifestIds.push(id);
    await env.BACKUP_INVENTORY.put(
      backups.prefix + 'index.json',
      JSON.stringify(await backups.sign(backups.index)),
    );
    return manifest;
  }
  await attest();
  return { m, b, runtime, context, owner, backups, attest, account, keyring, client };
}

test('two authenticated inventories include live wraps and lifelong checkpoints while an unused retained key stays unreferenced', async () => {
  const f = await fixture(),
    inventory = await inventoryKeyReferences(f.runtime, f.context, f.backups.inventory);
  expect(inventory.complete).toBe(true);
  expect(inventory.referencedKeyIds).toContain(f.keyring.activeKeyId);
  expect(inventory.referencedKeyIds).not.toContain('unused-retained');
  expect(inventory.counts.checkpoints).toBeGreaterThan(0);
  expect(inventory.coordinatorEpoch).toBe(f.context.epoch);
  expect(inventory.accountKeys).toContainEqual(
    expect.objectContaining({ ownerId: f.owner, version: 1, active: true }),
  );
  expect(JSON.stringify(inventory)).not.toContain('Synthetic key reference');
});

test.each([
  'lost-object',
  'lost-inventory',
  'lost-offline-copy',
  'old-backup',
  'changed-during-scan',
])('key inventory treats %s conservatively', async (failure) => {
  const f = await fixture();
  let runtime = f.runtime;
  if (failure === 'lost-object') {
    const object = (await objects(env.RECOVERY, 'identity/'))[0]!;
    await env.RECOVERY.delete(object.key);
  }
  if (failure === 'lost-inventory')
    await env.BACKUP_INVENTORY.delete(f.backups.prefix + 'index.json');
  if (failure === 'lost-offline-copy' || failure === 'old-backup') {
    const id = crypto.randomUUID(),
      objectKey = 'snapshots/' + f.m.environmentId + '/' + id,
      bytes = new TextEncoder().encode('Synthetic encrypted offline copy');
    const manifest: BackupManifest = {
      version: 1,
      id,
      environmentId: f.m.environmentId,
      kind: failure === 'old-backup' ? 'd1' : 'offline-keys',
      purpose: 'backup',
      coordinatorEpoch: 0,
      objectKey,
      sha256: await bytesDigest(bytes),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 45 * 86400000).toISOString(),
      recoveryEpoch: 0,
      requiredEnvironmentKeyIds: ['unused-retained'],
      requiredAccountKeys: [{ ownerId: f.owner, version: 1 }],
    };
    if (failure === 'old-backup') await env.BACKUP_INVENTORY.put(objectKey, bytes);
    await env.BACKUP_INVENTORY.put(
      f.backups.prefix + 'manifests/' + id + '.json',
      JSON.stringify(await f.backups.sign(manifest)),
    );
    f.backups.index.manifestIds.push(id);
    await env.BACKUP_INVENTORY.put(
      f.backups.prefix + 'index.json',
      JSON.stringify(await f.backups.sign(f.backups.index)),
    );
  }
  if (failure === 'changed-during-scan') {
    let calls = 0;
    const bucket = new Proxy(env.RECOVERY, {
      get(target, name) {
        if (name === 'list')
          return async (options: R2ListOptions) => {
            calls++;
            if (calls === 2) await target.put('identity/unexpected-arrival', 'changed');
            return target.list(options);
          };
        const value = Reflect.get(target, name, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    runtime = { ...f.runtime, recoveryBucket: bucket };
  }
  const inventory = await inventoryKeyReferences(runtime, f.context, f.backups.inventory);
  if (failure === 'old-backup') {
    expect(inventory.complete).toBe(true);
    expect(inventory.referencedKeyIds).toContain('unused-retained');
  } else expect(inventory.complete).toBe(false);
});

test('checkpoint rollover retains old objects and preserves credential, spent-code and kit verifier identity', async () => {
  const f = await fixture(),
    before = await f.runtime.identity.snapshot(f.owner),
    oldObjects = await objects(env.RECOVERY, 'identity/');
  const code = before.recoveryCodes[0]!;
  await env.DB.prepare('UPDATE recovery_codes SET used_at=? WHERE owner_id=? AND code_hash=?')
    .bind(Date.now(), f.owner, code.codeHash)
    .run();
  const expected = await f.runtime.identity.snapshot(f.owner);
  f.keyring.activeKeyId = 'unused-retained';
  f.b.IDENTITY_SECRETS = JSON.stringify(f.keyring);
  const rotated = await createRuntime(f.b);
  await rolloverIdentityCheckpoint(rotated, f.context, f.owner);
  const after = await rotated.identity.snapshot(f.owner);
  expect(after.epoch).toBe(expected.epoch + 1);
  expect(after.credentials).toEqual(expected.credentials);
  expect(after.recoveryCodes).toEqual(expected.recoveryCodes);
  expect(after.recoveryHandleHash).toBe(expected.recoveryHandleHash);
  expect((await objects(env.RECOVERY, 'identity/')).length).toBe(oldObjects.length + 1);
  // Re-sign the current closure under the same offline epoch after the intentional rollover.
  await f.attest();
  const inventory = await inventoryKeyReferences(rotated, f.context, f.backups.inventory);
  expect(inventory.complete).toBe(true);
  expect(inventory.referencedKeyIds).toEqual(
    expect.arrayContaining([f.keyring.keys[0]!.keyId, 'unused-retained']),
  );
});

test('a changed authenticated key wrap invalidates the repeated inventory even when IDs and plaintext keys match', async () => {
  const f = await fixture();
  let calls = 0;
  const backups = {
    list: async () => {
      calls++;
      if (calls === 2) {
        const row = (await env.DB.prepare('SELECT * FROM account_keys LIMIT 1').first<{
          owner_id: string;
          version: number;
          wrap_key_id: string;
          wrapped_key_enc: string;
          wrapped_index_key_enc: string;
        }>())!;
        const next = await f.runtime.identity.crypt.rewrapAccountKeys(row.owner_id, row.version, {
          wrapKeyId: row.wrap_key_id,
          wrappedKey: row.wrapped_key_enc,
          wrappedIndexKey: row.wrapped_index_key_enc,
        });
        await env.DB.prepare(
          'UPDATE account_keys SET wrapped_key_enc=?,wrapped_index_key_enc=? WHERE owner_id=? AND version=?',
        )
          .bind(next.wrappedKey, next.wrappedIndexKey, row.owner_id, row.version)
          .run();
      }
      return f.backups.inventory.list();
    },
    verify: (manifest: BackupManifest) => f.backups.inventory.verify(manifest),
  };
  expect((await inventoryKeyReferences(f.runtime, f.context, backups)).complete).toBe(false);
});
