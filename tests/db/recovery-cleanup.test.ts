import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, expect, test } from 'vitest';
import { OfflineCleanup } from '../../src/worker/recovery/cleanup.ts';
import { OfflineRestore } from '../../src/worker/recovery/restore.ts';
import { CLEANUP_STATE_KEY } from '../../src/worker/recovery/cleanup-state.ts';
import { IdentityCrypto } from '../../src/worker/identity/crypto.ts';
import { localIdentity } from '../../src/worker/identity/routes.ts';
import { ErasureLedger, objects, DAY } from '../../src/worker/recovery/ledger.ts';
import { clearDatabase } from '../fixtures/database.ts';
import { restoreSnapshot } from '../fixtures/snapshot.ts';
import {
  ReadingClient,
  readingAccount,
  readingBindings,
  login,
} from '../fixtures/reading-client.ts';
import { IDENTITY_SECRETS } from '../fixtures/identity.ts';
import {
  cleanupBindings,
  cleanupLedger,
  localBackup,
  historicalDeletion,
  historicalCheckpoints,
  historicalPasses,
} from '../fixtures/cleanup.ts';

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await clearDatabase(env.DB);
  for (const item of await objects(env.RECOVERY, '')) await env.RECOVERY.delete(item.key);
});
const offline = () =>
  env.DB.prepare('SELECT restore_in_progress FROM system_state WHERE id=1').first<number>(
    'restore_in_progress',
  );
const sweep = (backup = localBackup()) => new OfflineCleanup(cleanupBindings(), backup).run();

test('expired erasure evidence is purged only after a verified new backup and earlier snapshots cannot reopen', async () => {
  const deleted = await historicalDeletion();
  const backup = localBackup();
  const result = await sweep(backup);
  expect(result).toMatchObject({ status: 'complete', purgedObjects: 3, recoveryEpoch: 1 });
  expect(await objects(env.RECOVERY, 'erasures/')).toHaveLength(0);
  expect(await env.DB.prepare('SELECT * FROM deletion_jobs').all()).toMatchObject({ results: [] });
  const state = await (await env.RECOVERY.get(CLEANUP_STATE_KEY))!.text();
  expect(state).not.toContain(deleted.proof.receiptId);
  expect(state).not.toContain(deleted.kit.subjectId);
  await restoreSnapshot(env.DB, deleted.before);
  await expect(new OfflineRestore(cleanupBindings()).replay()).rejects.toThrow(/epoch|older/i);
  expect(await offline()).toBe(1);
  const latest = [...backup.snapshots.values()][0]!;
  await restoreSnapshot(env.DB, latest);
  await expect(new OfflineRestore(cleanupBindings()).replay()).resolves.toMatchObject({
    status: 'verified',
  });
  const returned = new ReadingClient();
  await login(returned, deleted.passkey, deleted.kit.subjectId);
  expect((await returned.request(`/readings/${deleted.reading.editionId}`)).status).toBe(410);
  expect((await returned.me()).permission.modelAllowed).toBe(false);
});

test('an unexpired or newly extended completion remains retained', async () => {
  const deleted = await historicalDeletion('session', 44);
  expect((await sweep()).purgedObjects).toBe(0);
  const ledger = cleanupLedger(),
    chain = await ledger.load(deleted.proof.receiptId);
  const pass = await ledger.begin(chain, Date.now());
  await ledger.finish(chain, pass, Date.now());
  expect((await sweep()).purgedObjects).toBe(0);
  expect(await objects(env.RECOVERY, 'erasures/')).toHaveLength(5);
});

test('a later pending pass blocks cleanup even when D1 retains an older complete projection', async () => {
  const deleted = await historicalDeletion();
  const ledger = cleanupLedger();
  await ledger.begin(await ledger.load(deleted.proof.receiptId));
  await expect(sweep()).rejects.toThrow(/pending/i);
  expect(await objects(env.RECOVERY, 'erasures/')).toHaveLength(4);
  expect(await offline()).toBe(1);
});

test('old superseded checkpoints retire while current factors and the latest checkpoint survive', async () => {
  const { kit, client, passkey } = await readingAccount();
  const { reading } = await client.create();
  const ops = await historicalCheckpoints(kit.subjectId);
  const latest = ops.at(-1)!;
  const result = await sweep();
  expect(result.purgedObjects).toBe(ops.length - 1);
  expect((await objects(env.RECOVERY, 'identity/')).map((o) => o.key)).toEqual([latest.ledger_key]);
  await new OfflineRestore(cleanupBindings()).replay();
  await login(client, passkey, kit.subjectId);
  await localIdentity(readingBindings)!.checkpoints.apply(ops[0]!.id);
  expect(await env.RECOVERY.head(ops[0]!.ledger_key)).toBeNull();
  expect(await (await client.request(`/readings/${reading.editionId}`)).json()).toEqual(reading);
  expect(await env.DB.prepare('SELECT count(*) AS n FROM recovery_codes').first('n')).toBe(10);
});

test('supersession starts the old-checkpoint retention window', async () => {
  const { kit } = await readingAccount();
  const ops = await historicalCheckpoints(kit.subjectId, 10);
  expect((await sweep()).purgedObjects).toBe(0);
  expect(await objects(env.RECOVERY, 'identity/')).toHaveLength(ops.length);
});

test('deleted-account empty checkpoint markers retire with qualifying erasure evidence', async () => {
  const { kit, proof } = await historicalDeletion('account');
  const before = await objects(env.RECOVERY, 'identity/');
  expect(before.length).toBeGreaterThan(0);
  expect(before.every((o) => o.size === 0)).toBe(true);
  const result = await sweep();
  expect(result.purgedObjects).toBe(3 + before.length);
  expect(await objects(env.RECOVERY, 'identity/')).toHaveLength(0);
  expect(await objects(env.RECOVERY, `erasures/v1/${proof.receiptId}/`)).toHaveLength(0);
  expect(
    await env.DB.prepare('SELECT id FROM accounts WHERE id=?').bind(kit.subjectId).first(),
  ).toBeNull();
});

test.each(['gap', 'tamper', 'unknown key'])('%s prevents any recovery purge', async (failure) => {
  const { proof } = await historicalDeletion();
  const path = `erasures/v1/${proof.receiptId}/`;
  if (failure === 'gap') await env.RECOVERY.delete(`${path}passes/1/start.json`);
  else if (failure === 'tamper') {
    const key = `${path}intent.json`,
      raw = JSON.parse(await (await env.RECOVERY.get(key))!.text());
    raw.operationMac = '0'.repeat(64);
    await env.RECOVERY.put(key, JSON.stringify(raw));
  } else {
    const crypt = new IdentityCrypto({ ...IDENTITY_SECRETS, keyId: 'unavailable' }),
      ledger = new ErasureLedger(env.RECOVERY, crypt);
    await ledger.putIntent(
      await ledger.create(
        { scope: 'account', subjectId: crypto.randomUUID() },
        crypto.randomUUID(),
        null,
        Date.now() - 50 * DAY,
      ),
    );
  }
  const before = (await objects(env.RECOVERY, 'erasures/')).map((o) => ({
    key: o.key,
    etag: o.etag,
  }));
  await expect(sweep()).rejects.toThrow();
  expect(
    (await objects(env.RECOVERY, 'erasures/')).map((o) => ({ key: o.key, etag: o.etag })),
  ).toEqual(before);
  expect(await offline()).toBe(1);
});

test('failed backup verification cannot delete recovery evidence', async () => {
  await historicalDeletion();
  const backup = localBackup();
  await expect(sweep({ ...backup, verify: async () => false })).rejects.toThrow(/backup/i);
  expect(await objects(env.RECOVERY, 'erasures/')).toHaveLength(3);
  expect(await offline()).toBe(1);
});

test('an interrupted purge blocks restore and resumes its exact durable plan', async () => {
  await historicalDeletion();
  const backup = localBackup();
  let deleted = 0;
  const bucket = new Proxy(env.RECOVERY, {
    get(target, property) {
      if (property === 'delete')
        return async (key: string) => {
          if (key.startsWith('erasures/') && ++deleted === 2)
            throw new Error('Synthetic purge interruption');
          return target.delete(key);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  await expect(
    new OfflineCleanup({ ...cleanupBindings(), RECOVERY: bucket }, backup).run(),
  ).rejects.toThrow();
  expect(await objects(env.RECOVERY, 'erasures/')).toHaveLength(2);
  expect(await offline()).toBe(1);
  await expect(new OfflineRestore(cleanupBindings()).replay()).rejects.toThrow(/cleanup|purge/i);
  const result = await sweep(backup);
  expect(result).toMatchObject({ status: 'complete', recoveryEpoch: 1, purgedObjects: 3 });
  expect(backup.snapshots.size).toBe(1);
  expect(await objects(env.RECOVERY, 'erasures/')).toHaveLength(0);
  expect(await offline()).toBe(1);
  await new OfflineRestore(cleanupBindings()).replay();
  expect(await offline()).toBe(0);
});

test('a changed planned object leaves interrupted purge offline', async () => {
  const { proof } = await historicalDeletion();
  const backup = localBackup();
  const bucket = new Proxy(env.RECOVERY, {
    get(target, property) {
      if (property === 'delete')
        return () => {
          throw new Error('Synthetic delete unavailable');
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  await expect(
    new OfflineCleanup({ ...cleanupBindings(), RECOVERY: bucket }, backup).run(),
  ).rejects.toThrow();
  await env.RECOVERY.put(`erasures/v1/${proof.receiptId}/intent.json`, 'changed');
  await expect(sweep(backup)).rejects.toThrow(/changed|mismatch/i);
  expect(await offline()).toBe(1);
});

test('a delayed checkpoint writer prevents cleanup from retiring its immutable key', async () => {
  const { client } = await readingAccount(false, false);
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>((r) => {
      entered = r;
    }),
    held = new Promise<void>((r) => {
      release = r;
    });
  const bucket = new Proxy(env.RECOVERY, {
    get(target, property) {
      if (property === 'put')
        return async (key: string, ...rest: unknown[]) => {
          if (key.startsWith('identity/')) {
            entered();
            await held;
          }
          return Reflect.apply(target.put, target, [key, ...rest]);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const waiting = new ReadingClient({ ...readingBindings, RECOVERY: bucket });
  waiting.cookies = client.cookies;
  waiting.csrf = client.csrf;
  const acknowledgement = waiting.request('/auth/recovery/ack', {});
  await ready;
  try {
    await expect(sweep()).rejects.toThrow(/running|writer|busy/i);
  } finally {
    release();
  }
  expect((await acknowledgement).status).toBe(204);
});

test('cleanup and restore cannot overlap even through a different binding wrapper', async () => {
  await historicalDeletion();
  const backup = localBackup();
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>((r) => {
      entered = r;
    }),
    held = new Promise<void>((r) => {
      release = r;
    });
  const pending = sweep({
    ...backup,
    capture: async (db, epoch) => {
      entered();
      await held;
      return backup.capture(db, epoch);
    },
  });
  await Promise.race([
    ready,
    pending.then(() => {
      throw new Error('Cleanup ended before capture');
    }),
  ]);
  try {
    await expect(
      new OfflineRestore({ ...cleanupBindings(), DB: new Proxy(env.DB, {}) }).replay(),
    ).rejects.toThrow(/running|busy/i);
  } finally {
    release();
  }
  await pending;
});

test('cleanup inventories all pages of a long authenticated pass chain', async () => {
  const { proof } = await historicalDeletion();
  await historicalPasses(proof.receiptId, 52);
  expect(await objects(env.RECOVERY, 'erasures/')).toHaveLength(105);
  const result = await sweep();
  expect(result.purgedObjects).toBe(105);
  expect(await objects(env.RECOVERY, 'erasures/')).toHaveLength(0);
});

test('a complete D1 projection cannot substitute for a missing independent erasure chain', async () => {
  const { proof } = await historicalDeletion();
  for (const object of await objects(env.RECOVERY, `erasures/v1/${proof.receiptId}/`))
    await env.RECOVERY.delete(object.key);
  await expect(sweep()).rejects.toThrow(/missing|inventory/i);
  expect(await offline()).toBe(1);
});

test('unavailable account data keys block retirement of older recovery evidence', async () => {
  await historicalDeletion();
  await env.DB.prepare("UPDATE account_keys SET wrapped_key_enc='unavailable'").run();
  await expect(sweep()).rejects.toThrow();
  expect(await objects(env.RECOVERY, 'erasures/')).toHaveLength(3);
  expect(await offline()).toBe(1);
});

test('a failed cleanup journal write preserves evidence and rolls back the unannounced epoch', async () => {
  const { proof } = await historicalDeletion();
  const backup = localBackup();
  const bucket = new Proxy(env.RECOVERY, {
    get(target, property) {
      if (property === 'put')
        return async (key: string, ...args: unknown[]) => {
          if (key === CLEANUP_STATE_KEY) throw new Error('Synthetic journal unavailable');
          return Reflect.apply(target.put, target, [key, ...args]);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  await expect(
    new OfflineCleanup({ ...cleanupBindings(), RECOVERY: bucket }, backup).run(),
  ).rejects.toThrow(/journal/i);
  expect(await objects(env.RECOVERY, 'erasures/')).toHaveLength(3);
  expect(
    await env.DB.prepare('SELECT recovery_epoch FROM system_state').first('recovery_epoch'),
  ).toBe(0);
  expect(
    await env.DB.prepare('SELECT state FROM deletion_jobs WHERE id=?')
      .bind(proof.receiptId)
      .first('state'),
  ).toBe('complete');
  expect(await offline()).toBe(1);
  expect((await sweep(backup)).purgedObjects).toBe(3);
});

test('a lost pending-journal response preserves the epoch and resumes the published plan', async () => {
  await historicalDeletion();
  const backup = localBackup();
  const bucket = new Proxy(env.RECOVERY, {
    get(target, property) {
      if (property === 'put')
        return async (key: string, ...args: unknown[]) => {
          const result = await Reflect.apply(target.put, target, [key, ...args]);
          if (key === CLEANUP_STATE_KEY) throw new Error('Synthetic response lost');
          return result;
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  await expect(
    new OfflineCleanup({ ...cleanupBindings(), RECOVERY: bucket }, backup).run(),
  ).rejects.toThrow(/lost/i);
  expect(
    await env.DB.prepare('SELECT recovery_epoch FROM system_state').first('recovery_epoch'),
  ).toBe(1);
  expect(await objects(env.RECOVERY, 'erasures/')).toHaveLength(3);
  expect((await sweep(backup)).purgedObjects).toBe(3);
  expect(backup.snapshots.size).toBe(1);
});

test.each(['missing', 'tampered'])(
  '%s cleanup floor cannot authorize a post-purge restore',
  async (failure) => {
    await historicalDeletion();
    await sweep();
    if (failure === 'missing') await env.RECOVERY.delete(CLEANUP_STATE_KEY);
    else {
      const state = JSON.parse(await (await env.RECOVERY.get(CLEANUP_STATE_KEY))!.text());
      state.epoch++;
      await env.RECOVERY.put(CLEANUP_STATE_KEY, JSON.stringify(state));
    }
    await expect(new OfflineRestore(cleanupBindings()).replay()).rejects.toThrow();
    expect(await offline()).toBe(1);
  },
);

test('expired evidence is retained when the supposedly erased private body is present again', async () => {
  const { started } = await historicalDeletion();
  await env.DB.prepare(
    "UPDATE reading_sessions SET question_enc='unverified restored private bytes' WHERE id=?",
  )
    .bind(started.sessionId)
    .run();
  await expect(sweep()).rejects.toThrow(/not erased/i);
  expect(await objects(env.RECOVERY, 'erasures/')).toHaveLength(3);
  expect(await offline()).toBe(1);
});

test('an over-bound chain stays whole while another eligible group is purged', async () => {
  const large = await historicalDeletion(),
    small = await historicalDeletion();
  await historicalPasses(large.proof.receiptId, 500);
  const result = await sweep();
  expect(result.purgedObjects).toBe(3);
  expect(await objects(env.RECOVERY, `erasures/v1/${large.proof.receiptId}/`)).toHaveLength(1001);
  expect(await objects(env.RECOVERY, `erasures/v1/${small.proof.receiptId}/`)).toHaveLength(0);
  expect((await cleanupLedger().load(large.proof.receiptId)).completion?.revision).toBe(500);
}, 30000);
