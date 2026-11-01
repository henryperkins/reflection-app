import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, expect, test } from 'vitest';
import { apiSchemas, AuthResult } from '../../src/contracts/index.ts';
import worker from '../../src/worker/index.ts';
import { IdentityCrypto, randomToken } from '../../src/worker/identity/crypto.ts';
import { ErasureLedger, objects, DAY } from '../../src/worker/recovery/ledger.ts';
import { OfflineRestore } from '../../src/worker/recovery/restore.ts';
import { clearDatabase } from '../fixtures/database.ts';
import { gate } from '../fixtures/barrier.ts';
import { IDENTITY_SECRETS } from '../fixtures/identity.ts';
import { syntheticPasskey } from '../fixtures/passkeys.ts';
import {
  ReadingClient,
  readingAccount,
  readingBindings,
  login,
} from '../fixtures/reading-client.ts';
import { snapshot, restoreSnapshot } from '../fixtures/snapshot.ts';

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await clearDatabase(env.DB);
  for (const object of await objects(env.RECOVERY, '')) await env.RECOVERY.delete(object.key);
});
const offline = () => ({ ...readingBindings, RESTORE_MODE: 'offline' as const });
const proof = () => ({ receiptId: crypto.randomUUID(), receiptToken: randomToken() });
const ledger = () => new ErasureLedger(env.RECOVERY, new IdentityCrypto(IDENTITY_SECRETS));
async function deletedSession() {
  const { client, kit, passkey } = await readingAccount(),
    { started, reading } = await client.create();
  const saved = await snapshot(env.DB),
    receipt = proof();
  expect(
    (
      await client.request(`/sessions/${started.sessionId}`, receipt, {
        method: 'DELETE',
        revision: 1,
      })
    ).status,
  ).toBe(202);
  return { client, kit, passkey, started, reading, saved, receipt };
}

test('a stale D1 snapshot cannot revive erased content, spent recovery codes, removed credentials, consent or pre-dispatch work', async () => {
  const { client, kit, passkey } = await readingAccount(),
    { started, reading } = await client.create('Synthetic surviving reading');
  const first = apiSchemas.Reflection.parse(
    await (
      await client.request(`/sessions/${started.sessionId}/reflections`, {
        text: 'Synthetic erased revision',
        stance: 'unsure',
        editionId: reading.editionId,
      })
    ).json(),
  );
  const second = apiSchemas.Reflection.parse(
    await (
      await client.request(
        `/reflections/${first.id}`,
        { text: 'Synthetic surviving revision', stance: 'resonates', editionId: reading.editionId },
        { method: 'PUT', revision: 1 },
      )
    ).json(),
  );
  const gone = await client.create('Synthetic deleted session');
  const erasedAccount = await readingAccount();
  await erasedAccount.client.create('Synthetic erased account content');
  const ticket = apiSchemas.ExportTicket.parse(await (await client.request('/exports', {})).json());
  const barrier = gate((sql) => sql.some((s) => s.includes('INSERT INTO provider_dispatches')));
  const waiting = new ReadingClient({ ...readingBindings, DB: barrier.db });
  waiting.cookies = client.cookies;
  waiting.csrf = client.csrf;
  const live = waiting.start('Synthetic request authorized after the bookmark');
  await barrier.ready;
  let saved: Awaited<ReturnType<typeof snapshot>>;
  try {
    saved = await snapshot(env.DB);
  } finally {
    barrier.release();
  }
  const future = apiSchemas.StartResponse.parse(await (await live).json());
  const revisionReceipt = proof(),
    sessionReceipt = proof(),
    accountReceipt = proof();
  expect(
    (
      await client.request(`/reflections/${first.id}/revisions/1`, revisionReceipt, {
        method: 'DELETE',
        revision: 2,
      })
    ).status,
  ).toBe(202);
  expect(
    (
      await client.request(`/sessions/${gone.started.sessionId}`, sessionReceipt, {
        method: 'DELETE',
        revision: 1,
      })
    ).status,
  ).toBe(202);
  expect(
    (await erasedAccount.client.request('/account', accountReceipt, { method: 'DELETE' })).status,
  ).toBe(202);
  const recovered = new ReadingClient();
  const grant = apiSchemas.RecoveryGrant.parse(
    await (
      await recovered.request('/auth/recover', {
        recoveryHandle: kit.recoveryHandle,
        code: kit.recoveryCodes[0],
      })
    ).json(),
  );
  const replacement = await syntheticPasskey();
  const finished = await recovered.request('/auth/register', {
    challengeId: grant.challengeId,
    credential: await replacement.register(grant.options),
  });
  expect(finished.status).toBe(200);
  const replacementKit = AuthResult.parse(await finished.json());
  const operator = new OfflineRestore(offline());
  await operator.prepare();
  await restoreSnapshot(env.DB, saved!);
  expect((await env.DB.prepare('SELECT * FROM deletion_jobs').all()).results).toHaveLength(0);
  const receipt = await operator.replay();
  expect(receipt).toMatchObject({ status: 'verified', generationEnabled: false, erasureJobs: 3 });
  expect(JSON.stringify(receipt)).not.toContain(kit.subjectId);
  expect((await client.request('/me')).status).toBe(401);
  await expect(login(new ReadingClient(), passkey, kit.subjectId)).rejects.toThrow();
  expect(
    (
      await new ReadingClient().request('/auth/recover', {
        recoveryHandle: kit.recoveryHandle,
        code: kit.recoveryCodes[0],
      })
    ).status,
  ).toBe(401);
  const returned = new ReadingClient();
  await login(returned, replacement, replacementKit.subjectId);
  expect((await returned.me()).permission.modelAllowed).toBe(false);
  expect(await (await returned.request(`/readings/${reading.editionId}`)).json()).toEqual(reading);
  expect(await (await returned.request(`/reflections/${first.id}`)).json()).toEqual(second);
  expect((await returned.request(`/reflections/${first.id}?revision=1`)).status).toBe(410);
  expect((await returned.request(`/readings/${gone.reading.editionId}`)).status).toBe(410);
  expect(
    await env.DB.prepare('SELECT id FROM accounts WHERE id=?')
      .bind(erasedAccount.kit.subjectId)
      .first(),
  ).toBeNull();
  expect((await returned.request(`/exports/${ticket.id}`)).status).toBe(404);
  expect(
    await env.DB.prepare('SELECT state FROM generation_requests WHERE id=?')
      .bind(future.requestId)
      .first('state'),
  ).toBe('blocked');
  expect(
    await env.DB.prepare('SELECT id FROM provider_dispatches WHERE request_id=?')
      .bind(future.requestId)
      .first(),
  ).toBeNull();
  expect(
    (await env.DB.prepare("SELECT * FROM quota_reservations WHERE state='held'").all()).results,
  ).toEqual([]);
  expect((await returned.start('Synthetic blocked generation')).status).toBe(403);
  const chain = await ledger().load(sessionReceipt.receiptId);
  expect(chain.passes).toHaveLength(2);
  expect(chain.completion!.backupExpiresBy >= chain.passes[0]!.complete!.backupExpiresBy).toBe(
    true,
  );
});

test('offline mode blocks HTTP and scheduled work and replay requires explicit synthetic offline bindings', async () => {
  const { client } = await readingAccount();
  const controlled = new ReadingClient(offline());
  controlled.cookies = client.cookies;
  expect((await controlled.request('/me')).status).toBe(503);
  const before = await snapshot(env.DB);
  await worker.scheduled({} as ScheduledController, offline(), {} as ExecutionContext);
  expect(await snapshot(env.DB)).toEqual(before);
  expect(() => new OfflineRestore(readingBindings)).toThrow();
});

test('an in-flight private read cannot cross the persistent restore fence', async () => {
  const { client } = await readingAccount(),
    { reading } = await client.create();
  const barrier = gate((sql) => sql.some((s) => s.includes('auth_sessions s JOIN accounts')));
  const waiting = new ReadingClient({ ...readingBindings, DB: barrier.db });
  waiting.cookies = client.cookies;
  waiting.csrf = client.csrf;
  const request = waiting.request(`/readings/${reading.editionId}`);
  await barrier.ready;
  await new OfflineRestore(offline()).prepare();
  barrier.release();
  expect((await request).status).not.toBe(200);
});

test('concurrent local restore runners cannot overlap their replay', async () => {
  await deletedSession();
  let arrived!: () => void, release!: () => void;
  const ready = new Promise<void>((r) => {
      arrived = r;
    }),
    held = new Promise<void>((r) => {
      release = r;
    });
  let pause = true;
  const bucket = new Proxy(env.RECOVERY, {
    get(target, property) {
      if (property === 'list')
        return async (options: R2ListOptions) => {
          if (pause) {
            pause = false;
            arrived();
            await held;
          }
          return target.list(options);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const running = new OfflineRestore({ ...offline(), RECOVERY: bucket }).replay();
  await ready;
  try {
    await expect(new OfflineRestore(offline()).replay()).rejects.toThrow('already running');
  } finally {
    release();
  }
  await expect(running).resolves.toMatchObject({ status: 'verified' });
});

test('repeated restore appends monotonic passes even when the target is absent', async () => {
  const { receipt } = await deletedSession();
  const first = (await ledger().load(receipt.receiptId)).completion!;
  let now = Date.parse(first.erasedAt) + 2 * DAY;
  await new OfflineRestore(offline(), { now: () => now }).replay();
  now += 2 * DAY;
  await new OfflineRestore(offline(), { now: () => now }).replay();
  const chain = await ledger().load(receipt.receiptId);
  expect(chain.passes.map((p) => p.start.revision)).toEqual([1, 2, 3]);
  expect(Date.parse(chain.completion!.backupExpiresBy)).toBe(now + 30 * DAY);
  expect(Date.parse(chain.completion!.purgeAfter)).toBe(now + 45 * DAY);
});

test('an interrupted replay remains offline with a pending pass, then resumes that pass', async () => {
  const { saved, receipt } = await deletedSession();
  await restoreSnapshot(env.DB, saved);
  const failed = new Proxy(env.RECOVERY, {
    get(target, property) {
      if (property === 'put')
        return (key: string, ...rest: unknown[]) => {
          if (key.endsWith('/passes/2/complete.json'))
            throw new Error('Synthetic completion outage');
          return Reflect.apply(target.put, target, [key, ...rest]);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  await expect(new OfflineRestore({ ...offline(), RECOVERY: failed }).replay()).rejects.toThrow();
  expect((await ledger().load(receipt.receiptId)).pending?.revision).toBe(2);
  expect((await new ReadingClient().request('/me')).status).toBe(503);
  await new OfflineRestore(offline()).replay();
  const chain = await ledger().load(receipt.receiptId);
  expect(chain.passes).toHaveLength(2);
  expect(chain.pending).toBeNull();
});

test.each(['gap', 'tamper', 'unexpected', 'missing-checkpoint', 'missing-data-key'] as const)(
  'restore fails closed on %s',
  async (kind) => {
    const { saved, receipt, kit } = await deletedSession();
    await restoreSnapshot(env.DB, saved);
    if (kind === 'gap')
      await env.RECOVERY.delete(`erasures/v1/${receipt.receiptId}/passes/1/start.json`);
    if (kind === 'tamper') {
      const key = `erasures/v1/${receipt.receiptId}/intent.json`;
      const value = JSON.parse(await (await env.RECOVERY.get(key))!.text());
      value.operationMac = '0'.repeat(64);
      await env.RECOVERY.put(key, JSON.stringify(value));
    }
    if (kind === 'unexpected')
      await env.RECOVERY.put(`erasures/v1/${receipt.receiptId}/unknown.json`, '{}');
    if (kind === 'missing-checkpoint')
      for (const item of await objects(env.RECOVERY, 'identity/'))
        await env.RECOVERY.delete(item.key);
    if (kind === 'missing-data-key')
      await env.DB.prepare("UPDATE account_keys SET wrapped_key_enc='unavailable' WHERE owner_id=?")
        .bind(kit.subjectId)
        .run();
    await expect(new OfflineRestore(offline()).replay()).rejects.toThrow();
    expect((await new ReadingClient().request('/me')).status).toBe(503);
  },
);

test('retained recovery keys authenticate old ledger objects; a missing named key blocks replay', async () => {
  const { client, kit } = await readingAccount();
  const old = new IdentityCrypto({
    ...IDENTITY_SECRETS,
    keyId: 'retained-test-key',
    recoveryKey: randomToken(),
    hmacKey: randomToken(),
  });
  const oldLedger = new ErasureLedger(env.RECOVERY, old);
  const target = {
    scope: 'session' as const,
    subjectId: kit.subjectId,
    sessionId: crypto.randomUUID(),
  };
  const intent = await oldLedger.create(target, crypto.randomUUID(), null, Date.now());
  await oldLedger.putIntent(intent);
  await expect(new OfflineRestore(offline()).replay()).rejects.toThrow();
  await new OfflineRestore(offline(), { retainedKeys: [old.secrets] }).replay();
  expect(
    (
      await new ErasureLedger(env.RECOVERY, new IdentityCrypto(IDENTITY_SECRETS), [old]).load(
        intent.jobId,
      )
    ).completion?.revision,
  ).toBe(1);
  expect((await client.request('/me')).status).toBe(401);
});

test('restore processes every ledger page and exhausts uncertain spend rather than resetting it', async () => {
  const { kit } = await readingAccount();
  const journal = ledger();
  for (let i = 0; i < 34; i++) {
    const intent = await journal.create(
      { scope: 'session', subjectId: kit.subjectId, sessionId: crypto.randomUUID() },
      crypto.randomUUID(),
      null,
      Date.now(),
    );
    await journal.putIntent(intent);
    const chain = await journal.load(intent.jobId),
      pass = await journal.begin(chain);
    await journal.finish(chain, pass);
  }
  await env.DB.prepare("INSERT INTO spend_buckets VALUES ('day-synthetic',40000,123)").run();
  const pageSizes: number[] = [];
  const bucket = new Proxy(env.RECOVERY, {
    get(target, property) {
      if (property === 'list')
        return async (options: R2ListOptions) => {
          pageSizes.push(options.limit!);
          return target.list(options);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const receipt = await new OfflineRestore({ ...offline(), RECOVERY: bucket }).replay();
  expect(receipt.erasureJobs).toBe(34);
  expect(pageSizes.every((n) => n <= 100)).toBe(true);
  expect(
    await env.DB.prepare(
      "SELECT committed_microusd FROM spend_buckets WHERE period='day-synthetic'",
    ).first('committed_microusd'),
  ).toBe(40000);
  for (const object of await objects(env.RECOVERY, 'erasures/'))
    expect(object.key).not.toContain(kit.subjectId);
});

test('session erasure replay removes current and historical notes on two stale restores', async () => {
  const { client } = await readingAccount(),
    { reading, started } = await client.create();
  expect(
    (
      await client.request(
        `/sessions/${started.sessionId}/save`,
        { saved: true },
        { method: 'PUT', revision: 1 },
      )
    ).status,
  ).toBe(200);
  const note = apiSchemas.Revisit.parse(
    await (
      await client.request('/revisits', { editionId: reading.editionId, note: 'Before edit' })
    ).json(),
  );
  expect(
    (
      await client.request(
        `/revisits/${note.id}`,
        { note: 'After edit' },
        { method: 'PUT', revision: 1 },
      )
    ).status,
  ).toBe(200);
  const saved = await snapshot(env.DB),
    receipt = proof();
  expect(
    (
      await client.request(`/sessions/${started.sessionId}`, receipt, {
        method: 'DELETE',
        revision: 2,
      })
    ).status,
  ).toBe(202);
  const initial = (await ledger().load(receipt.receiptId)).completion!;
  for (let i = 0; i < 2; i++) {
    const runner = new OfflineRestore(offline());
    await runner.prepare();
    await restoreSnapshot(env.DB, saved);
    await runner.replay();
    expect(
      await env.DB.prepare('SELECT id FROM revisits WHERE id=?').bind(note.id).first(),
    ).toBeNull();
    expect(
      await env.DB.prepare('SELECT revisit_id FROM revisit_revisions WHERE revisit_id=?')
        .bind(note.id)
        .first(),
    ).toBeNull();
    const chain = await ledger().load(receipt.receiptId);
    expect(chain.passes).toHaveLength(i + 2);
    expect(chain.completion!.backupExpiresBy >= initial.backupExpiresBy).toBe(true);
  }
});
