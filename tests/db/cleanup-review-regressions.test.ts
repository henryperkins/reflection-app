import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, expect, test } from 'vitest';
import { OfflineCleanup } from '../../src/worker/recovery/cleanup.ts';
import { OfflineRestore } from '../../src/worker/recovery/restore.ts';
import { objects } from '../../src/worker/recovery/ledger.ts';
import { clearDatabase } from '../fixtures/database.ts';
import { snapshot, restoreSnapshot } from '../fixtures/snapshot.ts';
import { ReadingClient, readingAccount, readingBindings } from '../fixtures/reading-client.ts';
import { cleanupBindings, localBackup, historicalDeletion } from '../fixtures/cleanup.ts';
import { sha256Json } from '../../src/domain/json.ts';
import { localIdentity } from '../../src/worker/identity/routes.ts';
import { LocalGeneration } from '../../src/worker/readings/local-generation.ts';
import { RecordBase } from '../../src/worker/readings/base.ts';
import { gate } from '../fixtures/barrier.ts';
beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await clearDatabase(env.DB);
  for (const o of await objects(env.RECOVERY, '')) await env.RECOVERY.delete(o.key);
});

test('cleanup backup excludes an already admitted generation failure writer', async () => {
  await historicalDeletion();
  const account = await readingAccount();
  const paused = gate((sql) => sql.some((s) => s.includes('INSERT INTO reading_editions')));
  const client = new ReadingClient({ ...readingBindings, DB: paused.db });
  client.cookies = account.client.cookies;
  client.csrf = account.client.csrf;
  const pending = client.start('Synthetic in-flight snapshot request');
  await paused.ready;
  const backup = localBackup();
  let released = false;
  const snapshotDB = new Proxy(env.DB, {
    get(target, property) {
      if (property === 'prepare')
        return (sql: string) => {
          const stmt = target.prepare(sql);
          if (sql === 'SELECT * FROM "quota_buckets"')
            return new Proxy(stmt, {
              get(s, p) {
                if (p === 'all')
                  return async () => {
                    const result = await s.all();
                    released = true;
                    paused.release();
                    await pending;
                    return result;
                  };
                const value = Reflect.get(s, p, s);
                return typeof value === 'function' ? value.bind(s) : value;
              },
            });
          return stmt;
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  try {
    await new OfflineCleanup(cleanupBindings(), {
      ...backup,
      capture: (_db, epoch) => backup.capture(snapshotDB, epoch),
    }).run();
  } finally {
    if (!released) paused.release();
  }
  await pending;
  const saved = [...backup.snapshots.values()][0]!;
  await restoreSnapshot(env.DB, saved);
  await new OfflineRestore(cleanupBindings()).replay();
  const quota = (
    await env.DB.prepare('SELECT held FROM quota_buckets WHERE owner_id=?')
      .bind(account.kit.subjectId)
      .all()
  ).results;
  expect(quota).toEqual([{ held: 0 }, { held: 0 }]);
});

test('cleanup cannot reopen an unreplayed snapshot while recent erasure evidence is retained', async () => {
  const deleted = await historicalDeletion('session', 44);
  await restoreSnapshot(env.DB, deleted.before);
  await new OfflineRestore(cleanupBindings()).fence();
  await expect(new OfflineCleanup(cleanupBindings(), localBackup()).run()).rejects.toThrow(
    /not erased/i,
  );
  const reopened = await deleted.client.request(`/readings/${deleted.reading.editionId}`);
  expect(reopened.status).not.toBe(200);
});

test('successful cleanup keeps access offline until the full restore checks pass', async () => {
  await historicalDeletion();
  expect((await new OfflineCleanup(cleanupBindings(), localBackup()).run()).purgedObjects).toBe(3);
  expect(
    await env.DB.prepare('SELECT restore_in_progress FROM system_state').first(
      'restore_in_progress',
    ),
  ).toBe(1);
  await new OfflineRestore(cleanupBindings()).replay();
  expect(
    await env.DB.prepare('SELECT restore_in_progress FROM system_state').first(
      'restore_in_progress',
    ),
  ).toBe(0);
});

test('an already-running generation cannot initialize catalog state across the offline fence', async () => {
  const account = await readingAccount();
  const paused = gate((sql) =>
    sql.some((s) => s.includes('INSERT OR IGNORE INTO content_editions')),
  );
  const client = new ReadingClient({ ...readingBindings, DB: paused.db });
  client.cookies = account.client.cookies;
  client.csrf = account.client.csrf;
  const pending = client.start('Synthetic paused initialization');
  await paused.ready;
  try {
    await new OfflineRestore(cleanupBindings()).fence();
  } finally {
    paused.release();
  }
  expect((await pending).status).not.toBe(202);
  expect(await env.DB.prepare('SELECT count(*) AS n FROM content_editions').first('n')).toBe(0);
});

test('already-running generation expiry cannot change quotas across the offline fence', async () => {
  const account = await readingAccount();
  const writer = gate((sql) => sql.some((s) => s.includes('INSERT INTO reading_editions')));
  const client = new ReadingClient({ ...readingBindings, DB: writer.db });
  client.cookies = account.client.cookies;
  client.csrf = account.client.csrf;
  const pending = client.start('Synthetic paused expiry');
  await writer.ready;
  await env.DB.prepare('UPDATE generation_requests SET created_at=1,expires_at=2').run();
  const paused = gate((sql) => sql.some((s) => s.includes('UPDATE quota_buckets')));
  const maintenance = new LocalGeneration(
    new RecordBase(paused.db, localIdentity({ ...readingBindings, DB: paused.db })!),
  ).maintenance();
  await paused.ready;
  try {
    await new OfflineRestore(cleanupBindings()).fence();
    paused.release();
    await expect(maintenance).rejects.toThrow();
    expect(await env.DB.prepare('SELECT state FROM quota_reservations').first('state')).toBe(
      'held',
    );
  } finally {
    paused.release();
    writer.release();
    await pending;
  }
});

test.each(['rate', 'challenge', 'issue', 'touch', 'logout', 'checkpoint retry'])(
  'identity %s cannot mutate a fenced backup',
  async (action) => {
    const account = await readingAccount(),
      identity = localIdentity(readingBindings)!;
    const token = account.client.cookies.get('__Host-session')!;
    const session = await identity.sessions.get(token);
    if (action === 'touch')
      await env.DB.prepare(
        "UPDATE auth_sessions SET idle_expires_at=CAST(unixepoch('subsec')*1000 AS INTEGER)+3600000",
      ).run();
    if (action === 'checkpoint retry')
      await env.DB.prepare("UPDATE security_operations SET state='fenced',next_run_at=1").run();
    await new OfflineRestore(cleanupBindings()).fence();
    const before = await sha256Json(await snapshot(env.DB));
    try {
      if (action === 'rate') await identity.rate('synthetic-fenced', 'loopback', 10, 60000);
      if (action === 'challenge') await identity.begin('authenticate');
      if (action === 'issue') await identity.sessions.issue(session.subjectId, session.epoch);
      if (action === 'touch') await identity.sessions.get(token);
      if (action === 'logout') await identity.sessions.logout(session);
      if (action === 'checkpoint retry') await identity.maintenance();
    } catch {
      /* Offline refusal is expected; the database must remain unchanged. */
    }
    expect(await sha256Json(await snapshot(env.DB))).toBe(before);
  },
);
