import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, expect, test } from 'vitest';
import { apiSchemas } from '../../src/contracts/index.ts';
import { randomToken } from '../../src/worker/identity/crypto.ts';
import { clearDatabase } from '../fixtures/database.ts';
import { ReadingClient, readingAccount, readingBindings } from '../fixtures/reading-client.ts';

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(() => clearDatabase(env.DB));
function gate(predicate: (sql: string[]) => boolean) {
  const statements = new WeakMap<object, string>();
  let armed = true;
  let arrived!: () => void, release!: () => void;
  const ready = new Promise<void>((r) => {
      arrived = r;
    }),
    held = new Promise<void>((r) => {
      release = r;
    });
  const db = new Proxy(env.DB, {
    get(target, property) {
      if (property === 'prepare')
        return (sql: string) => {
          const prepared = target.prepare(sql);
          return new Proxy(prepared, {
            get(statement, name) {
              if (name === 'bind')
                return (...values: unknown[]) => {
                  const bound = statement.bind(...values);
                  statements.set(bound, sql);
                  return bound;
                };
              const value = Reflect.get(statement, name, statement);
              return typeof value === 'function' ? value.bind(statement) : value;
            },
          });
        };
      if (property === 'batch')
        return async (batch: D1PreparedStatement[]) => {
          if (armed && predicate(batch.map((statement) => statements.get(statement) ?? ''))) {
            armed = false;
            arrived();
            await held;
          }
          return target.batch(batch);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db, ready, release };
}
function gatedClient(client: ReadingClient, db: D1Database) {
  const controlled = new ReadingClient({ ...readingBindings, DB: db });
  controlled.cookies = client.cookies;
  controlled.csrf = client.csrf;
  return controlled;
}
async function after(deadline: number) {
  while (
    Number(
      await env.DB.prepare("SELECT CAST(unixepoch('subsec')*1000 AS INTEGER) AS now").first('now'),
    ) <= deadline
  )
    await new Promise((r) => setTimeout(r, 10));
}

test('a delayed concurrent erasure cannot regress a completed job when R2 is unavailable', async () => {
  const { client } = await readingAccount(),
    { started } = await client.create();
  const receipt = { receiptId: crypto.randomUUID(), receiptToken: randomToken() },
    key = crypto.randomUUID();
  const barrier = gate((sql) =>
    sql.some((s) => s.includes("UPDATE deletion_jobs SET state='erasing'")),
  );
  const bucket = new Proxy(env.RECOVERY, {
    get(target, property) {
      if (property === 'get')
        return (key: string) => {
          if (key.endsWith('/complete.json')) throw new Error('Synthetic R2 completion outage');
          return target.get(key);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const delayed = new ReadingClient({ ...readingBindings, DB: barrier.db, RECOVERY: bucket });
  delayed.cookies = client.cookies;
  delayed.csrf = client.csrf;
  const pending = delayed.request(`/sessions/${started.sessionId}`, receipt, {
    method: 'DELETE',
    revision: 1,
    key,
  });
  await barrier.ready;
  try {
    const first = await client.request(`/sessions/${started.sessionId}`, receipt, {
      method: 'DELETE',
      revision: 1,
      key,
    });
    expect(first.status).toBe(202);
    expect(await env.DB.prepare('SELECT state,target_enc FROM deletion_jobs').first()).toEqual({
      state: 'complete',
      target_enc: null,
    });
  } finally {
    barrier.release();
  }
  expect((await pending).status).toBe(202);
  expect(await env.DB.prepare('SELECT state,target_enc FROM deletion_jobs').first()).toEqual({
    state: 'complete',
    target_enc: null,
  });
  const retry = await client.request(`/sessions/${started.sessionId}`, receipt, {
    method: 'DELETE',
    revision: 1,
    key,
  });
  expect(retry.status).toBe(202);
  expect(apiSchemas.DeletionReceipt.parse(await retry.json()).state).toBe('complete');
  expect(
    await env.RECOVERY.head(`erasures/v1/${receipt.receiptId}/passes/1/complete.json`),
  ).not.toBeNull();
});

test('retention expiry between export pages invalidates the whole snapshot', async () => {
  const { client, kit } = await readingAccount(),
    { started } = await client.create();
  await env.DB.batch(
    Array.from({ length: 105 }, (_, i) =>
      env.DB.prepare("INSERT INTO permission_revisions VALUES (?,?,0,'egress.v1',1)").bind(
        kit.subjectId,
        i + 3,
      ),
    ),
  );
  const deadline = Date.now() + 1000;
  await env.DB.prepare('UPDATE reading_sessions SET retention_expires_at=? WHERE id=?')
    .bind(deadline, started.sessionId)
    .run();
  const ticket = apiSchemas.ExportTicket.parse(await (await client.request('/exports', {})).json());
  const first = apiSchemas.ExportPage.parse(
    await (await client.request(`/exports/${ticket.id}`)).json(),
  );
  expect(first.records[0]?.kind).toBe('generation_receipt');
  expect(first.nextCursor).toBeTruthy();
  expect(
    first.records.some((record) => record.kind === 'reading' || record.kind === 'session'),
  ).toBe(false);
  await after(deadline);
  const response = await client.request(
    `/exports/${ticket.id}?cursor=${encodeURIComponent(first.nextCursor!)}`,
  );
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: 'EXPORT_CHANGED' } });
  expect(Date.parse(ticket.expiresAt)).toBe(deadline);
});

test.each(['dispatch', 'publication'] as const)(
  'revocation at %s blocks the in-flight reading and releases held quota once',
  async (stage) => {
    const { client } = await readingAccount();
    const barrier = gate((sql) =>
      sql.some((s) =>
        s.includes(
          stage === 'dispatch' ? 'INSERT INTO provider_dispatches' : 'INSERT INTO reading_editions',
        ),
      ),
    );
    const request = gatedClient(client, barrier.db).start();
    await barrier.ready;
    await client.permission(false);
    barrier.release();
    const response = await request;
    expect(response.status).toBe(202);
    expect(apiSchemas.StartResponse.parse(await response.json()).status.state).toBe('blocked');
    expect((await env.DB.prepare('SELECT * FROM reading_editions').all()).results).toHaveLength(0);
    expect((await env.DB.prepare('SELECT * FROM provider_dispatches').all()).results).toHaveLength(
      stage === 'dispatch' ? 0 : 1,
    );
    expect(
      (await env.DB.prepare("SELECT * FROM quota_events WHERE event='release'").all()).results,
    ).toHaveLength(1);
    for (const row of (await env.DB.prepare('SELECT held,consumed FROM quota_buckets').all())
      .results)
      expect(row).toEqual({ held: 0, consumed: 0 });
    expect((await client.me()).remainingDay).toBe(3);
  },
);

test('an alias idempotency key that joined an intent cannot later create a second reading', async () => {
  const { client } = await readingAccount(),
    intent = crypto.randomUUID(),
    alias = crypto.randomUUID();
  expect((await client.start('Synthetic alias', intent)).status).toBe(202);
  expect(
    apiSchemas.StartResponse.parse(
      await (await client.start('Synthetic alias', intent, alias)).json(),
    ).joined,
  ).toBe(true);
  expect((await client.start('Synthetic alias', crypto.randomUUID(), alias)).status).toBe(409);
  expect((await env.DB.prepare('SELECT * FROM generation_requests').all()).results).toHaveLength(1);
  expect((await client.me()).remainingDay).toBe(2);
});

test('an unsaved reading expiring after decryption is not released from the read boundary', async () => {
  const { client } = await readingAccount(),
    { reading, started } = await client.create();
  const deadline = Date.now() + 300;
  await env.DB.prepare('UPDATE reading_sessions SET retention_expires_at=? WHERE id=?')
    .bind(deadline, started.sessionId)
    .run();
  const barrier = gate((sql) => sql.some((s) => s.includes('data_revision=?')));
  const pending = gatedClient(client, barrier.db).request(`/readings/${reading.editionId}`);
  await barrier.ready;
  await after(deadline);
  barrier.release();
  expect((await pending).status).toBe(410);
  expect(
    await env.DB.prepare('SELECT retention_expires_at FROM reading_sessions WHERE id=?')
      .bind(started.sessionId)
      .first('retention_expires_at'),
  ).toBe(deadline);
});

test('authentication expiring after reflection encryption rolls back the write', async () => {
  const { client } = await readingAccount(),
    { reading, started } = await client.create();
  const deadline = Date.now() + 300;
  await env.DB.prepare('UPDATE auth_sessions SET expires_at=?,idle_expires_at=?')
    .bind(deadline, deadline)
    .run();
  const barrier = gate((sql) => sql.some((s) => s.includes('INSERT INTO reflection_revisions')));
  const pending = gatedClient(client, barrier.db).request(
    `/sessions/${started.sessionId}/reflections`,
    { editionId: reading.editionId, text: 'Synthetic expired write', stance: 'unspecified' },
  );
  await barrier.ready;
  await after(deadline);
  barrier.release();
  expect((await pending).status).toBe(401);
  expect((await env.DB.prepare('SELECT * FROM reflections').all()).results).toHaveLength(0);
  expect(
    await env.DB.prepare('SELECT status FROM reading_sessions WHERE id=?')
      .bind(started.sessionId)
      .first('status'),
  ).toBe('open');
});

test('concurrent retries of one deletion receipt join the same durable erasure', async () => {
  const { client } = await readingAccount(),
    { started } = await client.create();
  const receipt = { receiptId: crypto.randomUUID(), receiptToken: randomToken() },
    key = crypto.randomUUID();
  const replies = await Promise.all(
    [1, 2].map(() =>
      client.request(`/sessions/${started.sessionId}`, receipt, {
        method: 'DELETE',
        revision: 1,
        key,
      }),
    ),
  );
  expect(replies.map((r) => r.status)).toEqual([202, 202]);
  expect((await env.DB.prepare('SELECT * FROM deletion_jobs').all()).results).toHaveLength(1);
  expect(await env.DB.prepare('SELECT state FROM deletion_jobs').first('state')).toBe('complete');
  expect(
    (await env.RECOVERY.list({ prefix: `erasures/v1/${receipt.receiptId}/` })).objects,
  ).toHaveLength(3);
});

test('an open session expiring after export decryption invalidates the page', async () => {
  const { client } = await readingAccount(),
    { started } = await client.create();
  const ticket = apiSchemas.ExportTicket.parse(await (await client.request('/exports', {})).json());
  const deadline = Date.now() + 300;
  await env.DB.prepare('UPDATE reading_sessions SET retention_expires_at=? WHERE id=?')
    .bind(deadline, started.sessionId)
    .run();
  const barrier = gate(
    (sql) =>
      sql.some((s) => s.includes('FROM export_tickets t JOIN accounts')) &&
      !sql.some((s) => s.includes('UNION ALL')),
  );
  const pending = gatedClient(client, barrier.db).request(`/exports/${ticket.id}`);
  await barrier.ready;
  await after(deadline);
  barrier.release();
  const response = await pending;
  expect(response.status).toBe(409);
  expect(apiSchemas.ErrorEnvelope.parse(await response.json()).error.code).toBe('EXPORT_CHANGED');
});
