import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { z } from 'zod';
import { beforeAll, beforeEach, expect, test } from 'vitest';
import { localIdentity } from '../../src/worker/identity/routes.ts';
import { RecordCrypto, type RecordFieldIdentity } from '../../src/worker/readings/crypto.ts';
import { readingAccount } from '../fixtures/reading-client.ts';
import { clearDatabase } from '../fixtures/database.ts';
import { apiSchemas } from '../../src/contracts/index.ts';
beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(() => clearDatabase(env.DB));
async function fixture() {
  const { client } = await readingAccount(),
    identity = localIdentity(client.bindings)!;
  const session = await identity.sessions.get(client.cookies.get('__Host-session'));
  const records = new RecordCrypto(env.DB, identity.crypt);
  const prior = await env.DB.prepare(
    'SELECT wrapped_index_key_enc FROM account_keys WHERE owner_id=? AND version=1',
  )
    .bind(session.subjectId)
    .first<string>('wrapped_index_key_enc');
  const index = await identity.crypt.unwrapAccountKey(session.subjectId, prior!, 'index', 1);
  const next = await identity.crypt.createAccountDataVersion(session.subjectId, 2, index);
  await env.DB.prepare('INSERT INTO account_keys VALUES(?,?,?,?,?,?)')
    .bind(session.subjectId, 2, next.wrapKeyId, next.wrappedKey, next.wrappedIndexKey, Date.now())
    .run();
  const field: RecordFieldIdentity = {
    ownerId: session.subjectId,
    table: 'reading_sessions',
    column: 'question_enc',
    recordId: crypto.randomUUID(),
    aadRevision: 1,
  };
  return { client, identity, session, records, field };
}

test('registered retained versions decrypt exactly and ordinary DEK replacement preserves stable index HMACs', async () => {
  const f = await fixture(),
    schema = z.strictObject({ text: z.string() }),
    value = { text: 'Synthetic retained content' };
  const first = await f.records.seal(f.field, value, 1),
    second = await f.records.seal(f.field, value, 2);
  expect(await f.records.open(f.field, first, schema)).toEqual(value);
  expect(await f.records.open(f.field, second, schema)).toEqual(value);
  const before = await f.records.hash(f.session.subjectId, 'mutation', { same: 'identity' });
  await env.DB.prepare('UPDATE accounts SET key_version=2 WHERE id=?')
    .bind(f.session.subjectId)
    .run();
  expect(
    await new RecordCrypto(env.DB, f.identity.crypt).hash(f.session.subjectId, 'mutation', {
      same: 'identity',
    }),
  ).toBe(before);
  expect(JSON.parse(first).nonce).not.toBe(JSON.parse(second).nonce);
});

test('owner, field, immutable revision, envelope version and missing key tampering fail authentication', async () => {
  const f = await fixture(),
    body = await f.records.seal(f.field, { text: 'Synthetic private field' }, 2);
  for (const change of [
    { ownerId: crypto.randomUUID() },
    { table: 'basis_snapshots' },
    { column: 'body_enc' },
    { recordId: crypto.randomUUID() },
    { aadRevision: 2 },
  ])
    await expect(f.records.open({ ...f.field, ...change }, body, z.unknown())).rejects.toThrow();
  const changed = JSON.stringify({ ...JSON.parse(body), keyVersion: 1 });
  await expect(f.records.open(f.field, changed, z.unknown())).rejects.toThrow();
  await env.DB.prepare('DELETE FROM account_keys WHERE owner_id=? AND version=2')
    .bind(f.session.subjectId)
    .run();
  await expect(
    new RecordCrypto(env.DB, f.identity.crypt).open(f.field, body, z.unknown()),
  ).rejects.toThrow();
});

test('new readings and reflections use current v2 while exact v1 readings and exports remain readable', async () => {
  const f = await fixture(),
    old = await f.client.create('Synthetic old saved content before DEK replacement.');
  await f.client.request(
    '/sessions/' + old.reading.sessionId + '/save',
    { saved: true },
    { method: 'PUT', revision: 1 },
  );
  await env.DB.prepare('UPDATE accounts SET key_version=2 WHERE id=?')
    .bind(f.session.subjectId)
    .run();
  const reflection = await f.client.request('/sessions/' + old.reading.sessionId + '/reflections', {
    text: 'Synthetic new reflection after key replacement',
    stance: 'unspecified',
    editionId: old.reading.editionId,
  });
  expect(reflection.status).toBe(201);
  expect(
    await env.DB.prepare('SELECT key_version FROM reflection_revisions').first('key_version'),
  ).toBe(2);
  const created = await f.client.create('Synthetic new reading at current version two.');
  expect(
    await env.DB.prepare('SELECT key_version FROM reading_editions WHERE id=?')
      .bind(created.reading.editionId)
      .first('key_version'),
  ).toBe(2);
  expect(await (await f.client.request('/readings/' + old.reading.editionId)).json()).toEqual(
    old.reading,
  );
  const ticket = apiSchemas.ExportTicket.parse(
    await (await f.client.request('/exports', {})).json(),
  );
  const exported = await (await f.client.request('/exports/' + ticket.id)).text();
  expect(exported).toContain('Synthetic new reflection after key replacement');
  expect(exported).toContain(old.reading.editionId);
});
