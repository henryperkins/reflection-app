import { fixture, note, edited } from '../fixtures/revisits.ts';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, expect, test } from 'vitest';
import { apiSchemas, Revisit } from '../../src/contracts/index.ts';
import { randomToken } from '../../src/worker/identity/crypto.ts';
import { RecordBase } from '../../src/worker/readings/base.ts';
import { SessionErasure } from '../../src/worker/readings/erasure.ts';
import { ReadingExports } from '../../src/worker/readings/export.ts';
import { OfflineRestore } from '../../src/worker/recovery/restore.ts';
import { OfflineCleanup } from '../../src/worker/recovery/cleanup.ts';
import { RetentionMaintenance } from '../../src/worker/maintenance/retention.ts';
import { objects } from '../../src/worker/recovery/ledger.ts';
import { gate } from '../fixtures/barrier.ts';
import { clearDatabase } from '../fixtures/database.ts';
import { snapshot, restoreSnapshot } from '../fixtures/snapshot.ts';
import { cleanupBindings, cleanupLedger, localBackup } from '../fixtures/cleanup.ts';
import { ReadingClient, readingAccount } from '../fixtures/reading-client.ts';

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await clearDatabase(env.DB);
  for (const object of await objects(env.RECOVERY, '')) await env.RECOVERY.delete(object.key);
});
const proof = () => ({ receiptId: crypto.randomUUID(), receiptToken: randomToken() });
const failingBucket = () =>
  new Proxy(env.RECOVERY, {
    get(target, property) {
      if (property === 'put')
        return () => {
          throw new Error('Synthetic ledger outage');
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

test('stale note deletion returns current revision without fencing or queuing', async () => {
  const f = await fixture(),
    { first, second } = await edited(f);
  await expect(
    f.erase.removeRevisit(f.session, first.id, 1, crypto.randomUUID(), proof()),
  ).rejects.toMatchObject({ status: 409, code: 'CONFLICT', revision: 2 });
  expect(await f.notes.read(f.session, first.id)).toEqual(second);
  expect((await env.DB.prepare('SELECT * FROM deletion_jobs').all()).results).toEqual([]);
});

test('whole-note deletion erases current and history, spares neighbors and retries accepted receipt after session loss', async () => {
  const f = await fixture(),
    { first } = await edited(f),
    neighbor = await note(f, 'Neighbor');
  const receipt = proof(),
    key = crypto.randomUUID();
  const result = await f.erase.removeRevisit(f.session, first.id, 2, key, receipt);
  expect(result.state).toBe('complete');
  expect(await f.erase.removeRevisit(f.session, first.id, 2, key, receipt)).toEqual(result);
  await expect(f.notes.read(f.session, first.id, 1)).rejects.toMatchObject({ status: 410 });
  expect(await f.notes.read(f.session, neighbor.id)).toEqual(neighbor);
  expect(
    await env.DB.prepare('SELECT note_enc,deleted_at FROM revisits WHERE id=?')
      .bind(first.id)
      .first(),
  ).toMatchObject({ note_enc: null, deleted_at: expect.any(Number) });
  expect(
    await env.DB.prepare('SELECT body_enc,erased_at FROM revisit_revisions WHERE revisit_id=?')
      .bind(first.id)
      .first(),
  ).toMatchObject({ body_enc: null, erased_at: expect.any(Number) });
  await env.DB.prepare('DELETE FROM auth_sessions WHERE owner_id=?').bind(f.kit.subjectId).run();
  const status = await new ReadingClient().request(`/deletions/${receipt.receiptId}`, undefined, {
    headers: { 'X-Deletion-Token': receipt.receiptToken },
  });
  expect(apiSchemas.DeletionStatus.parse(await status.json())).toEqual({
    state: 'complete',
    backupExpiresBy: result.backupExpiresBy,
  });
});

test('ledger outage immediately fences a note and export but keeps ciphertext and pending evidence', async () => {
  const f = await fixture(),
    { first } = await edited(f);
  const ticket = await f.exports.create(f.session, crypto.randomUUID());
  const receipt = proof();
  await expect(
    new SessionErasure(f.base, failingBucket()).removeRevisit(
      f.session,
      first.id,
      2,
      crypto.randomUUID(),
      receipt,
    ),
  ).rejects.toThrow();
  await expect(f.notes.read(f.session, first.id)).rejects.toMatchObject({ status: 410 });
  await expect(f.exports.page(f.session, ticket.id, null)).rejects.toMatchObject({
    code: 'EXPORT_CHANGED',
  });
  expect(
    await env.DB.prepare('SELECT note_enc FROM revisits WHERE id=?')
      .bind(first.id)
      .first('note_enc'),
  ).not.toBeNull();
  expect(
    await env.DB.prepare('SELECT state FROM deletion_jobs WHERE id=?')
      .bind(receipt.receiptId)
      .first('state'),
  ).toBe('ledger_pending');
  await new RetentionMaintenance(env.DB).run();
  await expect(new OfflineCleanup(cleanupBindings(), localBackup()).run()).rejects.toThrow(
    /pending/i,
  );
  await new OfflineRestore(cleanupBindings()).prepare();
  expect(
    await env.DB.prepare('SELECT state FROM deletion_jobs WHERE id=?')
      .bind(receipt.receiptId)
      .first('state'),
  ).toBe('complete');
});

test('export yields every exact note revision, dates and stance without keys, including withdrawn parents', async () => {
  const f = await fixture(),
    { first, second } = await edited(f);
  await f.client.permission(false);
  await env.DB.prepare("UPDATE reading_editions SET status='withdrawn',invalidated_at=1 WHERE id=?")
    .bind(f.reading.editionId)
    .run();
  const ticket = await f.exports.create(f.session, crypto.randomUUID());
  const page = await f.exports.page(f.session, ticket.id, null);
  const notes = page.records.filter((r) => r.kind === 'revisit');
  expect(notes.map((r) => r.value)).toEqual([first, second]);
  expect(notes.map((r) => r.identity.recordRevision)).toEqual([1, 2]);
  expect(JSON.stringify(page)).not.toMatch(/wrapped_key|key_version|note_enc|body_enc/);
});

test.each(['edit', 'session', 'account'] as const)(
  '%s admission invalidates a partially read export',
  async (action) => {
    const f = await fixture(),
      first = await note(f);
    // The first hundred permission records force a real second page containing notes.
    await env.DB.prepare(
      "WITH RECURSIVE n(x) AS (SELECT 10 UNION ALL SELECT x+1 FROM n WHERE x<110) INSERT INTO permission_revisions(owner_id,revision,model_allowed,policy_version,created_at) SELECT ?,x,0,'egress.v1',1 FROM n",
    )
      .bind(f.kit.subjectId)
      .run();
    const ticket = await f.exports.create(f.session, crypto.randomUUID());
    const page = await f.exports.page(f.session, ticket.id, null);
    expect(page.records).toHaveLength(100);
    expect(page.nextCursor).not.toBeNull();
    if (action === 'edit')
      await f.notes.update(
        f.session,
        first.id,
        1,
        crypto.randomUUID(),
        apiSchemas.RevisitUpdate.parse({ note: 'Updated' }),
      );
    else {
      const blocked = new SessionErasure(f.base, failingBucket());
      await expect(
        action === 'session'
          ? blocked.remove(f.session, f.started.sessionId, 2, crypto.randomUUID(), proof())
          : blocked.removeAccount(f.session, crypto.randomUUID(), proof()),
      ).rejects.toThrow();
    }
    await expect(f.exports.page(f.session, ticket.id, page.nextCursor)).rejects.toThrow();
  },
);

test.each(['session', 'account'] as const)('%s deletion erases both note stores', async (scope) => {
  const f = await fixture(),
    { first } = await edited(f);
  if (scope === 'session')
    await f.erase.remove(f.session, f.started.sessionId, 2, crypto.randomUUID(), proof());
  else await f.erase.removeAccount(f.session, crypto.randomUUID(), proof());
  expect(
    (
      await env.DB.prepare('SELECT note_enc FROM revisits WHERE id=? AND note_enc IS NOT NULL')
        .bind(first.id)
        .all()
    ).results,
  ).toEqual([]);
  expect(
    (
      await env.DB.prepare(
        'SELECT body_enc FROM revisit_revisions WHERE revisit_id=? AND body_enc IS NOT NULL',
      )
        .bind(first.id)
        .all()
    ).results,
  ).toEqual([]);
});

test.each(['create', 'edit', 'delete'] as const)(
  'two restore passes from before %s cannot revive an erased note or shorten deadlines',
  async (bookmark) => {
    const f = await fixture();
    let saved = await snapshot(env.DB);
    const first = await note(f);
    if (bookmark === 'edit') saved = await snapshot(env.DB);
    await f.notes.update(
      f.session,
      first.id,
      1,
      crypto.randomUUID(),
      apiSchemas.RevisitUpdate.parse({ note: 'Future revision' }),
    );
    if (bookmark === 'delete') saved = await snapshot(env.DB);
    const receipt = proof();
    await f.erase.removeRevisit(f.session, first.id, 2, crypto.randomUUID(), receipt);
    let deadline = (await cleanupLedger().load(receipt.receiptId)).completion!.backupExpiresBy;
    for (let pass = 0; pass < 2; pass++) {
      const restore = new OfflineRestore(cleanupBindings());
      await restore.prepare();
      await restoreSnapshot(env.DB, saved);
      await restore.replay();
      expect(
        await env.DB.prepare(
          'SELECT id FROM revisits WHERE id=? AND (deleted_at IS NULL OR note_enc IS NOT NULL)',
        )
          .bind(first.id)
          .first(),
      ).toBeNull();
      expect(
        await env.DB.prepare(
          'SELECT revisit_id FROM revisit_revisions WHERE revisit_id=? AND (erased_at IS NULL OR body_enc IS NOT NULL)',
        )
          .bind(first.id)
          .first(),
      ).toBeNull();
      const chain = await cleanupLedger().load(receipt.receiptId);
      expect(chain.passes).toHaveLength(pass + 2);
      if (bookmark !== 'create')
        expect(
          await env.DB.prepare('SELECT deletion_job_id FROM revisits WHERE id=?')
            .bind(first.id)
            .first('deletion_job_id'),
        ).toBe(receipt.receiptId);
      expect(chain.completion!.backupExpiresBy >= deadline).toBe(true);
      deadline = chain.completion!.backupExpiresBy;
    }
  },
);

test('legacy unsaved notes normalize for export before expiry and disappear after expiry', async () => {
  const f = await fixture();
  await f.client.request(
    `/sessions/${f.started.sessionId}/save`,
    { saved: false },
    { method: 'PUT', revision: 2 },
  );
  const id = crypto.randomUUID(),
    at = Date.now() - 1000;
  const legacy = Revisit.parse({
    id,
    editionId: f.reading.editionId,
    note: '',
    createdAt: new Date(at).toISOString(),
  });
  const body = await f.base.crypt.seal(
    {
      ownerId: f.kit.subjectId,
      table: 'revisits',
      column: 'note_enc',
      recordId: id,
      aadRevision: 1,
    },
    legacy,
    1,
  );
  await env.DB.prepare(
    'INSERT INTO revisits(id,owner_id,edition_id,session_id,note_enc,key_version,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)',
  )
    .bind(id, f.kit.subjectId, f.reading.editionId, f.started.sessionId, body, at, at)
    .run();
  const ticket = await f.exports.create(f.session, crypto.randomUUID());
  const page = await f.exports.page(f.session, ticket.id, null);
  expect(page.records.find((r) => r.kind === 'revisit')?.value).toMatchObject({
    kind: 'revisit.v2',
    note: '',
    revision: 1,
    stance: 'unspecified',
    createdAt: legacy.createdAt,
    updatedAt: legacy.createdAt,
  });
  await env.DB.prepare('UPDATE reading_sessions SET retention_expires_at=1 WHERE id=?')
    .bind(f.started.sessionId)
    .run();
  const later = await f.exports.create(f.session, crypto.randomUUID());
  expect(
    (await f.exports.page(f.session, later.id, null)).records.filter((r) => r.kind === 'revisit'),
  ).toEqual([]);
});

test('note routes enforce preconditions, owner/CSRF checks, exact revision ETags and receipt replay', async () => {
  const f = await fixture();
  const input = { editionId: f.reading.editionId, note: 'Public note' },
    key = crypto.randomUUID();
  const created = await f.client.request('/revisits', input, { key });
  expect(created.status).toBe(201);
  expect(created.headers.get('ETag')).toBe('"1"');
  expect(created.headers.get('Cache-Control')).toBe('private, no-store');
  const one = apiSchemas.Revisit.parse(await created.json());
  const path = `/revisits/${one.id}`;
  expect((await f.client.request('/revisits', input, { key })).status).toBe(201);
  expect((await f.client.request(path, { note: 'Second' }, { method: 'PUT' })).status).toBe(428);
  expect(
    (
      await f.client.request(
        path,
        { note: 'Second' },
        { method: 'PUT', headers: { 'If-Match': '"9007199254740992"' } },
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await f.client.request(
        path,
        { note: 'Second' },
        { method: 'PUT', revision: 1, headers: { 'X-CSRF-Token': 'invalid' } },
      )
    ).status,
  ).toBe(403);
  const other = await readingAccount();
  expect((await other.client.request(path)).status).toBe(404);
  expect(
    (await other.client.request(path, proof(), { method: 'DELETE', revision: 1 })).status,
  ).toBe(404);
  const update = await f.client.request(
    path,
    { note: 'Second', stance: 'resonates' },
    { method: 'PUT', revision: 1 },
  );
  expect(update.status).toBe(200);
  expect(update.headers.get('ETag')).toBe('"2"');
  const old = await f.client.request(`${path}?revision=1`);
  expect(old.headers.get('ETag')).toBe('"1"');
  expect(await old.json()).toEqual(one);
  expect(
    apiSchemas.RevisitPage.parse(
      await (await f.client.request(`/revisits?editionId=${one.editionId}&limit=1`)).json(),
    ).items[0]?.revision,
  ).toBe(2);
  const receipt = proof();
  const stale = await f.client.request(path, receipt, { method: 'DELETE', revision: 1 });
  expect(stale.status).toBe(409);
  expect(apiSchemas.ErrorEnvelope.parse(await stale.json()).error.currentRevision).toBe(2);
  expect((await f.client.request(path, receipt, { method: 'DELETE', revision: 2 })).status).toBe(
    202,
  );
  expect((await f.client.request('/revisits', input, { key })).status).toBe(410);
});

test('a winning edit makes a queued delete stale without fencing the newer note', async () => {
  const f = await fixture(),
    first = await note(f);
  const held = gate((sql) => sql.some((s) => s.includes('INSERT INTO deletion_jobs')));
  const erasure = new SessionErasure(new RecordBase(held.db, f.base.identity), env.RECOVERY);
  const deletion = erasure.removeRevisit(f.session, first.id, 1, crypto.randomUUID(), proof());
  const outcome = deletion.catch((error: unknown) => error);
  await held.ready;
  try {
    await f.notes.update(
      f.session,
      first.id,
      1,
      crypto.randomUUID(),
      apiSchemas.RevisitUpdate.parse({ note: 'Concurrent edit' }),
    );
  } finally {
    held.release();
  }
  expect(await outcome).toMatchObject({ status: 409, revision: 2 });
  expect((await f.notes.read(f.session, first.id)).note).toBe('Concurrent edit');
  expect((await env.DB.prepare('SELECT * FROM deletion_jobs').all()).results).toEqual([]);
});

test('a deletion during export decryption prevents releasing the page', async () => {
  const f = await fixture(),
    first = await note(f);
  const ticket = await f.exports.create(f.session, crypto.randomUUID());
  let guards = 0;
  const held = gate(
    (sql) =>
      sql.some((s) => s.includes('INSERT INTO assertion_probe') && s.includes('export_tickets')) &&
      ++guards === 2,
  );
  const exporting = new ReadingExports(new RecordBase(held.db, f.base.identity)).page(
    f.session,
    ticket.id,
    null,
  );
  const outcome = exporting.catch((error: unknown) => error);
  await held.ready;
  try {
    await f.erase.removeRevisit(f.session, first.id, 1, crypto.randomUUID(), proof());
  } finally {
    held.release();
  }
  expect(await outcome).toMatchObject({ code: 'EXPORT_CHANGED' });
});

test('note erasure detaches exact imported aliases without opening unsupported import export', async () => {
  const f = await fixture(),
    first = await note(f);
  await env.DB.prepare(
    "INSERT INTO import_identities(owner_id,source_key_hmac,source_entity_hmac,original_hmac,session_id,entity_kind,revisit_id,source_record_enc,key_version) VALUES(?,'synthetic-alias','synthetic-entity','synthetic-original',?,'revisit',?,'synthetic-opaque-source',1)",
  )
    .bind(f.kit.subjectId, f.started.sessionId, first.id)
    .run();
  await f.erase.removeRevisit(f.session, first.id, 1, crypto.randomUUID(), proof());
  expect(
    await env.DB.prepare(
      'SELECT source_record_enc,session_id,revisit_id,erased_at FROM import_identities',
    ).first(),
  ).toEqual({
    source_record_enc: null,
    session_id: null,
    revisit_id: null,
    erased_at: expect.any(Number),
  });
  const ticket = await f.exports.create(f.session, crypto.randomUUID());
  await expect(f.exports.page(f.session, ticket.id, null)).rejects.toMatchObject({
    code: 'DEPENDENCY_UNAVAILABLE',
  });
});

test('export pagination includes more than one hundred note snapshots exactly once', async () => {
  const f = await fixture(),
    first = await note(f, 'First'),
    second = await note(f, 'Second');
  for (const value of [first, second])
    for (let revision = 1; revision < 52; revision++)
      await f.notes.update(
        f.session,
        value.id,
        revision,
        crypto.randomUUID(),
        apiSchemas.RevisitUpdate.parse({ note: `${value.note} ${revision + 1}` }),
      );
  const ticket = await f.exports.create(f.session, crypto.randomUUID());
  const records = [];
  let cursor: string | null = null;
  do {
    const page = await f.exports.page(f.session, ticket.id, cursor);
    expect(page.records.length).toBeLessThanOrEqual(100);
    records.push(...page.records.filter((r) => r.kind === 'revisit'));
    cursor = page.nextCursor;
  } while (cursor);
  expect(records).toHaveLength(104);
  for (const value of [first, second]) {
    const revisions = records.filter((r) => r.originalId === value.id);
    expect(revisions.map((r) => r.identity.recordRevision)).toEqual(
      Array.from({ length: 52 }, (_, i) => i + 1),
    );
    expect(revisions[0]!.value.note).toBe(value.note);
    expect(revisions.at(-1)!.value.note).toBe(`${value.note} 52`);
  }
});
