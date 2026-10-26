import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, expect, test } from 'vitest';
import { apiSchemas } from '../../src/contracts/index.ts';
import { clearDatabase } from '../fixtures/database.ts';
import { ReadingClient, readingAccount, login } from '../fixtures/reading-client.ts';
import { syntheticPasskey } from '../fixtures/passkeys.ts';

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(() => clearDatabase(env.DB));
const all = (table: string) => env.DB.prepare(`SELECT * FROM ${table}`).all();
const save = (client: ReadingClient, id: string, revision = 1) =>
  client.request(`/sessions/${id}/save`, { saved: true }, { method: 'PUT', revision });

test('consent off and missing kit acknowledgement reject Start before personal persistence', async () => {
  const { client } = await readingAccount(false, false);
  expect((await client.start()).status).toBe(403);
  expect((await all('reading_sessions')).results).toHaveLength(0);
  await client.permission(true);
  expect((await client.start()).status).toBe(403);
  expect((await all('generation_requests')).results).toHaveLength(0);
});

test('save without reflection retains identical accepted content through sign-in and kit recovery with no generation or quota change', async () => {
  const { client, kit, passkey } = await readingAccount();
  const { started, reading } = await client.create();
  const before = await client.me();
  expect(before.remainingDay).toBe(2);
  expect((await save(client, started.sessionId)).status).toBe(200);
  expect((await all('reflections')).results).toHaveLength(0);
  const row = await env.DB.prepare('SELECT * FROM reading_sessions WHERE id=?')
    .bind(started.sessionId)
    .first();
  expect(row).toMatchObject({ status: 'saved', retention_expires_at: null });
  expect(JSON.stringify(await all('reading_editions'))).not.toContain('Synthetic question');
  expect((await client.request('/auth/logout', {})).status).toBe(204);
  await login(client, passkey, kit.subjectId);
  const history = apiSchemas.HistoryPage.parse(
    await (await client.request('/sessions?status=saved')).json(),
  );
  expect(history.items).toHaveLength(1);
  expect(history.items[0]).toMatchObject({
    id: started.sessionId,
    questionPreview: reading.kind === 'tarot.accepted.v1' ? reading.question : null,
    latestEditionId: reading.editionId,
  });
  expect(await (await client.request(`/readings/${reading.editionId}`)).json()).toEqual(reading);
  const fresh = new ReadingClient();
  const grant = apiSchemas.RecoveryGrant.parse(
    await (
      await fresh.request('/auth/recover', {
        recoveryHandle: kit.recoveryHandle,
        code: kit.recoveryCodes[0],
      })
    ).json(),
  );
  expect((await fresh.request(`/readings/${reading.editionId}`)).status).toBe(401);
  const replacement = await syntheticPasskey();
  const result = apiSchemas.AuthResult.parse(
    await (
      await fresh.request('/auth/register', {
        challengeId: grant.challengeId,
        credential: await replacement.register(grant.options),
      })
    ).json(),
  );
  fresh.csrf = result.csrfToken;
  expect(result.subjectId).toBe(kit.subjectId);
  expect(await (await fresh.request(`/readings/${reading.editionId}`)).json()).toEqual(reading);
  await fresh.permission(false);
  expect(await (await fresh.request(`/readings/${reading.editionId}`)).json()).toEqual(reading);
  expect((await fresh.start()).status).toBe(403);
  expect((await all('generation_requests')).results).toHaveLength(1);
  expect((await all('provider_dispatches')).results).toHaveLength(1);
  expect((await fresh.me()).remainingDay).toBe(before.remainingDay);
  expect((await client.request(`/readings/${reading.editionId}`)).status).toBe(401);
});

test('retries join a single intent, CAS rejects stale save, and changed payload is an idempotency mismatch', async () => {
  const { client } = await readingAccount();
  const intent = crypto.randomUUID(),
    key = crypto.randomUUID();
  const replies = await Promise.all([
    client.start('Synthetic retry', intent, key),
    client.start('Synthetic retry', intent, key),
  ]);
  expect(replies.map((r) => r.status)).toEqual([202, 202]);
  const values = await Promise.all(
    replies.map(async (r) => apiSchemas.StartResponse.parse(await r.json())),
  );
  expect(values[0]!.requestId).toBe(values[1]!.requestId);
  expect((await all('provider_dispatches')).results).toHaveLength(1);
  expect((await client.start('Changed synthetic retry', intent, key)).status).toBe(409);
  expect((await save(client, values[0]!.sessionId)).status).toBe(200);
  expect((await save(client, values[0]!.sessionId)).status).toBe(409);
  expect((await client.me()).remainingDay).toBe(2);
});

test('foreign owners cannot list, read or save content and ciphertext cannot be transplanted across fields', async () => {
  const { client } = await readingAccount();
  const { started, reading } = await client.create();
  const { client: foreign } = await readingAccount();
  expect((await foreign.request(`/readings/${reading.editionId}`)).status).toBe(404);
  expect((await save(foreign, started.sessionId)).status).toBe(404);
  expect(
    apiSchemas.HistoryPage.parse(await (await foreign.request('/sessions')).json()).items,
  ).toHaveLength(0);
  await env.DB.prepare(
    'UPDATE reading_editions SET body_enc=(SELECT question_enc FROM reading_sessions WHERE id=?) WHERE id=?',
  )
    .bind(started.sessionId, reading.editionId)
    .run();
  const response = await client.request(`/readings/${reading.editionId}`);
  expect(response.status).toBe(503);
  expect(apiSchemas.ErrorEnvelope.parse(await response.json()).error.code).toBe('KEY_UNAVAILABLE');
});

test('unsaved expiry is enforced at read and save; history keyset cursors are owner-bound', async () => {
  const { client } = await readingAccount();
  const first = await client.create('Synthetic first'),
    second = await client.create('Synthetic second');
  const page = apiSchemas.HistoryPage.parse(
    await (await client.request('/sessions?status=open&limit=1')).json(),
  );
  expect(page.items[0]!.id).toBe(second.started.sessionId);
  expect(page.nextCursor).toBeTruthy();
  const next = apiSchemas.HistoryPage.parse(
    await (
      await client.request(
        `/sessions?status=open&limit=1&cursor=${encodeURIComponent(page.nextCursor!)}`,
      )
    ).json(),
  );
  expect(next.items[0]!.id).toBe(first.started.sessionId);
  const { client: foreign } = await readingAccount();
  expect(
    (
      await foreign.request(
        `/sessions?status=open&limit=1&cursor=${encodeURIComponent(page.nextCursor!)}`,
      )
    ).status,
  ).toBe(400);
  await env.DB.prepare('UPDATE reading_sessions SET retention_expires_at=1 WHERE id=?')
    .bind(first.started.sessionId)
    .run();
  expect((await client.request(`/readings/${first.reading.editionId}`)).status).toBe(410);
  expect((await save(client, first.started.sessionId)).status).toBe(410);
});
