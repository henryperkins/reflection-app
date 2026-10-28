import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, expect, test } from 'vitest';
import { keyInventoryFixture } from '../fixtures/key-inventory.ts';
import { clearDatabase } from '../fixtures/database.ts';
import { snapshot, restoreSnapshot } from '../fixtures/snapshot.ts';
import { ErasureLedger, objects } from '../../src/worker/recovery/ledger.ts';
import { OfflineRestore } from '../../src/worker/recovery/restore.ts';
import { rolloverIdentityCheckpoint } from '../../src/worker/recovery/key-inventory.ts';
import { localDevelopmentBundle } from '../../src/worker/readings/local-content.ts';
beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await clearDatabase(env.DB);
  for (const o of await objects(env.RECOVERY, '')) await env.RECOVERY.delete(o.key);
});
function restore(
  f: Awaited<ReturnType<typeof keyInventoryFixture>>,
  bucket = env.RECOVERY,
  includeInventory = true,
) {
  return new OfflineRestore(
    { DB: env.DB, RECOVERY: bucket, RESTORE_MODE: 'offline' },
    {
      runtime: f.runtime,
      offline: { coordinator: f.runtime.coordinator!, context: f.context },
      validateContent: async (hash) => hash === localDevelopmentBundle().editionHash,
      ...(includeInventory ? { backupInventory: f.backups.inventory } : {}),
    },
  );
}
async function erasure(
  f: Awaited<ReturnType<typeof keyInventoryFixture>>,
  scope: 'session' | 'account' = 'session',
) {
  const ledger = new ErasureLedger(env.RECOVERY, f.runtime.identity.crypt),
    id = crypto.randomUUID();
  const target =
    scope === 'account'
      ? { scope, subjectId: f.owner }
      : { scope, subjectId: f.owner, sessionId: f.created.reading.sessionId };
  const intent = await ledger.create(target, id, 'a'.repeat(64), Date.now());
  await ledger.putIntent(intent);
  const chain = await ledger.load(id),
    pass = await ledger.begin(chain);
  await ledger.finish(chain, pass);
  return id;
}
test.each([
  'missing-inventory',
  'missing-index',
  'whole-erasure-chain',
  'latest-checkpoint',
  'consistent-partial-list',
] as const)(
  'hosted replay rejects %s even when an older D1 state looks consistent',
  async (fault) => {
    const f = await keyInventoryFixture(),
      old = await snapshot(env.DB);
    let prefix = '';
    if (fault === 'whole-erasure-chain' || fault === 'consistent-partial-list')
      prefix = 'erasures/v1/' + (await erasure(f)) + '/';
    if (fault === 'latest-checkpoint') {
      await rolloverIdentityCheckpoint(f.runtime, f.context, f.owner);
      prefix = (await env.DB.prepare(
        'SELECT ledger_key FROM security_operations WHERE owner_id=? ORDER BY epoch DESC LIMIT 1',
      )
        .bind(f.owner)
        .first<string>('ledger_key'))!;
    }
    await f.attest();
    await restoreSnapshot(env.DB, old);
    if (fault === 'missing-index')
      await env.BACKUP_INVENTORY.delete(f.backups.prefix + 'index.json');
    if (fault === 'whole-erasure-chain' || fault === 'latest-checkpoint')
      for (const o of await objects(env.RECOVERY, prefix)) await env.RECOVERY.delete(o.key);
    let bucket = env.RECOVERY;
    if (fault === 'consistent-partial-list')
      bucket = new Proxy(bucket, {
        get(target, key) {
          if (key === 'list')
            return async (options: R2ListOptions) => {
              const page = await target.list(options);
              return { ...page, objects: page.objects.filter((o) => !o.key.startsWith(prefix)) };
            };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    await expect(restore(f, bucket, fault !== 'missing-inventory').replay()).rejects.toThrow();
    expect(
      await env.DB.prepare('SELECT restore_in_progress FROM system_state').first(
        'restore_in_progress',
      ),
    ).toBe(1);
    await expect(f.runtime.coordinator!.withWriter(async () => 42)).rejects.toThrow();
  },
);
test.each(['session', 'account'] as const)(
  'verified replay accounts for its own %s erasure appends and checkpoint tombstones',
  async (scope) => {
    const f = await keyInventoryFixture();
    await erasure(f, scope);
    await f.attest();
    expect(await restore(f).replay()).toMatchObject({
      status: 'verified',
      generationEnabled: false,
    });
    expect(
      await env.DB.prepare(
        'SELECT count(*) n FROM reading_editions WHERE body_enc IS NOT NULL',
      ).first('n'),
    ).toBe(0);
  },
);
