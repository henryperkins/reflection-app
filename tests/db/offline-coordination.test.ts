import { env } from 'cloudflare:workers';
import { applyD1Migrations, runInDurableObject } from 'cloudflare:test';
import { beforeAll, expect, test } from 'vitest';
import {
  HostedCoordinator,
  type OfflineControl,
} from '../../src/worker/recovery/hosted-coordinator.ts';
import { ProtectedBackupInventory } from '../../src/worker/recovery/backup-inventory.ts';

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
const secret = 'synthetic-offline-control-token-not-a-deployed-secret';
function clients() {
  const environment = 'coord-' + crypto.randomUUID();
  return {
    environment,
    a: new HostedCoordinator(env.OFFLINE_COORDINATOR, secret, environment),
    b: new HostedCoordinator(env.OFFLINE_COORDINATOR, secret, environment),
  };
}

test('independent clients close ingress and drain a delayed writer before offline work', async () => {
  const { a, b } = clients();
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>((r) => (entered = r));
  const running = a.withWriter(async () => {
    entered();
    await new Promise<void>((r) => (release = r));
  });
  await ready;
  const lease = await b.acquire('restore');
  await expect(b.assertCurrent(lease)).rejects.toThrow();
  await expect(a.withWriter(async () => {})).rejects.toThrow();
  await expect(a.acquire('cleanup')).rejects.toThrow();
  release();
  await running;
  await b.assertCurrent(lease);
  await b.complete(lease, 'a'.repeat(64));
  await expect(a.withWriter(async () => {})).rejects.toThrow();
  await expect(b.resume(lease, 'a'.repeat(64))).rejects.toThrow();
});

test('epoch survives D1 rollback and a stale operator cannot write after a new epoch', async () => {
  const { a, b, environment } = clients();
  const first = await a.acquire('restore');
  await a.assertCurrent(first);
  await runInDurableObject(
    env.OFFLINE_COORDINATOR.getByName(environment),
    async (_: OfflineControl, state) => {
      state.storage.sql.exec('UPDATE control SET expires_at=1');
    },
  );
  const next = await b.acquire('rekey');
  expect(next.epoch).toBeGreaterThan(first.epoch);
  await env.DB.prepare('DELETE FROM hosted_coordination WHERE environment_id=?')
    .bind(environment)
    .run();
  await b.assertCurrent(next);
  await expect(a.assertCurrent(first)).rejects.toThrow();
  await expect(a.withOffline(first, async () => {})).rejects.toThrow();
  await expect(a.complete(first, 'b'.repeat(64))).rejects.toThrow();
});

test('an outstanding offline mutation cannot be assumed dead when its lease expires', async () => {
  const { a, b, environment } = clients();
  const lease = await a.acquire('cleanup');
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>((r) => (entered = r));
  const running = a.withOffline(lease, async () => {
    entered();
    await new Promise<void>((r) => (release = r));
  });
  await ready;
  await runInDurableObject(
    env.OFFLINE_COORDINATOR.getByName(environment),
    async (_: OfflineControl, state) => {
      state.storage.sql.exec('UPDATE control SET expires_at=1');
    },
  );
  await expect(b.acquire('restore')).rejects.toThrow();
  release();
  await expect(running).rejects.toThrow();
  const next = await b.acquire('restore');
  await b.assertCurrent(next);
});

test('invalid operator secrets and cross-environment contexts never establish authority', async () => {
  const { a, environment } = clients();
  const wrong = new HostedCoordinator(env.OFFLINE_COORDINATOR, 'wrong-secret', environment);
  await expect(wrong.acquire('restore')).rejects.toThrow();
  const lease = await a.acquire('restore');
  await expect(a.assertCurrent({ ...lease, environmentId: 'wrong-environment' })).rejects.toThrow();
  await expect(a.complete(lease, 'not-a-digest')).rejects.toThrow();
});

test('abandoned writer registrations survive coordinator instance replacement and do not expire open', async () => {
  const { a, b, environment } = clients();
  const stub = env.OFFLINE_COORDINATOR.getByName(environment);
  await stub.registerWriter(secret, environment, 'abandoned-writer');
  const lease = await a.acquire('restore');
  await expect(b.assertCurrent(lease)).rejects.toThrow();
  await runInDurableObject(stub, async (_: OfflineControl, state) => {
    expect(state.storage.sql.exec('SELECT count(*) n FROM writers').one().n).toBe(1);
  });
  await expect(b.withWriter(async () => {})).rejects.toThrow();
});

test('missing independent inventory and a listing without a signed complete index fail closed', async () => {
  const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const missing = new ProtectedBackupInventory(undefined, 'missing-inventory', keys.publicKey);
  await expect(missing.list()).rejects.toThrow();
  const absentIndex = new ProtectedBackupInventory(
    env.BACKUP_INVENTORY,
    'absent-' + crypto.randomUUID(),
    keys.publicKey,
  );
  await expect(absentIndex.list()).rejects.toThrow();
});

test('resume requires byte-verified recovery evidence and a matching validated database epoch, and retains generation off', async () => {
  const { a, environment } = clients(),
    lease = await a.acquire('restore');
  const evidence = {
    version: 1,
    producer: 'restore-validator.v1',
    status: 'passed',
    environmentId: environment,
    operationId: lease.operationId,
    epoch: lease.epoch,
    sourceDigest: 'a'.repeat(64),
    configurationDigest: 'b'.repeat(64),
    backupInventoryDigest: 'c'.repeat(64),
    recoveryValidationDigest: 'd'.repeat(64),
    financialReconciliationDigest: 'e'.repeat(64),
    validatedAt: new Date().toISOString(),
    generation: 'off',
  };
  const { bytesDigest } = await import('../../src/worker/recovery/hosted-coordinator.ts');
  const bytes = new TextEncoder().encode(JSON.stringify(evidence)),
    digest = await bytesDigest(bytes);
  await env.BACKUP_INVENTORY.put('recovery-validation/' + digest + '.json', bytes);
  await a.complete(lease, digest);
  await expect(a.resume(lease, digest)).rejects.toThrow();
  await env.DB.prepare("INSERT INTO hosted_coordination VALUES(?,?,'validated',?,?)")
    .bind(environment, lease.epoch, digest, Date.now())
    .run();
  await env.DB.prepare(
    "INSERT INTO system_state(id,provider_policy_hash,restore_in_progress,generation_enabled,dispatch_mode,updated_at) VALUES(1,?,1,0,'off',?) ON CONFLICT(id) DO UPDATE SET restore_in_progress=1,generation_enabled=0,dispatch_mode='off'",
  )
    .bind('0'.repeat(64), Date.now())
    .run();
  await a.resume(lease, digest);
  await expect(a.withWriter(async () => 42)).resolves.toBe(42);
  await expect(a.assertCurrent(lease)).rejects.toThrow();
});
