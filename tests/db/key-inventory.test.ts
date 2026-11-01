import { keyInventoryFixture as fixture } from '../fixtures/key-inventory.ts';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, expect, test } from 'vitest';
import {
  inventoryKeyReferences,
  rolloverIdentityCheckpoint,
} from '../../src/worker/recovery/key-inventory.ts';
import { createRuntime } from '../../src/worker/runtime/application.ts';
import { objects } from '../../src/worker/recovery/ledger.ts';
import { bytesDigest } from '../../src/worker/recovery/digest.ts';
import { clearDatabase } from '../fixtures/database.ts';
import type { BackupManifest } from '../../src/worker/recovery/backup-inventory.ts';
beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await clearDatabase(env.DB);
  for (const object of await objects(env.RECOVERY, '')) await env.RECOVERY.delete(object.key);
});

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

test('retained old-key archived revisit bodies remain in inventory beside a new-key current body', async () => {
  const f = await fixture();
  const before = await inventoryKeyReferences(f.runtime, f.context, f.backups.inventory);
  const first = before.accountKeys.find((key) => key.ownerId === f.owner && key.version === 1)!;
  const keys = await f.runtime.identity.crypt.createAccountKeys(f.owner, 2);
  await env.DB.prepare(
    'INSERT INTO account_keys(owner_id,version,wrap_key_id,wrapped_key_enc,wrapped_index_key_enc,created_at) VALUES(?,2,?,?,?,1)',
  )
    .bind(f.owner, keys.wrapKeyId, keys.wrappedKey, keys.wrappedIndexKey)
    .run();
  const id = crypto.randomUUID();
  const archived = await f.runtime.base.crypt.seal(
    {
      ownerId: f.owner,
      table: 'revisit_revisions',
      column: 'body_enc',
      recordId: id + ':1',
      aadRevision: 1,
    },
    { note: 'Synthetic retained archived crypto fixture' },
    1,
  );
  const current = await f.runtime.base.crypt.seal(
    { ownerId: f.owner, table: 'revisits', column: 'note_enc', recordId: id, aadRevision: 2 },
    { note: 'Synthetic current crypto fixture' },
    2,
  );
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO revisits(id,owner_id,edition_id,session_id,note_enc,key_version,created_at,current_revision,updated_at) VALUES(?,?,?,?,?,2,1,2,2)',
    ).bind(id, f.owner, f.created.reading.editionId, f.created.reading.sessionId, current),
    env.DB.prepare(
      'INSERT INTO revisit_revisions(revisit_id,owner_id,revision,body_enc,key_version,created_at) VALUES(?,?,1,?,1,1)',
    ).bind(id, f.owner, archived),
    env.DB.prepare('UPDATE accounts SET key_version=2 WHERE id=?').bind(f.owner),
  ]);
  const inventory = await inventoryKeyReferences(f.runtime, f.context, f.backups.inventory);
  expect(inventory.complete).toBe(true);
  expect(inventory.accountKeys).toContainEqual(
    expect.objectContaining({
      ownerId: f.owner,
      version: 1,
      active: false,
      liveFields: first.liveFields + 1,
      operationalReferences: first.operationalReferences + 1,
    }),
  );
  expect(inventory.accountKeys).toContainEqual(
    expect.objectContaining({
      ownerId: f.owner,
      version: 2,
      active: true,
      liveFields: 1,
      operationalReferences: 1,
    }),
  );
});
