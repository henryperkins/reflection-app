import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, expect, test } from 'vitest';
import { apiSchemas } from '../../src/contracts/index.ts';
import worker from '../../src/worker/index.ts';
import { IdentityCrypto, randomToken } from '../../src/worker/identity/crypto.ts';
import { localIdentity } from '../../src/worker/identity/routes.ts';
import { ErasureLedger, objects } from '../../src/worker/recovery/ledger.ts';
import { OfflineRestore } from '../../src/worker/recovery/restore.ts';
import { clearDatabase } from '../fixtures/database.ts';
import { IDENTITY_SECRETS } from '../fixtures/identity.ts';
import {
  ReadingClient,
  readingAccount,
  readingBindings,
  login,
} from '../fixtures/reading-client.ts';

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await clearDatabase(env.DB);
  for (const item of await objects(env.RECOVERY, '')) await env.RECOVERY.delete(item.key);
});
const offline = () => ({ ...readingBindings, RESTORE_MODE: 'offline' as const });
const noncanonical = [
  'A1B2C3D4-5566-4788-99AA-BBCC00112233',
  'a1B2c3D4-5566-4788-99aA-BbCc00112233',
];

test.each(noncanonical)(
  'rejects noncanonical receipt %s before any deletion side effects',
  async (receiptId) => {
    const { client } = await readingAccount();
    const { started, reading } = await client.create();
    const reflection = apiSchemas.Reflection.parse(
      await (
        await client.request(`/sessions/${started.sessionId}/reflections`, {
          text: 'Synthetic surviving reflection',
          stance: 'unsure',
          editionId: reading.editionId,
        })
      ).json(),
    );
    const session = apiSchemas.SessionRecord.parse(
      await (await client.request(`/sessions/${started.sessionId}`)).json(),
    );
    for (const [path, revision] of [
      [`/sessions/${started.sessionId}`, session.revision],
      [`/reflections/${reflection.id}/revisions/1`, 1],
      ['/account', 1],
    ] as const) {
      const response = await client.request(
        path,
        { receiptId, receiptToken: randomToken() },
        {
          method: 'DELETE',
          revision,
        },
      );
      expect(response.status).toBe(400);
      expect((await client.request('/me')).status).toBe(200);
      expect(await (await client.request(`/readings/${reading.editionId}`)).json()).toEqual(
        reading,
      );
      expect(await (await client.request(`/reflections/${reflection.id}`)).json()).toEqual(
        reflection,
      );
      expect((await env.DB.prepare('SELECT * FROM deletion_jobs').all()).results).toHaveLength(0);
      expect(await objects(env.RECOVERY, 'erasures/')).toHaveLength(0);
    }
  },
);

test.each(noncanonical)(
  'replays previously accepted authenticated receipt %s without rewriting it',
  async (receiptId) => {
    const { client, kit } = await readingAccount();
    const { reading } = await client.create();
    const receiptToken = randomToken();
    const ledger = new ErasureLedger(env.RECOVERY, new IdentityCrypto(IDENTITY_SECRETS));
    // Reconstruct a pre-hardening accepted intent, preserving its original ID, bytes and MAC.
    await ledger.putIntent(
      await ledger.create(
        { scope: 'account', subjectId: kit.subjectId },
        receiptId,
        await ledger.token(receiptId, receiptToken),
        Date.now(),
      ),
    );
    const path = `erasures/v1/${receiptId}/intent.json`;
    const raw = await (await env.RECOVERY.get(path))!.text();
    await expect(new OfflineRestore(offline()).replay()).resolves.toMatchObject({
      status: 'verified',
    });
    expect(await (await env.RECOVERY.get(path))!.text()).toBe(raw);
    const status = await new ReadingClient().request(`/deletions/${receiptId}`, undefined, {
      headers: { 'X-Deletion-Token': receiptToken },
    });
    expect(apiSchemas.DeletionStatus.parse(await status.json()).state).toBe('complete');
    expect((await client.request(`/readings/${reading.editionId}`)).status).toBe(401);
    expect(
      await env.DB.prepare('SELECT id FROM accounts WHERE id=?').bind(kit.subjectId).first(),
    ).toBeNull();
  },
);

test('a delayed checkpoint writer cannot recreate credential payloads after complete account deletion', async () => {
  const { client, kit, passkey } = await readingAccount(false, false);
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>((r) => {
    entered = r;
  });
  const held = new Promise<void>((r) => {
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
  let receiptId = '';
  let receiptToken = '';
  try {
    const operation = await env.DB.prepare(
      "SELECT id FROM security_operations WHERE state!='applied'",
    ).first<string>('id');
    expect(operation).toBeTruthy();
    await localIdentity(readingBindings)!.checkpoints.apply(operation!);
    const signedIn = new ReadingClient();
    await login(signedIn, passkey, kit.subjectId);
    receiptId = crypto.randomUUID();
    receiptToken = randomToken();
    const response = await signedIn.request(
      '/account',
      { receiptId, receiptToken },
      { method: 'DELETE' },
    );
    expect(response.status).toBe(202);
    expect(apiSchemas.DeletionReceipt.parse(await response.json()).state).toBe('complete');
    expect((await objects(env.RECOVERY, 'identity/')).every((o) => o.size === 0)).toBe(true);
  } finally {
    release();
  }
  await acknowledgement;
  // No encrypted checkpoint body may survive, even if the stale writer dies before reconciliation.
  expect((await objects(env.RECOVERY, 'identity/')).every((o) => o.size === 0)).toBe(true);
  expect(
    await env.DB.prepare('SELECT id FROM accounts WHERE id=?').bind(kit.subjectId).first(),
  ).toBeNull();
  const status = await new ReadingClient().request(`/deletions/${receiptId}`, undefined, {
    headers: { 'X-Deletion-Token': receiptToken },
  });
  expect(apiSchemas.DeletionStatus.parse(await status.json()).state).toBe('complete');
  await expect(new OfflineRestore(offline()).replay()).resolves.toMatchObject({
    status: 'verified',
  });
});

test('interrupted checkpoint retirement keeps deletion pending until durable markers and account erasure complete', async () => {
  const { client, kit } = await readingAccount();
  let retired = 0;
  const bucket = new Proxy(env.RECOVERY, {
    get(target, property) {
      if (property === 'put')
        return async (key: string, body: string, ...rest: unknown[]) => {
          if (key.startsWith('identity/') && body === '' && ++retired === 2)
            throw new Error('Synthetic checkpoint retirement interruption');
          return Reflect.apply(target.put, target, [key, body, ...rest]);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const deleting = new ReadingClient({ ...readingBindings, RECOVERY: bucket });
  deleting.cookies = client.cookies;
  deleting.csrf = client.csrf;
  const receiptId = crypto.randomUUID(),
    receiptToken = randomToken();
  const response = await deleting.request(
    '/account',
    { receiptId, receiptToken },
    { method: 'DELETE' },
  );
  expect(response.status).toBe(503);
  const headers = { 'X-Deletion-Token': receiptToken };
  const before = apiSchemas.DeletionStatus.parse(
    await (
      await new ReadingClient().request(`/deletions/${receiptId}`, undefined, { headers })
    ).json(),
  );
  expect(before).toEqual({ state: 'erasing', backupExpiresBy: null });
  expect((await client.request('/me')).status).toBe(401);
  expect(
    await env.DB.prepare('SELECT owner_id FROM account_keys WHERE owner_id=?')
      .bind(kit.subjectId)
      .first(),
  ).not.toBeNull();
  await env.DB.prepare('UPDATE deletion_jobs SET next_run_at=0').run();
  await worker.scheduled({} as ScheduledController, readingBindings, {} as ExecutionContext);
  const after = apiSchemas.DeletionStatus.parse(
    await (
      await new ReadingClient().request(`/deletions/${receiptId}`, undefined, { headers })
    ).json(),
  );
  expect(after.state).toBe('complete');
  expect((await objects(env.RECOVERY, 'identity/')).every((o) => o.size === 0)).toBe(true);
  expect(
    await env.DB.prepare('SELECT id FROM accounts WHERE id=?').bind(kit.subjectId).first(),
  ).toBeNull();
});
