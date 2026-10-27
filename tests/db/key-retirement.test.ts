import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, expect, test } from 'vitest';
import { keyInventoryFixture } from '../fixtures/key-inventory.ts';
import { clearDatabase } from '../fixtures/database.ts';
import { objects } from '../../src/worker/recovery/ledger.ts';
import { inventoryKeyReferences } from '../../src/worker/recovery/key-inventory.ts';
import {
  planKeyRetirement,
  applyKeyRetirement,
  checkRetirementCandidate,
  planAccountDataKeyRetirement,
  applyAccountDataKeyRetirement,
} from '../../src/worker/recovery/key-retirement.ts';
import { createRuntime } from '../../src/worker/runtime/application.ts';
import { sha256Json } from '../../src/domain/json.ts';
import { AccountRekey } from '../../src/worker/recovery/account-rekey.ts';
beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await clearDatabase(env.DB);
  for (const object of await objects(env.RECOVERY, '')) await env.RECOVERY.delete(object.key);
});

test('an authenticated unreferenced environment bundle produces an idempotent protected candidate without installing secrets', async () => {
  const f = await keyInventoryFixture(),
    inventory = await inventoryKeyReferences(f.runtime, f.context, f.backups.inventory);
  const plan = await planKeyRetirement(f.keyring, inventory, ['unused-retained']);
  expect(plan.allowed).toBe(true);
  const first = await applyKeyRetirement(f.runtime, f.context, f.backups.inventory, plan),
    second = await applyKeyRetirement(f.runtime, f.context, f.backups.inventory, plan);
  expect(first).toEqual(second);
  expect(first.candidate.keys.map((k) => k.keyId)).toEqual([f.keyring.activeKeyId]);
  expect(first.candidate.identityHmacKey).toBe(f.keyring.identityHmacKey);
  expect(first.receipt).toMatchObject({
    status: 'prepared',
    installed: false,
    destroyed: false,
    stillOffline: true,
  });
  expect(JSON.stringify(first.receipt)).not.toContain('wrapKey');
  await checkRetirementCandidate(f.keyring, first.candidate, first.receipt);
  expect((await f.client.request('/me')).status).toBe(503);
});

test.each(['active', 'referenced', 'incomplete', 'expired', 'tampered'] as const)(
  'retirement planning rejects %s evidence',
  async (failure) => {
    const f = await keyInventoryFixture();
    let runtime = f.runtime;
    if (failure === 'referenced') {
      f.keyring.activeKeyId = 'unused-retained';
      f.b.IDENTITY_SECRETS = JSON.stringify(f.keyring);
      runtime = await createRuntime(f.b);
    }
    const inventory = await inventoryKeyReferences(runtime, f.context, f.backups.inventory);
    if (failure === 'incomplete') inventory.complete = false;
    if (failure === 'expired') inventory.observedAt = new Date(Date.now() - 3600000).toISOString();
    if (failure === 'incomplete' || failure === 'expired') {
      const { digest: _, ...document } = inventory;
      inventory.digest = await sha256Json(document);
    }
    if (failure === 'tampered') inventory.referenceDigest = 'f'.repeat(64);
    const ids =
      failure === 'active' || failure === 'referenced'
        ? [f.keyring.keys[0]!.keyId]
        : ['unused-retained'];
    expect((await planKeyRetirement(f.keyring, inventory, ids)).allowed).toBe(false);
  },
);

test('candidate checks reject changes to retained material and the stable identity verifier', async () => {
  const f = await keyInventoryFixture(),
    inventory = await inventoryKeyReferences(f.runtime, f.context, f.backups.inventory),
    plan = await planKeyRetirement(f.keyring, inventory, ['unused-retained']);
  const { candidate, receipt } = await applyKeyRetirement(
    f.runtime,
    f.context,
    f.backups.inventory,
    plan,
  );
  for (const change of ['material', 'identity']) {
    const modified = structuredClone(candidate);
    if (change === 'material') modified.keys[0]!.wrapKey = modified.keys[0]!.hmacKey;
    else modified.identityHmacKey = f.keyring.keys[1]!.hmacKey;
    await expect(checkRetirementCandidate(f.keyring, modified, receipt)).rejects.toThrow();
  }
});

test('a superseded coordinator epoch cannot prepare a candidate', async () => {
  const f = await keyInventoryFixture(),
    inventory = await inventoryKeyReferences(f.runtime, f.context, f.backups.inventory),
    plan = await planKeyRetirement(f.keyring, inventory, ['unused-retained']);
  await f.runtime.coordinator!.complete(f.context, 'a'.repeat(64));
  const next = await f.runtime.coordinator!.acquire('retirement');
  await expect(applyKeyRetirement(f.runtime, next, f.backups.inventory, plan)).rejects.toThrow();
  await expect(
    applyKeyRetirement(f.runtime, f.context, f.backups.inventory, plan),
  ).rejects.toThrow();
});

test('self-hashed fabricated reference evidence never substitutes for a fresh authenticated scan', async () => {
  const f = await keyInventoryFixture(),
    inventory = await inventoryKeyReferences(f.runtime, f.context, f.backups.inventory);
  inventory.referenceDigest = 'e'.repeat(64);
  const { digest: _, ...document } = inventory;
  inventory.digest = await sha256Json(document);
  const plan = await planKeyRetirement(f.keyring, inventory, ['unused-retained']);
  await expect(
    applyKeyRetirement(f.runtime, f.context, f.backups.inventory, plan),
  ).rejects.toThrow();
});

test('unreferenced old account-DEK wraps retire atomically after complete replacement and keep the stable index intact', async () => {
  const f = await keyInventoryFixture();
  await f.runtime.coordinator!.complete(f.context, 'a'.repeat(64));
  const rekey = await f.runtime.coordinator!.acquire('rekey'),
    service = new AccountRekey(f.runtime.base, f.runtime.coordinator!, rekey),
    start = await service.begin(f.owner, 1);
  let phase = '';
  while (phase !== 'complete') phase = (await service.step(start.operationId, 20)).phase;
  const before = await f.runtime.base.crypt.hash(f.owner, 'mutation', { stable: 'identity' });
  await f.runtime.coordinator!.complete(rekey, 'b'.repeat(64));
  const context = await f.runtime.coordinator!.acquire('retirement');
  await f.attest(context);
  const inventory = await inventoryKeyReferences(f.runtime, context, f.backups.inventory),
    plan = await planAccountDataKeyRetirement(inventory, f.owner, 1);
  expect(plan.allowed).toBe(true);
  const receipt = await applyAccountDataKeyRetirement(
    f.runtime,
    context,
    f.backups.inventory,
    plan,
  );
  expect(receipt).toMatchObject({ status: 'committed', stillOffline: true });
  expect(
    await applyAccountDataKeyRetirement(f.runtime, context, f.backups.inventory, plan),
  ).toEqual(receipt);
  expect(
    await env.DB.prepare('SELECT version FROM account_keys WHERE owner_id=?')
      .bind(f.owner)
      .first('version'),
  ).toBe(2);
  expect(await f.runtime.base.crypt.hash(f.owner, 'mutation', { stable: 'identity' })).toBe(before);
});

test('nullable retired bodies still retain their operational database key-version references', async () => {
  const f = await keyInventoryFixture(),
    owner = f.owner,
    crypt = f.runtime.identity.crypt;
  const prior = (await env.DB.prepare(
    'SELECT wrapped_index_key_enc FROM account_keys',
  ).first<string>('wrapped_index_key_enc'))!;
  const next = await crypt.createAccountDataVersion(
    owner,
    2,
    await crypt.unwrapAccountKey(owner, prior, 'index', 1),
  );
  await env.DB.prepare('INSERT INTO account_keys VALUES(?,2,?,?,?,?)')
    .bind(owner, next.wrapKeyId, next.wrappedKey, next.wrappedIndexKey, Date.now())
    .run();
  await env.DB.prepare('UPDATE accounts SET key_version=2 WHERE id=?').bind(owner).run();
  await env.DB.prepare(
    "UPDATE reading_editions SET status='deleted',invalidated_at=? WHERE owner_id=?",
  )
    .bind(Date.now(), owner)
    .run();
  await env.DB.prepare("UPDATE reading_sessions SET status='deleted',deleted_at=? WHERE owner_id=?")
    .bind(Date.now(), owner)
    .run();
  const { ACCOUNT_FIELD_HANDLERS } = await import('../../src/worker/recovery/private-fields.ts');
  for (const field of ACCOUNT_FIELD_HANDLERS)
    await env.DB.prepare(`UPDATE ${field.table} SET ${field.column}=NULL WHERE owner_id=?`)
      .bind(owner)
      .run();
  const inventory = await inventoryKeyReferences(f.runtime, f.context, f.backups.inventory),
    plan = await planAccountDataKeyRetirement(inventory, owner, 1);
  expect(inventory.accountKeys.find((k) => k.version === 1)!.liveFields).toBe(0);
  expect(inventory.accountKeys.find((k) => k.version === 1)!.operationalReferences).toBeGreaterThan(
    0,
  );
  expect(plan.allowed).toBe(false);
});

test.each(['backup', 'pending-erasure'] as const)(
  'a new %s dependency invalidates candidate preparation',
  async (kind) => {
    const f = await keyInventoryFixture(),
      inventory = await inventoryKeyReferences(f.runtime, f.context, f.backups.inventory),
      plan = await planKeyRetirement(f.keyring, inventory, ['unused-retained']);
    if (kind === 'backup') {
      const { bytesDigest } = await import('../../src/worker/recovery/digest.ts');
      const id = crypto.randomUUID(),
        objectKey = 'snapshots/' + f.m.environmentId + '/' + id,
        bytes = new TextEncoder().encode('Synthetic encrypted old key backup');
      const manifest = {
        version: 1,
        id,
        environmentId: f.m.environmentId,
        kind: 'offline-keys',
        purpose: 'backup',
        coordinatorEpoch: 0,
        objectKey,
        sha256: await bytesDigest(bytes),
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 45 * 86400000).toISOString(),
        recoveryEpoch: 0,
        requiredEnvironmentKeyIds: ['unused-retained'],
        requiredAccountKeys: [],
      };
      await env.BACKUP_INVENTORY.put(objectKey, bytes);
      await env.BACKUP_INVENTORY.put(
        f.backups.prefix + 'manifests/' + id + '.json',
        JSON.stringify(await f.backups.sign(manifest)),
      );
      f.backups.index.manifestIds.push(id);
      await env.BACKUP_INVENTORY.put(
        f.backups.prefix + 'index.json',
        JSON.stringify(await f.backups.sign(f.backups.index)),
      );
    } else {
      const { SessionErasure } = await import('../../src/worker/readings/erasure.ts');
      const erasure = new SessionErasure(f.runtime.base, env.RECOVERY),
        id = crypto.randomUUID(),
        intent = await erasure.ledger.create(
          { scope: 'account', subjectId: f.owner },
          id,
          null,
          Date.now(),
        );
      await erasure.ledger.putIntent(intent);
    }
    await expect(
      applyKeyRetirement(f.runtime, f.context, f.backups.inventory, plan),
    ).rejects.toThrow();
    expect(
      await env.DB.prepare('SELECT count(*) n FROM key_retirement_operations').first('n'),
    ).toBe(0);
  },
);

test('a synthetic candidate supports all three backup formats, exact reads/export, same-kit recovery and retained deletion receipts', async () => {
  const f = await keyInventoryFixture();
  const { snapshot, restoreSnapshot } = await import('../fixtures/snapshot.ts');
  const { OfflineRestore } = await import('../../src/worker/recovery/restore.ts');
  const { localDevelopmentBundle } = await import('../../src/worker/readings/local-content.ts');
  const { bytesDigest } = await import('../../src/worker/recovery/digest.ts');
  const { canonicalJson } = await import('../../src/domain/json.ts');
  const { Reading, apiSchemas, AuthOptions, AuthResult } = await import(
    '../../src/contracts/index.ts'
  );
  const { createRuntimeWorker } = await import('../../src/worker/runtime/application.ts');
  const { ReadingClient } = await import('../fixtures/reading-client.ts');
  const { syntheticPasskey } = await import('../fixtures/passkeys.ts');
  const { encode, uuidBytes } = await import('../../src/worker/identity/crypto.ts');
  const initial = await inventoryKeyReferences(f.runtime, f.context, f.backups.inventory),
    preview = await applyKeyRetirement(
      f.runtime,
      f.context,
      f.backups.inventory,
      await planKeyRetirement(f.keyring, initial, ['unused-retained']),
    );
  const saved = await snapshot(env.DB),
    recovery = [];
  for (const object of await objects(env.RECOVERY, ''))
    recovery.push({ key: object.key, body: await (await env.RECOVERY.get(object.key))!.text() });
  const copies = [
    { kind: 'd1' as const, document: saved },
    { kind: 'recovery' as const, document: recovery },
    { kind: 'offline-keys' as const, document: preview.candidate },
  ];
  const stored = [];
  for (const copy of copies) {
    const id = crypto.randomUUID(),
      objectKey = 'snapshots/' + f.m.environmentId + '/' + id,
      bytes = new TextEncoder().encode(JSON.stringify(copy.document));
    const manifest = {
      version: 1,
      id,
      environmentId: f.m.environmentId,
      kind: copy.kind,
      purpose: 'backup',
      coordinatorEpoch: f.context.epoch,
      objectKey,
      sha256: await bytesDigest(bytes),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 45 * 86400000).toISOString(),
      recoveryEpoch: 0,
      requiredEnvironmentKeyIds: [f.keyring.activeKeyId],
      requiredAccountKeys: copy.kind === 'd1' ? [{ ownerId: f.owner, version: 1 }] : [],
    };
    await env.BACKUP_INVENTORY.put(objectKey, bytes);
    await env.BACKUP_INVENTORY.put(
      f.backups.prefix + 'manifests/' + id + '.json',
      JSON.stringify(await f.backups.sign(manifest)),
    );
    f.backups.index.manifestIds.push(id);
    stored.push({ kind: copy.kind, objectKey });
  }
  await f.attest();
  const inventory = await inventoryKeyReferences(f.runtime, f.context, f.backups.inventory),
    result = await applyKeyRetirement(
      f.runtime,
      f.context,
      f.backups.inventory,
      await planKeyRetirement(f.keyring, inventory, ['unused-retained']),
    );
  f.b.IDENTITY_SECRETS = JSON.stringify(result.candidate);
  let runtime = await createRuntime(f.b);
  for (const copy of stored) {
    const body = await env.BACKUP_INVENTORY.get(copy.objectKey);
    expect(body).not.toBeNull();
    if (copy.kind === 'd1')
      await restoreSnapshot(env.DB, (await body!.json()) as Awaited<ReturnType<typeof snapshot>>);
    else if (copy.kind === 'recovery') {
      for (const object of await objects(env.RECOVERY, '')) await env.RECOVERY.delete(object.key);
      for (const object of (await body!.json()) as { key: string; body: string }[])
        await env.RECOVERY.put(object.key, object.body);
    } else f.b.IDENTITY_SECRETS = await body!.text();
    runtime = await createRuntime(f.b);
    const restore = new OfflineRestore(
      { DB: env.DB, RECOVERY: env.RECOVERY, RESTORE_MODE: 'offline' },
      {
        runtime,
        offline: { coordinator: runtime.coordinator!, context: f.context },
        validateContent: async (hash) => hash === localDevelopmentBundle().editionHash,
      },
    );
    expect((await restore.replay()).status).toBe('verified');
    const encrypted = (await env.DB.prepare('SELECT body_enc FROM reading_editions WHERE id=?')
      .bind(f.created.reading.editionId)
      .first<string>('body_enc'))!;
    expect(
      await runtime.base.crypt.open(
        {
          ownerId: f.owner,
          table: 'reading_editions',
          column: 'body_enc',
          recordId: f.created.reading.editionId,
          aadRevision: 1,
        },
        encrypted,
        Reading,
      ),
    ).toEqual(f.created.reading);
  }
  const closure = await inventoryKeyReferences(runtime, f.context, f.backups.inventory);
  expect(closure.complete).toBe(true);
  const financial = await env.DB.prepare(
    'SELECT state,count(*) n FROM cost_reservations GROUP BY state',
  ).all();
  const validation = {
    version: 1,
    producer: 'restore-validator.v1',
    status: 'passed',
    environmentId: f.m.environmentId,
    operationId: f.context.operationId,
    epoch: f.context.epoch,
    sourceDigest: 'a'.repeat(64),
    configurationDigest: 'b'.repeat(64),
    backupInventoryDigest: closure.manifestDigest,
    recoveryValidationDigest: closure.referenceDigest,
    financialReconciliationDigest: await sha256Json(financial.results),
    validatedAt: new Date().toISOString(),
    generation: 'off',
  };
  const bytes = new TextEncoder().encode(canonicalJson(validation)),
    digest = await bytesDigest(bytes);
  await env.BACKUP_INVENTORY.put('recovery-validation/' + digest + '.json', bytes);
  await env.DB.prepare(
    "UPDATE hosted_coordination SET state='validated',evidence_hash=? WHERE environment_id=?",
  )
    .bind(digest, f.m.environmentId)
    .run();
  await runtime.coordinator!.complete(f.context, digest);
  await runtime.coordinator!.resume(f.context, digest);
  const client = new ReadingClient(f.b, createRuntimeWorker()),
    options = AuthOptions.parse(
      await (await client.request('/auth/options', { purpose: 'authenticate' })).json(),
    );
  const login = await client.request('/auth/authenticate', {
    challengeId: options.challengeId,
    credential: await f.account.passkey.authenticate(
      options,
      encode(uuidBytes(f.owner)),
      1,
      f.m.origin,
    ),
  });
  expect(login.status).toBe(200);
  client.csrf = AuthResult.parse(await login.json()).csrfToken;
  expect(await (await client.request('/readings/' + f.created.reading.editionId)).json()).toEqual(
    f.created.reading,
  );
  expect((await client.me()).permission.modelAllowed).toBe(false);
  const ticket = apiSchemas.ExportTicket.parse(await (await client.request('/exports', {})).json());
  expect(await (await client.request('/exports/' + ticket.id)).text()).toContain(
    f.created.reading.editionId,
  );
  const fresh = new ReadingClient(f.b, createRuntimeWorker()),
    grantResponse = await fresh.request('/auth/recover', {
      recoveryHandle: f.account.kit.recoveryHandle,
      code: f.account.kit.recoveryCodes[0],
    });
  expect(grantResponse.status).toBe(200);
  const grant = apiSchemas.RecoveryGrant.parse(await grantResponse.json()),
    replacement = await syntheticPasskey(),
    finish = await fresh.request('/auth/register', {
      challengeId: grant.challengeId,
      credential: await replacement.register(grant.options, f.m.origin),
    });
  expect(finish.status).toBe(200);
  fresh.csrf = AuthResult.parse(await finish.json()).csrfToken;
  expect((await fresh.me()).subjectId).toBe(f.owner);
  expect(await (await fresh.request('/readings/' + f.created.reading.editionId)).json()).toEqual(
    f.created.reading,
  );
  const current = apiSchemas.SessionRecord.parse(
      await (await fresh.request('/sessions/' + f.created.reading.sessionId)).json(),
    ),
    receiptId = crypto.randomUUID(),
    receiptToken = encode(crypto.getRandomValues(new Uint8Array(32)));
  expect(
    (
      await fresh.request(
        '/sessions/' + current.id,
        { receiptId, receiptToken },
        { method: 'DELETE', revision: current.revision },
      )
    ).status,
  ).toBe(202);
  const { runtimeSecrets } = await import('../fixtures/runtime.ts');
  const next = { ...runtimeSecrets(f.m.environmentId), keyId: 'after-retirement-active' },
    { environment: _, ...bundle } = next;
  f.b.IDENTITY_SECRETS = JSON.stringify({
    ...result.candidate,
    activeKeyId: bundle.keyId,
    keys: [...result.candidate.keys, bundle],
  });
  const status = await new ReadingClient(f.b, createRuntimeWorker()).request(
    '/deletions/' + receiptId,
    undefined,
    { headers: { 'X-Deletion-Token': receiptToken } },
  );
  expect(status.status).toBe(200);
  expect(((await status.json()) as { state: string }).state).toBe('complete');
  expect(await env.DB.prepare('SELECT count(*) n FROM cost_reservations').first('n')).toBe(1);
});

test('account-DEK retirement refuses to replace a changed stable index key', async () => {
  const f = await keyInventoryFixture();
  await f.runtime.coordinator!.complete(f.context, 'a'.repeat(64));
  const rekey = await f.runtime.coordinator!.acquire('rekey'),
    service = new AccountRekey(f.runtime.base, f.runtime.coordinator!, rekey),
    start = await service.begin(f.owner, 1);
  let phase = '';
  while (phase !== 'complete') phase = (await service.step(start.operationId, 20)).phase;
  const replacement = await f.runtime.identity.crypt.createAccountDataVersion(
    f.owner,
    2,
    crypto.getRandomValues(new Uint8Array(32)),
  );
  await env.DB.prepare(
    'UPDATE account_keys SET wrapped_index_key_enc=? WHERE owner_id=? AND version=2',
  )
    .bind(replacement.wrappedIndexKey, f.owner)
    .run();
  await f.runtime.coordinator!.complete(rekey, 'b'.repeat(64));
  const context = await f.runtime.coordinator!.acquire('retirement');
  await f.attest(context);
  const inventory = await inventoryKeyReferences(f.runtime, context, f.backups.inventory),
    plan = await planAccountDataKeyRetirement(inventory, f.owner, 1);
  expect(plan.allowed).toBe(true);
  await expect(
    applyAccountDataKeyRetirement(f.runtime, context, f.backups.inventory, plan),
  ).rejects.toThrow('Stable index');
  expect(await env.DB.prepare('SELECT count(*) n FROM account_keys').first('n')).toBe(2);
});
