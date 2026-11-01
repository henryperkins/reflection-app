import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, expect, test } from 'vitest';
import { apiSchemas, Revisit } from '../../src/contracts/index.ts';
import { localIdentity } from '../../src/worker/identity/routes.ts';
import { RecordBase } from '../../src/worker/readings/base.ts';
import { Revisits } from '../../src/worker/readings/revisits.ts';
import { gate } from '../fixtures/barrier.ts';
import { clearDatabase } from '../fixtures/database.ts';
import { readingAccount, readingBindings } from '../fixtures/reading-client.ts';

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(() => clearDatabase(env.DB));
const write = (editionId: string, note = '  Authored 😀 note\n') =>
  apiSchemas.RevisitWrite.parse({ editionId, note });
const edit = (note = 'Edited note') => apiSchemas.RevisitUpdate.parse({ note });
async function fixture(saved = true) {
  const { client, kit } = await readingAccount();
  const { reading, started } = await client.create();
  const identity = localIdentity(readingBindings)!;
  const session = await identity.sessions.get(client.cookies.get('__Host-session'));
  const base = new RecordBase(env.DB, identity);
  if (saved)
    expect(
      (
        await client.request(
          `/sessions/${started.sessionId}/save`,
          { saved: true },
          { method: 'PUT', revision: 1 },
        )
      ).status,
    ).toBe(200);
  return { client, kit, reading, started, session, identity, base, service: new Revisits(base) };
}
async function counts() {
  return env.DB.prepare(
    `SELECT (SELECT count(*) FROM revisits) AS notes,(SELECT count(*) FROM revisit_revisions) AS archives,(SELECT count(*) FROM idempotency_keys) AS receipts,(SELECT sum(storage_bytes) FROM accounts) AS bytes,(SELECT sum(data_revision) FROM accounts) AS revision`,
  ).first();
}
async function legacy(f: Awaited<ReturnType<typeof fixture>>, note = '') {
  const id = crypto.randomUUID(),
    at = Date.now() - 1000;
  const value = Revisit.parse({
    id,
    editionId: f.reading.editionId,
    note,
    createdAt: new Date(at).toISOString(),
  });
  const body = await f.base.crypt.seal(
    {
      ownerId: f.session.subjectId,
      table: 'revisits',
      column: 'note_enc',
      recordId: id,
      aadRevision: 1,
    },
    value,
    1,
  );
  await env.DB.prepare(
    'INSERT INTO revisits(id,owner_id,session_id,edition_id,note_enc,key_version,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)',
  )
    .bind(id, f.session.subjectId, f.started.sessionId, f.reading.editionId, body, at, at)
    .run();
  return { id, value, body };
}

test('AI-off create preserves accepted reading and original reflection without quota or network use', async () => {
  const f = await fixture();
  const reflection = await f.client.request(`/sessions/${f.started.sessionId}/reflections`, {
    text: 'Original reflection',
    editionId: f.reading.editionId,
    stance: 'unsure',
  });
  const original = apiSchemas.Reflection.parse(await reflection.json());
  await f.client.permission(false);
  const before = await f.client.me();
  const first = await f.service.create(f.session, write(f.reading.editionId), crypto.randomUUID());
  expect(first).toMatchObject({
    kind: 'revisit.v2',
    sessionId: f.started.sessionId,
    editionId: f.reading.editionId,
    revision: 1,
    note: '  Authored 😀 note\n',
    stance: 'unspecified',
  });
  expect(first.updatedAt).toBe(first.createdAt);
  expect(await f.service.read(f.session, first.id)).toEqual(first);
  expect(await (await f.client.request(`/readings/${f.reading.editionId}`)).json()).toEqual(
    f.reading,
  );
  expect(await (await f.client.request(`/reflections/${original.id}`)).json()).toEqual(original);
  expect((await f.client.me()).remainingDay).toBe(before.remainingDay);
  expect((await f.client.me()).remainingMonth).toBe(before.remainingMonth);
});

test('exact old-revision retry after a later edit and mismatched key use', async () => {
  const f = await fixture(),
    key = crypto.randomUUID(),
    input = write(f.reading.editionId);
  const first = await f.service.create(f.session, input, key);
  const editKey = crypto.randomUUID();
  const second = await f.service.update(f.session, first.id, 1, editKey, edit('Second'));
  await f.service.update(f.session, first.id, 2, crypto.randomUUID(), edit('Third'));
  expect(await f.service.create(f.session, input, key)).toEqual(first);
  expect(await f.service.update(f.session, first.id, 1, editKey, edit('Second'))).toEqual(second);
  expect(await f.service.read(f.session, first.id, 1)).toEqual(first);
  expect(second.createdAt).toBe(first.createdAt);
  await expect(
    f.service.create(f.session, write(f.reading.editionId, 'Changed'), key),
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' });
  await expect(
    f.service.update(f.session, first.id, 1, crypto.randomUUID(), edit()),
  ).rejects.toMatchObject({ code: 'CONFLICT', revision: 3 });
});

test('100th active note succeeds and 101st fails atomically', async () => {
  const f = await fixture();
  for (let i = 0; i < 99; i++)
    await f.service.create(f.session, write(f.reading.editionId, `Note ${i}`), crypto.randomUUID());
  const first = await f.service.create(
    f.session,
    write(f.reading.editionId, '100th'),
    crypto.randomUUID(),
  );
  expect((await f.service.list(f.session, f.reading.editionId, null)).items).toHaveLength(20);
  expect((await f.service.list(f.session, f.reading.editionId, null, 50)).items).toHaveLength(50);
  await expect(f.service.list(f.session, f.reading.editionId, null, 51)).rejects.toMatchObject({
    code: 'BAD_INPUT',
  });
  const before = await counts();
  await expect(
    f.service.create(f.session, write(f.reading.editionId, '101st'), crypto.randomUUID()),
  ).rejects.toMatchObject({ code: 'NOTE_LIMIT_EXCEEDED' });
  expect(await counts()).toEqual(before);
  // A deleted note no longer consumes an active-note slot.
  await env.DB.prepare('UPDATE revisits SET deleted_at=1 WHERE id=?').bind(first.id).run();
  await f.service.create(f.session, write(f.reading.editionId, 'Replacement'), crypto.randomUUID());
});

test('100th revision succeeds and 101st fails without consuming a revision or receipt', async () => {
  const f = await fixture();
  let current = await f.service.create(f.session, write(f.reading.editionId), crypto.randomUUID());
  for (let i = 2; i <= 100; i++)
    current = await f.service.update(
      f.session,
      current.id,
      i - 1,
      crypto.randomUUID(),
      edit(`Revision ${i}`),
    );
  expect(current.revision).toBe(100);
  const before = await counts();
  await expect(
    f.service.update(f.session, current.id, 100, crypto.randomUUID(), edit()),
  ).rejects.toMatchObject({ code: 'REVISION_LIMIT_EXCEEDED', revision: 100 });
  expect(await counts()).toEqual(before);
  expect(await f.service.read(f.session, current.id, 1)).toMatchObject({
    note: '  Authored 😀 note\n',
  });
});

test('parallel edit CAS leaves one archive and one mutation receipt', async () => {
  const f = await fixture(),
    first = await f.service.create(f.session, write(f.reading.editionId), crypto.randomUUID());
  const barrier = gate((sql) => sql.some((s) => s.includes('INSERT INTO revisit_revisions')));
  const pending = new Revisits(new RecordBase(barrier.db, f.identity)).update(
    f.session,
    first.id,
    1,
    crypto.randomUUID(),
    edit('Loser'),
  );
  const rejected = expect(pending).rejects.toMatchObject({ code: 'CONFLICT', revision: 2 });
  await barrier.ready;
  const winner = await f.service.update(
    f.session,
    first.id,
    1,
    crypto.randomUUID(),
    edit('Winner'),
  );
  const before = await counts();
  barrier.release();
  await rejected;
  expect(await counts()).toEqual(before);
  expect(await f.service.read(f.session, first.id)).toEqual(winner);
  expect(await f.service.read(f.session, first.id, 1)).toEqual(first);
});

test('capacity rollback creates no note/idempotency row and does not change archives or counters', async () => {
  const f = await fixture(),
    first = await f.service.create(f.session, write(f.reading.editionId), crypto.randomUUID());
  await env.DB.prepare('UPDATE accounts SET storage_bytes=20971519 WHERE id=?')
    .bind(f.session.subjectId)
    .run();
  const before = await counts();
  await expect(
    f.service.create(f.session, write(f.reading.editionId), crypto.randomUUID()),
  ).rejects.toMatchObject({ code: 'STORAGE_LIMIT_EXCEEDED' });
  await expect(
    f.service.update(f.session, first.id, 1, crypto.randomUUID(), edit()),
  ).rejects.toMatchObject({ code: 'STORAGE_LIMIT_EXCEEDED' });
  expect(await counts()).toEqual(before);
  expect(await f.service.read(f.session, first.id)).toEqual(first);
});

test('cross-owner and mismatched edition are unavailable before decryption', async () => {
  const f = await fixture(),
    first = await f.service.create(f.session, write(f.reading.editionId), crypto.randomUUID());
  const other = await readingAccount();
  const foreign = await f.identity.sessions.get(other.client.cookies.get('__Host-session'));
  for (const action of [
    () => f.service.create(foreign, write(f.reading.editionId), crypto.randomUUID()),
    () => f.service.read(foreign, first.id),
    () => f.service.list(foreign, f.reading.editionId, null),
    () => f.service.update(foreign, first.id, 1, crypto.randomUUID(), edit()),
  ])
    await expect(action()).rejects.toMatchObject({ code: 'NOT_FOUND' });
  // A valid envelope with an incorrect edition must never be released.
  const corrupted = await f.base.crypt.seal(
    {
      ownerId: f.session.subjectId,
      table: 'revisits',
      column: 'note_enc',
      recordId: first.id,
      aadRevision: 1,
    },
    { ...first, editionId: crypto.randomUUID() },
    1,
  );
  await env.DB.prepare('UPDATE revisits SET note_enc=? WHERE id=?').bind(corrupted, first.id).run();
  await expect(f.service.read(f.session, first.id)).rejects.toMatchObject({
    code: 'KEY_UNAVAILABLE',
  });
  await expect(f.service.list(f.session, f.reading.editionId, null)).rejects.toMatchObject({
    code: 'KEY_UNAVAILABLE',
  });
});

test('withdrawal preserves existing notes but rejects new creation and allows edits', async () => {
  const f = await fixture(),
    first = await f.service.create(f.session, write(f.reading.editionId), crypto.randomUUID());
  await env.DB.prepare("UPDATE content_editions SET state='withdrawn'").run();
  expect(await f.service.read(f.session, first.id)).toEqual(first);
  expect((await f.service.list(f.session, f.reading.editionId, null)).items).toEqual([first]);
  await expect(
    f.service.create(f.session, write(f.reading.editionId), crypto.randomUUID()),
  ).rejects.toMatchObject({ code: 'CONTENT_UNAVAILABLE' });
  expect(
    (await f.service.update(f.session, first.id, 1, crypto.randomUUID(), edit())).revision,
  ).toBe(2);
});

test('unsaved legacy read eligibility uses original expiry and preserves blank text and AAD', async () => {
  const f = await fixture(false),
    old = await legacy(f);
  const expiry = Date.now() + 123456;
  await env.DB.prepare('UPDATE reading_sessions SET retention_expires_at=? WHERE id=?')
    .bind(expiry, f.started.sessionId)
    .run();
  const value = await f.service.read(f.session, old.id);
  expect(value).toMatchObject({
    ...old.value,
    kind: 'revisit.v2',
    sessionId: f.started.sessionId,
    revision: 1,
    stance: 'unspecified',
    updatedAt: old.value.createdAt,
  });
  expect((await f.service.list(f.session, f.reading.editionId, null)).items).toEqual([value]);
  expect(
    await env.DB.prepare('SELECT note_enc FROM revisits WHERE id=?').bind(old.id).first('note_enc'),
  ).toBe(old.body);
  const currentSession = await (await f.client.request(`/sessions/${f.started.sessionId}`)).json();
  expect(currentSession).toMatchObject({
    status: 'open',
    retentionExpiresAt: new Date(expiry).toISOString(),
  });
  await expect(
    f.service.create(f.session, write(f.reading.editionId), crypto.randomUUID()),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(
    f.service.update(f.session, old.id, 1, crypto.randomUUID(), edit()),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await env.DB.prepare('UPDATE reading_sessions SET retention_expires_at=1 WHERE id=?')
    .bind(f.started.sessionId)
    .run();
  await expect(f.service.read(f.session, old.id)).rejects.toMatchObject({
    code: 'CONTENT_UNAVAILABLE',
  });
  await expect(f.service.list(f.session, f.reading.editionId, null)).rejects.toMatchObject({
    code: 'CONTENT_UNAVAILABLE',
  });
});

test('active notes block unsave, including atomic create-versus-unsave interleavings', async () => {
  const f = await fixture();
  const parent = apiSchemas.SessionRecord.parse(
    await (await f.client.request(`/sessions/${f.started.sessionId}`)).json(),
  );
  const barrier = gate((sql) => sql.some((s) => s.includes('UPDATE reading_sessions SET status=')));
  const { ReadingRecords } = await import('../../src/worker/readings/records.ts');
  const pending = new ReadingRecords(new RecordBase(barrier.db, f.identity)).save(
    f.session,
    parent.id,
    parent.revision,
    crypto.randomUUID(),
    false,
  );
  const rejected = expect(pending).rejects.toMatchObject({ code: 'DEPENDENTS_EXIST' });
  await barrier.ready;
  await f.service.create(f.session, write(f.reading.editionId), crypto.randomUUID());
  barrier.release();
  await rejected;
  const response = await f.client.request(
    `/sessions/${parent.id}/save`,
    { saved: false },
    { method: 'PUT', revision: parent.revision },
  );
  expect(apiSchemas.ErrorEnvelope.parse(await response.json()).error.code).toBe('DEPENDENTS_EXIST');
});

test('cursor rejects owner/epoch/edition/order changes and pagination remains ascending without repeats', async () => {
  const f = await fixture();
  const items = [];
  for (let i = 0; i < 4; i++)
    items.push(
      await f.service.create(
        f.session,
        write(f.reading.editionId, `Note ${i}`),
        crypto.randomUUID(),
      ),
    );
  const page = await f.service.list(f.session, f.reading.editionId, null, 2);
  expect(page.items).toEqual(items.slice(0, 2));
  expect(page.nextCursor).toBeTruthy();
  await env.DB.prepare('UPDATE revisits SET deleted_at=1 WHERE id=?').bind(items[0]!.id).run();
  expect((await f.service.list(f.session, f.reading.editionId, page.nextCursor, 2)).items).toEqual(
    items.slice(2),
  );
  const second = await f.client.create();
  await expect(
    f.service.list(f.session, second.reading.editionId, page.nextCursor),
  ).rejects.toMatchObject({ code: 'BAD_INPUT' });
  const other = await readingAccount(),
    foreign = await f.identity.sessions.get(other.client.cookies.get('__Host-session'));
  await expect(f.service.list(foreign, f.reading.editionId, page.nextCursor)).rejects.toMatchObject(
    { code: 'BAD_INPUT' },
  );
  const wrongEpoch = await f.base.cursor(
    f.session,
    ['revisits', f.session.epoch + 1, f.reading.editionId, 'asc'],
    { at: 1, id: items[0]!.id },
  );
  const wrongOrder = await f.base.cursor(
    f.session,
    ['revisits', f.session.epoch, f.reading.editionId, 'desc'],
    { at: 1, id: items[0]!.id },
  );
  for (const cursor of [wrongEpoch, wrongOrder, `${page.nextCursor!}x`])
    await expect(f.service.list(f.session, f.reading.editionId, cursor)).rejects.toMatchObject({
      code: 'BAD_INPUT',
    });
  await env.DB.batch([
    env.DB.prepare('UPDATE accounts SET auth_epoch=auth_epoch+1 WHERE id=?').bind(
      f.session.subjectId,
    ),
    env.DB.prepare('UPDATE auth_sessions SET auth_epoch=auth_epoch+1 WHERE owner_id=?').bind(
      f.session.subjectId,
    ),
  ]);
  const renewed = { ...f.session, epoch: f.session.epoch + 1 };
  await expect(f.service.list(renewed, f.reading.editionId, page.nextCursor)).rejects.toMatchObject(
    { code: 'BAD_INPUT' },
  );
  expect((await f.service.list(renewed, f.reading.editionId, null)).items).toHaveLength(3);
});

test('a replay cannot return deleted text or resurrect a fenced note', async () => {
  const f = await fixture(),
    key = crypto.randomUUID(),
    input = write(f.reading.editionId);
  const first = await f.service.create(f.session, input, key);
  await env.DB.prepare('UPDATE revisits SET deleted_at=1 WHERE id=?').bind(first.id).run();
  await expect(f.service.create(f.session, input, key)).rejects.toMatchObject({
    code: 'CONTENT_UNAVAILABLE',
  });
  await expect(f.service.read(f.session, first.id, 1)).rejects.toMatchObject({
    code: 'CONTENT_UNAVAILABLE',
  });
});

test('concurrent same-key create and edit replay the exact committed revision after later edits', async () => {
  const f = await fixture(),
    key = crypto.randomUUID(),
    input = write(f.reading.editionId);
  const createGate = gate((sql) => sql.some((s) => s.includes('INSERT INTO revisits(')));
  const delayedCreate = new Revisits(new RecordBase(createGate.db, f.identity)).create(
    f.session,
    input,
    key,
  );
  await createGate.ready;
  const first = await f.service.create(f.session, input, key);
  await f.service.update(f.session, first.id, 1, crypto.randomUUID(), edit('Second'));
  const before = await counts();
  createGate.release();
  expect(await delayedCreate).toEqual(first);
  expect(await counts()).toEqual(before);
  const editKey = crypto.randomUUID(),
    inputEdit = edit('Third');
  const editGate = gate((sql) => sql.some((s) => s.includes('INSERT INTO revisit_revisions')));
  const delayedEdit = new Revisits(new RecordBase(editGate.db, f.identity)).update(
    f.session,
    first.id,
    2,
    editKey,
    inputEdit,
  );
  await editGate.ready;
  const third = await f.service.update(f.session, first.id, 2, editKey, inputEdit);
  await f.service.update(f.session, first.id, 3, crypto.randomUUID(), edit('Fourth'));
  const after = await counts();
  editGate.release();
  expect(await delayedEdit).toEqual(third);
  expect(await counts()).toEqual(after);
});

test('concurrent creates at 99 active notes admit only one final note', async () => {
  const f = await fixture();
  for (let i = 0; i < 99; i++)
    await f.service.create(f.session, write(f.reading.editionId, `Note ${i}`), crypto.randomUUID());
  const barrier = gate((sql) => sql.some((s) => s.includes('INSERT INTO revisits(')));
  const pending = new Revisits(new RecordBase(barrier.db, f.identity)).create(
    f.session,
    write(f.reading.editionId, 'Loser'),
    crypto.randomUUID(),
  );
  const rejected = expect(pending).rejects.toMatchObject({ code: 'NOTE_LIMIT_EXCEEDED' });
  await barrier.ready;
  await f.service.create(f.session, write(f.reading.editionId, 'Winner'), crypto.randomUUID());
  const before = await counts();
  barrier.release();
  await rejected;
  expect(await counts()).toEqual(before);
});

test('create rechecks saved parent and withdrawal inside the transaction', async () => {
  const f = await fixture();
  for (const condition of ['unsave', 'withdraw'] as const) {
    const barrier = gate((sql) => sql.some((s) => s.includes('INSERT INTO revisits(')));
    const pending = new Revisits(new RecordBase(barrier.db, f.identity)).create(
      f.session,
      write(f.reading.editionId),
      crypto.randomUUID(),
    );
    const rejected = expect(pending).rejects.toMatchObject({
      code: condition === 'unsave' ? 'FORBIDDEN' : 'CONTENT_UNAVAILABLE',
    });
    await barrier.ready;
    if (condition === 'unsave') {
      const parent = apiSchemas.SessionRecord.parse(
        await (await f.client.request(`/sessions/${f.started.sessionId}`)).json(),
      );
      expect(
        (
          await f.client.request(
            `/sessions/${parent.id}/save`,
            { saved: false },
            { method: 'PUT', revision: parent.revision },
          )
        ).status,
      ).toBe(200);
    } else await env.DB.prepare("UPDATE content_editions SET state='withdrawn'").run();
    const before = await counts();
    barrier.release();
    await rejected;
    expect(await counts()).toEqual(before);
    if (condition === 'unsave') {
      const parent = apiSchemas.SessionRecord.parse(
        await (await f.client.request(`/sessions/${f.started.sessionId}`)).json(),
      );
      await f.client.request(
        `/sessions/${parent.id}/save`,
        { saved: true },
        { method: 'PUT', revision: parent.revision },
      );
    }
  }
});

test('key and recovery-ack guards roll back both create and edit transactions', async () => {
  const f = await fixture(),
    first = await f.service.create(f.session, write(f.reading.editionId), crypto.randomUUID());
  const keys = await f.identity.crypt.createAccountKeys(f.session.subjectId, 2);
  await env.DB.prepare(
    'INSERT INTO account_keys(owner_id,version,wrap_key_id,wrapped_key_enc,wrapped_index_key_enc,created_at) VALUES(?,2,?,?,?,?)',
  )
    .bind(f.session.subjectId, keys.wrapKeyId, keys.wrappedKey, keys.wrappedIndexKey, Date.now())
    .run();
  for (const operation of ['create', 'edit'] as const)
    for (const changed of ['key', 'ack'] as const) {
      const barrier = gate((sql) =>
        sql.some((s) =>
          s.includes(
            operation === 'create' ? 'INSERT INTO revisits(' : 'INSERT INTO revisit_revisions',
          ),
        ),
      );
      const service = new Revisits(new RecordBase(barrier.db, f.identity));
      const pending =
        operation === 'create'
          ? service.create(f.session, write(f.reading.editionId), crypto.randomUUID())
          : service.update(f.session, first.id, 1, crypto.randomUUID(), edit());
      const rejected = expect(pending).rejects.toMatchObject({
        code: changed === 'key' ? 'KEY_UNAVAILABLE' : 'FORBIDDEN',
      });
      await barrier.ready;
      await env.DB.prepare(
        changed === 'key'
          ? 'UPDATE accounts SET key_version=2 WHERE id=?'
          : 'UPDATE accounts SET recovery_ack_at=NULL WHERE id=?',
      )
        .bind(f.session.subjectId)
        .run();
      const before = await counts();
      barrier.release();
      await rejected;
      expect(await counts()).toEqual(before);
      await env.DB.prepare('UPDATE accounts SET key_version=1,recovery_ack_at=1 WHERE id=?')
        .bind(f.session.subjectId)
        .run();
    }
});

test('edit versus deletion rejects the edit without leaving an archive or receipt', async () => {
  const f = await fixture(),
    first = await f.service.create(f.session, write(f.reading.editionId), crypto.randomUUID());
  const barrier = gate((sql) => sql.some((s) => s.includes('INSERT INTO revisit_revisions')));
  const pending = new Revisits(new RecordBase(barrier.db, f.identity)).update(
    f.session,
    first.id,
    1,
    crypto.randomUUID(),
    edit(),
  );
  const rejected = expect(pending).rejects.toMatchObject({ code: 'CONTENT_UNAVAILABLE' });
  await barrier.ready;
  await env.DB.prepare('UPDATE revisits SET deleted_at=1 WHERE id=?').bind(first.id).run();
  const before = await counts();
  barrier.release();
  await rejected;
  expect(await counts()).toEqual(before);
});

test('saved legacy notes can be edited without losing their original blank revision/date', async () => {
  const f = await fixture(),
    old = await legacy(f, '  ');
  const value = await f.service.read(f.session, old.id);
  await f.service.update(f.session, old.id, 1, crypto.randomUUID(), edit('Now nonblank'));
  expect(await f.service.read(f.session, old.id, 1)).toEqual(value);
  expect(await f.service.read(f.session, old.id)).toMatchObject({
    note: 'Now nonblank',
    createdAt: old.value.createdAt,
    revision: 2,
  });
});

test('service rejects new blank/oversized text and forbidden metadata without partial mutations', async () => {
  const f = await fixture(),
    first = await f.service.create(f.session, write(f.reading.editionId), crypto.randomUUID());
  const before = await counts();
  for (const note of ['', ' \n', '😀'.repeat(2001)]) {
    await expect(
      f.service.create(
        f.session,
        { editionId: f.reading.editionId, note, stance: 'unspecified' },
        crypto.randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
    await expect(
      f.service.update(f.session, first.id, 1, crypto.randomUUID(), {
        note,
        stance: 'unspecified',
      }),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
  }
  await expect(
    f.service.update(f.session, first.id, 1, crypto.randomUUID(), {
      ...edit(),
      editionId: crypto.randomUUID(),
    } as never),
  ).rejects.toMatchObject({ code: 'BAD_INPUT' });
  expect(await counts()).toEqual(before);
});

test('final read and list auth checks reject an epoch changed after decryption', async () => {
  const f = await fixture(),
    first = await f.service.create(f.session, write(f.reading.editionId), crypto.randomUUID());
  for (const operation of ['read', 'list'] as const) {
    const barrier = gate((sql) => sql.some((s) => s.includes('data_revision=?')));
    const service = new Revisits(new RecordBase(barrier.db, f.identity));
    const pending =
      operation === 'read'
        ? service.read(f.session, first.id)
        : service.list(f.session, f.reading.editionId, null);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await barrier.ready;
    await env.DB.prepare('UPDATE accounts SET auth_epoch=auth_epoch+1 WHERE id=?')
      .bind(f.session.subjectId)
      .run();
    barrier.release();
    await rejected;
    await env.DB.prepare('UPDATE accounts SET auth_epoch=? WHERE id=?')
      .bind(f.session.epoch, f.session.subjectId)
      .run();
  }
});

test('concurrent writes at the byte boundary admit one whole note and preserve exact accounting', async () => {
  const f = await fixture(),
    input = write(f.reading.editionId);
  const first = await f.service.create(f.session, input, crypto.randomUUID());
  const bodyBytes = await env.DB.prepare(
    'SELECT length(CAST(note_enc AS BLOB)) AS n FROM revisits WHERE id=?',
  )
    .bind(first.id)
    .first<number>('n');
  // One encrypted body, one note row and one mutation receipt fit exactly.
  await env.DB.prepare('UPDATE accounts SET storage_bytes=? WHERE id=?')
    .bind(20971520 - bodyBytes! - 2048, f.session.subjectId)
    .run();
  const barrier = gate((sql) => sql.some((s) => s.includes('INSERT INTO revisits(')));
  const pending = new Revisits(new RecordBase(barrier.db, f.identity)).create(
    f.session,
    input,
    crypto.randomUUID(),
  );
  const rejected = expect(pending).rejects.toMatchObject({ code: 'STORAGE_LIMIT_EXCEEDED' });
  await barrier.ready;
  const winner = await f.service.create(f.session, input, crypto.randomUUID());
  expect(
    await env.DB.prepare('SELECT storage_bytes FROM accounts WHERE id=?')
      .bind(f.session.subjectId)
      .first('storage_bytes'),
  ).toBe(20971520);
  const before = await counts();
  barrier.release();
  await rejected;
  expect(await counts()).toEqual(before);
  expect(await f.service.read(f.session, winner.id)).toEqual(winner);
  expect((await f.service.list(f.session, f.reading.editionId, null)).items).toHaveLength(2);
});

test('write transactions refuse an authentication epoch change without leaving a mutation', async () => {
  const f = await fixture(),
    first = await f.service.create(f.session, write(f.reading.editionId), crypto.randomUUID());
  for (const operation of ['create', 'edit'] as const) {
    const barrier = gate((sql) =>
      sql.some((s) =>
        s.includes(
          operation === 'create' ? 'INSERT INTO revisits(' : 'INSERT INTO revisit_revisions',
        ),
      ),
    );
    const service = new Revisits(new RecordBase(barrier.db, f.identity));
    const pending =
      operation === 'create'
        ? service.create(f.session, write(f.reading.editionId), crypto.randomUUID())
        : service.update(f.session, first.id, 1, crypto.randomUUID(), edit());
    const rejected = expect(pending).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await barrier.ready;
    await env.DB.prepare('UPDATE accounts SET auth_epoch=auth_epoch+1 WHERE id=?')
      .bind(f.session.subjectId)
      .run();
    const before = await counts();
    barrier.release();
    await rejected;
    expect(await counts()).toEqual(before);
    await env.DB.prepare('UPDATE accounts SET auth_epoch=? WHERE id=?')
      .bind(f.session.epoch, f.session.subjectId)
      .run();
  }
});

test('stored identity, date, revision, format and envelope metadata are authenticated', async () => {
  const f = await fixture(),
    first = await f.service.create(f.session, write(f.reading.editionId), crypto.randomUUID());
  const original = await env.DB.prepare('SELECT note_enc FROM revisits WHERE id=?')
    .bind(first.id)
    .first<string>('note_enc');
  for (const changed of [
    { id: crypto.randomUUID() },
    { sessionId: crypto.randomUUID() },
    { revision: 2 },
    { createdAt: '2026-10-01T00:00:00Z' },
    { updatedAt: '2026-10-01T00:00:00Z' },
    { kind: 'unknown' },
  ]) {
    const body = await f.base.crypt.seal(
      {
        ownerId: f.session.subjectId,
        table: 'revisits',
        column: 'note_enc',
        recordId: first.id,
        aadRevision: 1,
      },
      { ...first, ...changed },
      1,
    );
    await env.DB.prepare('UPDATE revisits SET note_enc=? WHERE id=?').bind(body, first.id).run();
    await expect(f.service.read(f.session, first.id)).rejects.toMatchObject({
      code: 'KEY_UNAVAILABLE',
    });
  }
  const wrongAAD = await f.base.crypt.seal(
    {
      ownerId: f.session.subjectId,
      table: 'revisits',
      column: 'note_enc',
      recordId: first.id,
      aadRevision: 2,
    },
    first,
    1,
  );
  await env.DB.prepare('UPDATE revisits SET note_enc=? WHERE id=?').bind(wrongAAD, first.id).run();
  await expect(f.service.read(f.session, first.id)).rejects.toMatchObject({
    code: 'KEY_UNAVAILABLE',
  });
  await env.DB.prepare('UPDATE revisits SET note_enc=? WHERE id=?').bind(original, first.id).run();
  expect(await f.service.read(f.session, first.id)).toEqual(first);
});

test('same-date pagination orders by id and edits preserve chronological position', async () => {
  const f = await fixture(),
    at = Date.now() - 1000;
  const ids = [
    'ffffffff-ffff-4fff-8fff-ffffffffffff',
    '00000000-0000-4000-8000-000000000001',
    '88888888-8888-4888-8888-888888888888',
  ];
  for (const id of ids) {
    const value = Revisit.parse({
      id,
      editionId: f.reading.editionId,
      note: 'Same original date',
      createdAt: new Date(at).toISOString(),
    });
    const body = await f.base.crypt.seal(
      {
        ownerId: f.session.subjectId,
        table: 'revisits',
        column: 'note_enc',
        recordId: id,
        aadRevision: 1,
      },
      value,
      1,
    );
    await env.DB.prepare(
      'INSERT INTO revisits(id,owner_id,session_id,edition_id,note_enc,key_version,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)',
    )
      .bind(id, f.session.subjectId, f.started.sessionId, f.reading.editionId, body, at, at)
      .run();
  }
  await f.service.update(f.session, ids[1]!, 1, crypto.randomUUID(), edit());
  const page = await f.service.list(f.session, f.reading.editionId, null, 1);
  expect(page.items.map((n) => n.id)).toEqual([ids[1]]);
  const next = await f.service.list(f.session, f.reading.editionId, page.nextCursor, 2);
  expect(next.items.map((n) => n.id)).toEqual([ids[2], ids[0]]);
  expect(next.nextCursor).toBeNull();
});
