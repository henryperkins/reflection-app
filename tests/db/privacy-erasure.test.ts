import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, expect, test } from 'vitest';
import { apiSchemas } from '../../src/contracts/index.ts';
import worker from '../../src/worker/index.ts';
import { randomToken } from '../../src/worker/identity/crypto.ts';
import { clearDatabase } from '../fixtures/database.ts';
import { ReadingClient, readingAccount, readingBindings } from '../fixtures/reading-client.ts';

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(() => clearDatabase(env.DB));
const receipt = () => ({ receiptId: crypto.randomUUID(), receiptToken: randomToken() });
async function thoughts(client: ReadingClient, sessionId: string, editionId: string) {
  const one = apiSchemas.Reflection.parse(
    await (
      await client.request(`/sessions/${sessionId}/reflections`, {
        text: 'Synthetic original reflection',
        stance: 'unsure',
        editionId,
      })
    ).json(),
  );
  const two = apiSchemas.Reflection.parse(
    await (
      await client.request(
        `/reflections/${one.id}`,
        { text: 'Synthetic current reflection', stance: 'resonates', editionId },
        { method: 'PUT', revision: 1 },
      )
    ).json(),
  );
  return { one, two };
}

test('erasing an exact old reflection revision preserves current text, original reading and consent-off export', async () => {
  const { client } = await readingAccount(),
    { started, reading } = await client.create();
  const { one, two } = await thoughts(client, started.sessionId, reading.editionId);
  await client.permission(false);
  const proof = receipt(),
    key = crypto.randomUUID();
  const path = `/reflections/${one.id}/revisions/1`;
  expect((await client.request(path, proof, { method: 'DELETE', revision: 1 })).status).toBe(409);
  const response = await client.request(path, proof, { method: 'DELETE', revision: 2, key });
  expect(response.status).toBe(202);
  expect(apiSchemas.DeletionReceipt.parse(await response.json()).state).toBe('complete');
  expect((await client.request(`/reflections/${one.id}?revision=1`)).status).toBe(410);
  expect(await (await client.request(`/reflections/${one.id}`)).json()).toEqual(two);
  expect(await (await client.request(`/readings/${reading.editionId}`)).json()).toEqual(reading);
  expect((await client.request(path, proof, { method: 'DELETE', revision: 2, key })).status).toBe(
    202,
  );
  const ticket = apiSchemas.ExportTicket.parse(await (await client.request('/exports', {})).json());
  const exported = apiSchemas.ExportPage.parse(
    await (await client.request(`/exports/${ticket.id}`)).json(),
  );
  expect(
    exported.records.filter((r) => r.kind === 'reflection').map((r) => r.value.revision),
  ).toEqual([2]);
  expect(JSON.stringify(exported)).not.toContain(one.text);
});

test('erasing the current revision hides that reflection but retains unselected authored revisions', async () => {
  const { client } = await readingAccount(),
    { started, reading } = await client.create();
  const { one, two } = await thoughts(client, started.sessionId, reading.editionId);
  expect(
    (
      await client.request(`/reflections/${one.id}/revisions/2`, receipt(), {
        method: 'DELETE',
        revision: 2,
      })
    ).status,
  ).toBe(202);
  expect((await client.request(`/reflections/${one.id}`)).status).toBe(410);
  expect(await (await client.request(`/reflections/${one.id}?revision=1`)).json()).toEqual(one);
  const ticket = apiSchemas.ExportTicket.parse(await (await client.request('/exports', {})).json());
  const exported = apiSchemas.ExportPage.parse(
    await (await client.request(`/exports/${ticket.id}`)).json(),
  );
  expect(
    exported.records.filter((r) => r.kind === 'reflection').map((r) => r.value.revision),
  ).toEqual([1]);
  expect(JSON.stringify(exported)).not.toContain(two.text);
});

test('revision erasure enforces owner and CSRF and cannot erase an unowned target', async () => {
  const { client } = await readingAccount(),
    { started, reading } = await client.create();
  const { one } = await thoughts(client, started.sessionId, reading.editionId);
  const { client: foreign } = await readingAccount();
  const path = `/reflections/${one.id}/revisions/1`;
  expect((await foreign.request(path, receipt(), { method: 'DELETE', revision: 2 })).status).toBe(
    404,
  );
  expect(
    (
      await client.request(path, receipt(), {
        method: 'DELETE',
        revision: 2,
        headers: { 'X-CSRF-Token': 'invalid' },
      })
    ).status,
  ).toBe(403);
  expect((await client.request(`/reflections/${one.id}?revision=1`)).status).toBe(200);
});

test('account deletion erases owned bodies, keys, credentials and checkpoints while preserving another account', async () => {
  const { client, kit } = await readingAccount(),
    { started, reading } = await client.create();
  await thoughts(client, started.sessionId, reading.editionId);
  const note = apiSchemas.Revisit.parse(
    await (
      await client.request('/revisits', {
        editionId: reading.editionId,
        note: 'Account-owned note',
      })
    ).json(),
  );
  expect(
    (
      await client.request(
        `/revisits/${note.id}`,
        { note: 'Account-owned revision' },
        { method: 'PUT', revision: 1 },
      )
    ).status,
  ).toBe(200);
  const { client: foreign, kit: other } = await readingAccount();
  const proof = receipt();
  const response = await client.request('/account', proof, { method: 'DELETE' });
  expect(response.status).toBe(202);
  expect(apiSchemas.DeletionReceipt.parse(await response.json()).state).toBe('complete');
  expect((await client.request('/me')).status).toBe(401);
  expect((await client.request(`/readings/${reading.editionId}`)).status).toBe(401);
  expect(
    await env.DB.prepare('SELECT id FROM accounts WHERE id=?').bind(kit.subjectId).first(),
  ).toBeNull();
  for (const table of [
    'account_keys',
    'credentials',
    'recovery_codes',
    'security_operations',
    'reading_sessions',
    'reflection_revisions',
    'revisits',
    'revisit_revisions',
    'provider_dispatches',
  ])
    expect(
      (await env.DB.prepare(`SELECT * FROM ${table} WHERE owner_id=?`).bind(kit.subjectId).all())
        .results,
    ).toEqual([]);
  expect((await foreign.me()).subjectId).toBe(other.subjectId);
  const status = await new ReadingClient().request(`/deletions/${proof.receiptId}`, undefined, {
    headers: { 'X-Deletion-Token': proof.receiptToken },
  });
  expect(apiSchemas.DeletionStatus.parse(await status.json()).state).toBe('complete');
  expect((await new ReadingClient().request(`/deletions/${proof.receiptId}`)).status).toBe(404);
  const job = await env.DB.prepare('SELECT owner_id,target_enc FROM deletion_jobs WHERE id=?')
    .bind(proof.receiptId)
    .first();
  expect(job).toEqual({ owner_id: null, target_enc: null });
});

test('account deletion requires recent authentication before any fence', async () => {
  const { client, kit } = await readingAccount();
  await env.DB.prepare('UPDATE auth_sessions SET authenticated_at=1 WHERE owner_id=?')
    .bind(kit.subjectId)
    .run();
  expect((await client.request('/account', receipt(), { method: 'DELETE' })).status).toBe(401);
  expect((await client.me()).subjectId).toBe(kit.subjectId);
  expect((await env.DB.prepare('SELECT * FROM deletion_jobs').all()).results).toHaveLength(0);
});

test('an account deletion interrupted before durable intent remains fenced and maintenance completes the same receipt', async () => {
  const { client, kit } = await readingAccount();
  const bucket = new Proxy(env.RECOVERY, {
    get(target, property) {
      if (property === 'put')
        return () => {
          throw new Error('Synthetic R2 failure');
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const offline = new ReadingClient({ ...readingBindings, RECOVERY: bucket });
  offline.cookies = client.cookies;
  offline.csrf = client.csrf;
  const proof = receipt();
  expect((await offline.request('/account', proof, { method: 'DELETE' })).status).toBe(503);
  expect((await client.request('/me')).status).toBe(401);
  expect(
    await env.DB.prepare('SELECT wrapped_key_enc FROM account_keys WHERE owner_id=?')
      .bind(kit.subjectId)
      .first(),
  ).not.toBeNull();
  await env.DB.prepare('UPDATE deletion_jobs SET next_run_at=0').run();
  await worker.scheduled({} as ScheduledController, readingBindings, {} as ExecutionContext);
  const status = await new ReadingClient().request(`/deletions/${proof.receiptId}`, undefined, {
    headers: { 'X-Deletion-Token': proof.receiptToken },
  });
  expect(apiSchemas.DeletionStatus.parse(await status.json()).state).toBe('complete');
  expect(
    await env.DB.prepare('SELECT id FROM accounts WHERE id=?').bind(kit.subjectId).first(),
  ).toBeNull();
});
