import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, expect, test } from 'vitest';
import { apiSchemas } from '../../src/contracts/index.ts';
import { randomToken } from '../../src/worker/identity/crypto.ts';
import { clearDatabase } from '../fixtures/database.ts';
import { readingAccount } from '../fixtures/reading-client.ts';

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(() => clearDatabase(env.DB));
const bytes = (id: string) =>
  env.DB.prepare('SELECT storage_bytes FROM accounts WHERE id=?')
    .bind(id)
    .first<number>('storage_bytes');
async function owner() {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO accounts(id,recovery_handle_hash,created_at,updated_at) VALUES (?,?,1,1)',
  )
    .bind(id, id)
    .run();
  return id;
}

test('owned rows and UTF-8 encrypted/key bytes are charged and released atomically', async () => {
  const id = await owner();
  expect(await bytes(id)).toBe(1024);
  await env.DB.prepare("INSERT INTO account_keys VALUES (?,1,'synthetic','é','😀',1)")
    .bind(id)
    .run();
  expect(await bytes(id)).toBe(2054); // two rows, 2 + 4 UTF-8 bytes
  await env.DB.prepare("UPDATE account_keys SET wrapped_key_enc='界界' WHERE owner_id=?")
    .bind(id)
    .run();
  expect(await bytes(id)).toBe(2058); // six rather than two bytes
  await expect(
    env.DB.batch([
      env.DB.prepare(
        "UPDATE account_keys SET wrapped_index_key_enc='temporary' WHERE owner_id=?",
      ).bind(id),
      env.DB.prepare('INSERT INTO assertion_probe VALUES (0)'),
    ]),
  ).rejects.toThrow();
  expect(await bytes(id)).toBe(2058);
  await env.DB.prepare('DELETE FROM account_keys WHERE owner_id=?').bind(id).run();
  expect(await bytes(id)).toBe(1024);
});

test('nullable ownership and transfers charge the current owner once and cascade safely', async () => {
  const first = await owner(),
    second = await owner(),
    id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO auth_challenges(id,purpose,challenge_hash,browser_hash,expires_at,created_at) VALUES (?,'authenticate',?,?,2,1)",
  )
    .bind(id, id, id)
    .run();
  expect(await bytes(first)).toBe(1024);
  await env.DB.prepare('UPDATE auth_challenges SET owner_id=? WHERE id=?').bind(first, id).run();
  expect(await bytes(first)).toBe(2048);
  await env.DB.prepare('UPDATE auth_challenges SET owner_id=? WHERE id=?').bind(second, id).run();
  expect(await bytes(first)).toBe(1024);
  expect(await bytes(second)).toBe(2048);
  await env.DB.prepare('UPDATE auth_challenges SET owner_id=NULL WHERE id=?').bind(id).run();
  expect(await bytes(second)).toBe(1024);
  await env.DB.prepare('UPDATE auth_challenges SET owner_id=? WHERE id=?').bind(second, id).run();
  await env.DB.prepare('DELETE FROM accounts WHERE id=?').bind(second).run();
  expect(await bytes(first)).toBe(1024);
  expect(await env.DB.prepare('PRAGMA foreign_key_check').all()).toMatchObject({ results: [] });
});

test('reflection erasure releases only its ciphertext and repeat export intents charge no duplicate rows', async () => {
  const { client, kit } = await readingAccount();
  const { started, reading } = await client.create();
  const before = (await bytes(kit.subjectId))!;
  const response = await client.request(`/sessions/${started.sessionId}/reflections`, {
    text: 'Synthetic résumé 🌙',
    stance: 'unsure',
    editionId: reading.editionId,
  });
  const reflection = apiSchemas.Reflection.parse(await response.json());
  const bodyBytes = (await env.DB.prepare(
    'SELECT length(CAST(body_enc AS BLOB)) AS n FROM reflection_revisions WHERE owner_id=?',
  )
    .bind(kit.subjectId)
    .first<number>('n'))!;
  expect(await bytes(kit.subjectId)).toBe(before + 3 * 1024 + bodyBytes);
  const proof = { receiptId: crypto.randomUUID(), receiptToken: randomToken() },
    key = crypto.randomUUID();
  const path = `/reflections/${reflection.id}/revisions/1`;
  expect((await client.request(path, proof, { method: 'DELETE', revision: 1, key })).status).toBe(
    202,
  );
  expect(await bytes(kit.subjectId)).toBe(before + 5 * 1024);
  expect((await client.request(path, proof, { method: 'DELETE', revision: 1, key })).status).toBe(
    202,
  );
  expect(await bytes(kit.subjectId)).toBe(before + 5 * 1024);
  const exportKey = crypto.randomUUID();
  expect((await client.request('/exports', {}, { key: exportKey })).status).toBe(201);
  expect(await bytes(kit.subjectId)).toBe(before + 7 * 1024);
  expect((await client.request('/exports', {}, { key: exportKey })).status).toBe(201);
  expect(await bytes(kit.subjectId)).toBe(before + 7 * 1024);
});

test('cost adjustments follow nullable cost ownership and release once on cascade', async () => {
  const id = await owner(),
    other = await owner(),
    cost = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO spend_buckets VALUES ('synthetic',1000,0)").run();
  await env.DB.prepare(
    "INSERT INTO cost_reservations(id,owner_id,day_period,month_period,state,reserved_microusd,price_basis_json,created_at) VALUES (?,?,'synthetic','synthetic','actual',10,'{}',1)",
  )
    .bind(cost, id)
    .run();
  await env.DB.prepare("INSERT INTO cost_adjustments VALUES ('synthetic',?,10,7,'usage',1)")
    .bind(cost)
    .run();
  expect(await bytes(id)).toBe(3072);
  await env.DB.prepare('UPDATE cost_reservations SET owner_id=? WHERE id=?')
    .bind(other, cost)
    .run();
  expect(await bytes(id)).toBe(1024);
  expect(await bytes(other)).toBe(3072);
  await env.DB.prepare('UPDATE cost_reservations SET owner_id=NULL WHERE id=?').bind(cost).run();
  expect(await bytes(other)).toBe(1024);
  await env.DB.prepare('UPDATE cost_reservations SET owner_id=? WHERE id=?')
    .bind(other, cost)
    .run();
  await env.DB.prepare('DELETE FROM cost_reservations WHERE id=?').bind(cost).run();
  expect(await bytes(other)).toBe(1024);
});

test('metadata capacity blocks new content but preserves export, consent revocation and account deletion', async () => {
  const { client, kit } = await readingAccount();
  const { reading } = await client.create();
  // Real persisted metadata pressure, without manufacturing an inaccurate counter.
  await env.DB.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<20480)
    INSERT INTO export_tickets SELECT 'synthetic-pressure-'||x,?,1,1,9999999999999 FROM n`)
    .bind(kit.subjectId)
    .run();
  expect((await bytes(kit.subjectId))!).toBeGreaterThanOrEqual(20 * 1024 * 1024);
  const requests = await env.DB.prepare(
    'SELECT count(*) AS n FROM generation_requests',
  ).first<number>('n');
  expect((await client.start('Synthetic over-cap request')).status).not.toBe(202);
  expect(
    await env.DB.prepare('SELECT count(*) AS n FROM generation_requests').first<number>('n'),
  ).toBe(requests);
  await client.permission(false);
  expect(await (await client.request(`/readings/${reading.editionId}`)).json()).toEqual(reading);
  expect((await client.request('/exports', {})).status).toBe(201);
  expect(
    (
      await client.request(
        '/account',
        { receiptId: crypto.randomUUID(), receiptToken: randomToken() },
        { method: 'DELETE' },
      )
    ).status,
  ).toBe(202);
  expect(await bytes(kit.subjectId)).toBeNull();
});

test('current and archived revisit bodies charge UTF-8 bytes and one KiB per retained row', async () => {
  const { client, kit } = await readingAccount();
  const { reading } = await client.create();
  const id = crypto.randomUUID(),
    before = (await bytes(kit.subjectId))!;
  await env.DB.prepare(
    'INSERT INTO revisits(id,owner_id,edition_id,session_id,note_enc,key_version,created_at,updated_at) VALUES(?,?,?,?,?,1,1,1)',
  )
    .bind(id, kit.subjectId, reading.editionId, reading.sessionId, 'é😀')
    .run();
  expect(await bytes(kit.subjectId)).toBe(before + 1030);
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO revisit_revisions(revisit_id,owner_id,revision,body_enc,key_version,created_at) VALUES(?,?,1,?,1,1)',
    ).bind(id, kit.subjectId, 'é😀'),
    env.DB.prepare(
      'UPDATE revisits SET note_enc=?,current_revision=2,updated_at=2 WHERE id=?',
    ).bind('界界界', id),
  ]);
  expect(await bytes(kit.subjectId)).toBe(before + 2063);
  await env.DB.batch([
    env.DB.prepare('UPDATE revisits SET note_enc=NULL,deleted_at=3 WHERE id=?').bind(id),
    env.DB.prepare(
      'UPDATE revisit_revisions SET body_enc=NULL,erased_at=3 WHERE revisit_id=?',
    ).bind(id),
  ]);
  expect(await bytes(kit.subjectId)).toBe(before + 2048);
  await env.DB.prepare('DELETE FROM revisits WHERE id=?').bind(id).run();
  expect(await bytes(kit.subjectId)).toBe(before);
});

test('current session endpoint returns the actual retention expiry and null for saved parents', async () => {
  const { client } = await readingAccount();
  const { started } = await client.create();
  const expiry = Date.now() + 1234567;
  await env.DB.prepare('UPDATE reading_sessions SET retention_expires_at=? WHERE id=?')
    .bind(expiry, started.sessionId)
    .run();
  const session = apiSchemas.SessionRecord.parse(
    await (await client.request('/sessions/' + started.sessionId)).json(),
  );
  expect(session.retentionExpiresAt).toBe(new Date(expiry).toISOString());
  const response = await client.request(
    '/sessions/' + started.sessionId + '/save',
    { saved: true },
    { method: 'PUT', revision: session.revision },
  );
  expect(response.status).toBe(200);
  expect(apiSchemas.SessionRecord.parse(await response.json()).retentionExpiresAt).toBeNull();
});
