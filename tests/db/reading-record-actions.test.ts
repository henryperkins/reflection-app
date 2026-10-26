import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, expect, test } from 'vitest';
import { apiSchemas } from '../../src/contracts/index.ts';
import { randomToken } from '../../src/worker/identity/crypto.ts';
import worker from '../../src/worker/index.ts';
import { clearDatabase } from '../fixtures/database.ts';
import { ReadingClient, readingAccount, readingBindings } from '../fixtures/reading-client.ts';

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(() => clearDatabase(env.DB));
async function reflection(
  client: ReadingClient,
  sessionId: string,
  editionId: string,
  text = 'Synthetic personal reflection',
) {
  const response = await client.request(`/sessions/${sessionId}/reflections`, {
    text,
    stance: 'unsure',
    editionId,
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return apiSchemas.Reflection.parse(await response.json());
}
async function ticket(client: ReadingClient) {
  const response = await client.request('/exports', {});
  expect(response.status, await response.clone().text()).toBe(201);
  return apiSchemas.ExportTicket.parse(await response.json());
}
test('consent-off reflection creation saves its parent atomically and edits append immutable revisions without rewriting the reading', async () => {
  const { client } = await readingAccount(),
    { reading, started } = await client.create();
  await client.permission(false);
  const first = await reflection(client, started.sessionId, reading.editionId);
  const session = apiSchemas.SessionRecord.parse(
    await (await client.request(`/sessions/${started.sessionId}`)).json(),
  );
  expect(session.status).toBe('saved');
  const edit = {
    text: 'Synthetic later reflection',
    stance: 'disagree',
    editionId: reading.editionId,
  };
  const response = await client.request(`/reflections/${first.id}`, edit, {
    method: 'PUT',
    revision: 1,
  });
  expect(response.status).toBe(200);
  expect(apiSchemas.Reflection.parse(await response.json())).toMatchObject({
    revision: 2,
    text: edit.text,
  });
  expect(
    (
      await client.request(
        `/reflections/${first.id}`,
        { ...edit, text: 'Stale draft' },
        { method: 'PUT', revision: 1 },
      )
    ).status,
  ).toBe(409);
  expect(await (await client.request(`/reflections/${first.id}?revision=1`)).json()).toEqual(first);
  expect(await (await client.request(`/readings/${reading.editionId}`)).json()).toEqual(reading);
  const rows = JSON.stringify(await env.DB.prepare('SELECT * FROM reflection_revisions').all());
  expect(rows).not.toContain('Synthetic later reflection');
  expect((await client.me()).remainingDay).toBe(2);
});

test('reflection writes reject foreign sessions, mismatched editions, missing CSRF and stale authentication', async () => {
  const { client } = await readingAccount(),
    a = await client.create(),
    b = await client.create();
  const response = await client.request(`/sessions/${a.started.sessionId}/reflections`, {
    text: 'Synthetic mismatch',
    stance: 'unspecified',
    editionId: b.reading.editionId,
  });
  expect(response.status).toBe(404);
  const { client: foreign } = await readingAccount();
  expect(
    (
      await foreign.request(`/sessions/${a.started.sessionId}/reflections`, {
        text: 'Synthetic foreign',
        stance: 'unspecified',
        editionId: a.reading.editionId,
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await client.request(
        `/sessions/${a.started.sessionId}/reflections`,
        { text: 'Synthetic csrf', stance: 'unspecified', editionId: a.reading.editionId },
        { headers: { 'X-CSRF-Token': 'invalid' } },
      )
    ).status,
  ).toBe(403);
  expect((await env.DB.prepare('SELECT * FROM reflections').all()).results).toHaveLength(0);
});

test('consent-off export contains exact accepted reading, both reflection revisions and no recovery/session/key secrets', async () => {
  const { client, kit } = await readingAccount(),
    { reading, started } = await client.create();
  const first = await reflection(client, started.sessionId, reading.editionId);
  await client.request(
    `/reflections/${first.id}`,
    { text: 'Synthetic revision two', stance: 'resonates', editionId: reading.editionId },
    { method: 'PUT', revision: 1 },
  );
  await client.permission(false);
  const exportTicket = await ticket(client);
  const response = await client.request(`/exports/${exportTicket.id}`);
  expect(response.status, await response.clone().text()).toBe(200);
  const page = apiSchemas.ExportPage.parse(await response.json());
  expect(page.records.find((r) => r.kind === 'reading')?.value).toEqual(reading);
  expect(page.records.filter((r) => r.kind === 'reflection').map((r) => r.value.revision)).toEqual([
    1, 2,
  ]);
  expect(page.account?.subjectId).toBe(kit.subjectId);
  const exported = JSON.stringify(page);
  for (const secret of [
    kit.recoveryHandle!,
    ...kit.recoveryCodes,
    client.csrf,
    client.cookies.get('__Host-session')!,
  ])
    expect(exported).not.toContain(secret);
  expect(exported).not.toContain('wrapped_key_enc');
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  const { client: foreign } = await readingAccount();
  expect((await foreign.request(`/exports/${exportTicket.id}`)).status).toBe(404);
});

test('exports require recent auth and invalidate when records change or the ticket expires', async () => {
  const { client } = await readingAccount(),
    { started, reading } = await client.create();
  const first = await ticket(client);
  await reflection(client, started.sessionId, reading.editionId);
  const changed = await client.request(`/exports/${first.id}`);
  expect(changed.status).toBe(409);
  expect(apiSchemas.ErrorEnvelope.parse(await changed.json()).error.code).toBe('EXPORT_CHANGED');
  const second = await ticket(client);
  await env.DB.prepare('UPDATE export_tickets SET expires_at=1 WHERE id=?').bind(second.id).run();
  expect((await client.request(`/exports/${second.id}`)).status).toBe(410);
  await env.DB.prepare('UPDATE auth_sessions SET authenticated_at=1').run();
  expect((await client.request('/exports', {})).status).toBe(401);
});

test('session deletion with consent off erases every local private body, survives retries and does not refund consumed quota', async () => {
  const { client } = await readingAccount(),
    { reading, started } = await client.create();
  await reflection(client, started.sessionId, reading.editionId);
  await client.permission(false);
  const session = apiSchemas.SessionRecord.parse(
    await (await client.request(`/sessions/${started.sessionId}`)).json(),
  );
  const receipt = { receiptId: crypto.randomUUID(), receiptToken: randomToken() },
    key = crypto.randomUUID();
  const response = await client.request(`/sessions/${session.id}`, receipt, {
    method: 'DELETE',
    revision: session.revision,
    key,
  });
  expect(response.status, await response.clone().text()).toBe(202);
  const result = apiSchemas.DeletionReceipt.parse(await response.json());
  expect(result.state).toBe('complete');
  expect(result.backupExpiresBy).toBeTruthy();
  expect((await client.request(`/readings/${reading.editionId}`)).status).toBe(410);
  expect(
    apiSchemas.HistoryPage.parse(await (await client.request('/sessions')).json()).items,
  ).toHaveLength(0);
  expect((await client.me()).remainingDay).toBe(2);
  expect(
    (
      await client.request(`/sessions/${session.id}`, receipt, {
        method: 'DELETE',
        revision: session.revision,
        key,
      })
    ).status,
  ).toBe(202);
  for (const [table, columns] of [
    ['reading_sessions', ['question_enc']],
    ['basis_snapshots', ['body_enc']],
    ['reading_editions', ['body_enc']],
    ['reflection_revisions', ['body_enc']],
    ['generation_requests', ['input_enc', 'plan_enc']],
    ['provider_dispatches', ['transmission_enc', 'candidate_enc', 'provider_response_id_enc']],
  ] as const) {
    for (const row of (await env.DB.prepare(`SELECT ${columns.join(',')} FROM ${table}`).all())
      .results)
      for (const column of columns) expect(row[column]).toBeNull();
  }
  const anonymous = new ReadingClient();
  const status = await anonymous.request(`/deletions/${receipt.receiptId}`, undefined, {
    headers: { 'X-Deletion-Token': receipt.receiptToken },
  });
  expect(status.status).toBe(200);
  expect(apiSchemas.DeletionStatus.parse(await status.json()).state).toBe('complete');
  expect((await anonymous.request(`/deletions/${receipt.receiptId}`)).status).toBe(404);
  const objects = await env.RECOVERY.list({ prefix: `erasures/v1/${receipt.receiptId}/` });
  expect(objects.objects).toHaveLength(3);
  for (const object of objects.objects) {
    const stored = await (await env.RECOVERY.get(object.key))!.text();
    expect(stored).not.toContain(session.id);
    expect(stored).not.toContain('Synthetic');
    expect(stored).not.toContain(receipt.receiptToken);
  }
});

test('R2 interruption keeps deletion fenced and scheduled maintenance completes it after recovery', async () => {
  const { client } = await readingAccount(),
    { started, reading } = await client.create();
  const bucket = new Proxy(env.RECOVERY, {
    get(target, property) {
      if (property === 'put') return () => Promise.reject(new Error('synthetic ledger outage'));
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const failing = new ReadingClient({ ...readingBindings, RECOVERY: bucket });
  failing.cookies = client.cookies;
  failing.csrf = client.csrf;
  const receipt = { receiptId: crypto.randomUUID(), receiptToken: randomToken() };
  expect(
    (
      await failing.request(`/sessions/${started.sessionId}`, receipt, {
        method: 'DELETE',
        revision: 1,
      })
    ).status,
  ).toBe(503);
  expect((await client.request(`/readings/${reading.editionId}`)).status).toBe(410);
  expect(
    await env.DB.prepare('SELECT body_enc FROM reading_editions').first('body_enc'),
  ).not.toBeNull();
  await env.DB.prepare('UPDATE deletion_jobs SET next_run_at=0').run();
  await worker.scheduled({} as ScheduledController, readingBindings, {} as ExecutionContext);
  expect(await env.DB.prepare('SELECT state FROM deletion_jobs').first('state')).toBe('complete');
  expect(
    await env.DB.prepare('SELECT body_enc FROM reading_editions').first('body_enc'),
  ).toBeNull();
});

test('export pages are bounded and a cursor cannot be reused for another ticket', async () => {
  const { client, kit } = await readingAccount(false, false);
  await env.DB.batch(
    Array.from({ length: 105 }, (_, index) =>
      env.DB.prepare("INSERT INTO permission_revisions VALUES (?,?,0,'egress.v1',1)").bind(
        kit.subjectId,
        index + 2,
      ),
    ),
  );
  const first = await ticket(client),
    second = await ticket(client);
  const page = apiSchemas.ExportPage.parse(
    await (await client.request(`/exports/${first.id}`)).json(),
  );
  expect(page.records).toHaveLength(100);
  expect(page.nextCursor).toBeTruthy();
  const next = apiSchemas.ExportPage.parse(
    await (
      await client.request(`/exports/${first.id}?cursor=${encodeURIComponent(page.nextCursor!)}`)
    ).json(),
  );
  expect(next.records).toHaveLength(6);
  expect(next.nextCursor).toBeNull();
  expect(
    new Set([...page.records, ...next.records].map((r) => r.identity.recordRevision)).size,
  ).toBe(106);
  expect(
    (await client.request(`/exports/${second.id}?cursor=${encodeURIComponent(page.nextCursor!)}`))
      .status,
  ).toBe(400);
});

test('an edit after export decryption but before release produces EXPORT_CHANGED', async () => {
  const { RecordBase } = await import('../../src/worker/readings/base.ts');
  const { ReadingExports } = await import('../../src/worker/readings/export.ts');
  const { localIdentity } = await import('../../src/worker/identity/routes.ts');
  const { client } = await readingAccount();
  await client.create();
  const exported = await ticket(client),
    identity = localIdentity(readingBindings)!;
  const session = await identity.sessions.get(client.cookies.get('__Host-session'));
  let arrived!: () => void, release!: () => void;
  const ready = new Promise<void>((r) => {
      arrived = r;
    }),
    held = new Promise<void>((r) => {
      release = r;
    });
  let batchCount = 0;
  const database = new Proxy(env.DB, {
    get(target, property) {
      if (property === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (++batchCount === 2) {
            arrived();
            await held;
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const pending = new ReadingExports(new RecordBase(database, identity)).page(
    session,
    exported.id,
    null,
  );
  const rejected = expect(pending).rejects.toMatchObject({ code: 'EXPORT_CHANGED', status: 409 });
  await ready;
  await client.permission(false);
  release();
  await rejected;
});

test('scheduled expiry erases unsaved content while a saved reading survives', async () => {
  const { client } = await readingAccount(),
    expired = await client.create(),
    retained = await client.create();
  expect(
    (
      await client.request(
        `/sessions/${retained.started.sessionId}/save`,
        { saved: true },
        { method: 'PUT', revision: 1 },
      )
    ).status,
  ).toBe(200);
  await env.DB.prepare('UPDATE reading_sessions SET retention_expires_at=1 WHERE id=?')
    .bind(expired.started.sessionId)
    .run();
  await worker.scheduled({} as ScheduledController, readingBindings, {} as ExecutionContext);
  expect((await client.request(`/readings/${expired.reading.editionId}`)).status).toBe(410);
  expect(await (await client.request(`/readings/${retained.reading.editionId}`)).json()).toEqual(
    retained.reading,
  );
  expect(
    await env.DB.prepare('SELECT body_enc FROM reading_editions WHERE id=?')
      .bind(expired.reading.editionId)
      .first('body_enc'),
  ).toBeNull();
});
