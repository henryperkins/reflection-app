import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { expect, test } from 'vitest';
import { Revisit } from '../../src/contracts/index.ts';
import { RecordCrypto } from '../../src/worker/readings/crypto.ts';
import { IdentityCrypto } from '../../src/worker/identity/crypto.ts';
import { runtimeSecrets } from '../fixtures/runtime.ts';
import { OWNER, OTHER, seedDatabase } from '../fixtures/database.ts';

test('0017 preserves populated legacy note ciphertext, dates, expiry, aliases and accounting', async () => {
  const db = env.MIGRATION_DB;
  await applyD1Migrations(
    db,
    env.TEST_MIGRATIONS.filter((m) => m.name < '0017'),
  );
  await seedDatabase(db);
  const crypt = new RecordCrypto(db, new IdentityCrypto(runtimeSecrets('migration-revisit')));
  // Use real account wraps for valid legacy public payloads, independently of low-level crypto fixtures.
  const keys = await crypt.identity.createAccountKeys(OWNER, 1);
  await db
    .prepare(
      'UPDATE account_keys SET wrap_key_id=?,wrapped_key_enc=?,wrapped_index_key_enc=? WHERE owner_id=?',
    )
    .bind(keys.wrapKeyId, keys.wrappedKey, keys.wrappedIndexKey, OWNER)
    .run();
  const fixtures = [];
  for (const [status, expiry] of [
    ['saved', null],
    ['open', 9999999999999],
    ['open', 1],
  ] as const) {
    const session = crypto.randomUUID(),
      edition = crypto.randomUUID(),
      id = crypto.randomUUID();
    const value = Revisit.parse({
      id,
      editionId: edition,
      note: 'Legacy authored 😀 note',
      createdAt: '2026-10-01T00:00:00Z',
    });
    const body = await crypt.seal(
      { ownerId: OWNER, table: 'revisits', column: 'note_enc', recordId: id, aadRevision: 1 },
      value,
      1,
    );
    await db.batch([
      db
        .prepare(
          "INSERT INTO reading_sessions(id,owner_id,status,question_enc,created_at,saved_at,retention_expires_at) VALUES(?,?,?,'synthetic-crypto-fixture',10,?,?)",
        )
        .bind(session, OWNER, status, status === 'saved' ? 10 : null, expiry),
      db
        .prepare(
          "INSERT INTO reading_editions(id,owner_id,session_id,edition_number,status,mode,body_enc,key_version,accepted_at) VALUES(?,?,?,1,'imported','legacy','synthetic-crypto-fixture',1,10)",
        )
        .bind(edition, OWNER, session),
      db
        .prepare(
          'INSERT INTO revisits(id,owner_id,edition_id,note_enc,key_version,created_at) VALUES(?,?,?,?,1,1790812800000)',
        )
        .bind(id, OWNER, edition, body),
    ]);
    fixtures.push({ session, edition, id, body, value, expiry });
  }
  const first = fixtures[0]!;
  await db
    .prepare(
      "INSERT INTO import_identities(owner_id,source_key_hmac,source_entity_hmac,original_hmac,session_id,entity_kind,revisit_id,key_version) VALUES(?,'alias','entity','original',?,'revisit',?,1)",
    )
    .bind(OWNER, first.session, first.id)
    .run();
  const job = crypto.randomUUID();
  await db
    .prepare(
      "INSERT INTO deletion_jobs(id,owner_id,scope,target_hmac,target_enc,state,ledger_key,next_run_at,created_at) VALUES(?,?,'session','old-target','synthetic-recovery-envelope','ledger_pending',?,10,10)",
    )
    .bind(job, OWNER, job)
    .run();
  const oldJob = await db.prepare('SELECT * FROM deletion_jobs WHERE id=?').bind(job).first();
  const before = await db
    .prepare('SELECT storage_bytes FROM accounts WHERE id=?')
    .bind(OWNER)
    .first('storage_bytes');
  const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith('0017'));
  expect(migration).toBeDefined();
  const drop = migration!.queries.findIndex((query) => query.includes('DROP TABLE revisits'));
  expect(drop).toBeGreaterThan(0);
  await expect(
    applyD1Migrations(db, [
      {
        ...migration!,
        queries: [
          ...migration!.queries.slice(0, drop + 1),
          'INSERT INTO assertion_probe VALUES(0)',
          ...migration!.queries.slice(drop + 1),
        ],
      },
    ]),
  ).rejects.toThrow();
  expect(
    await db.prepare('SELECT note_enc FROM revisits WHERE id=?').bind(first.id).first('note_enc'),
  ).toBe(first.body);
  expect(
    await db
      .prepare('SELECT storage_bytes FROM accounts WHERE id=?')
      .bind(OWNER)
      .first('storage_bytes'),
  ).toBe(before);
  await applyD1Migrations(db, [migration!]);
  expect(await db.prepare('SELECT * FROM deletion_jobs WHERE id=?').bind(job).first()).toEqual(
    oldJob,
  );
  for (const f of fixtures) {
    expect(await db.prepare('SELECT * FROM revisits WHERE id=?').bind(f.id).first()).toMatchObject({
      note_enc: f.body,
      current_revision: 1,
      session_id: f.session,
      created_at: 1790812800000,
      updated_at: 1790812800000,
      deleted_at: null,
    });
    expect(
      await db
        .prepare('SELECT retention_expires_at FROM reading_sessions WHERE id=?')
        .bind(f.session)
        .first('retention_expires_at'),
    ).toBe(f.expiry);
    expect(
      await crypt.open(
        { ownerId: OWNER, table: 'revisits', column: 'note_enc', recordId: f.id, aadRevision: 1 },
        f.body,
        Revisit,
      ),
    ).toEqual(f.value);
  }
  expect(await db.prepare('SELECT revisit_id FROM import_identities').first('revisit_id')).toBe(
    first.id,
  );
  expect(
    await db
      .prepare('SELECT storage_bytes FROM accounts WHERE id=?')
      .bind(OWNER)
      .first('storage_bytes'),
  ).toBe(before);
  expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  await expect(
    db
      .prepare('UPDATE revisits SET session_id=? WHERE id=?')
      .bind(fixtures[1]!.session, first.id)
      .run(),
  ).rejects.toThrow();
  await expect(
    db.prepare('UPDATE revisits SET note_enc=NULL WHERE id=?').bind(first.id).run(),
  ).rejects.toThrow();
  await expect(
    db
      .prepare(
        'INSERT INTO revisit_revisions(revisit_id,owner_id,revision,body_enc,key_version,created_at) VALUES(?,?,1,?,1,10)',
      )
      .bind(first.id, OTHER, 'foreign crypto fixture')
      .run(),
  ).rejects.toThrow();
  await db
    .prepare(
      'INSERT INTO revisit_revisions(revisit_id,owner_id,revision,body_enc,key_version,created_at) VALUES(?,?,1,?,1,10)',
    )
    .bind(first.id, OWNER, 'é😀')
    .run();
  expect(
    await db
      .prepare('SELECT storage_bytes FROM accounts WHERE id=?')
      .bind(OWNER)
      .first('storage_bytes'),
  ).toBe(Number(before) + 1030);
  await expect(db.prepare('UPDATE revisit_revisions SET body_enc=NULL').run()).rejects.toThrow();
  await db.prepare('UPDATE revisit_revisions SET body_enc=NULL,erased_at=20').run();
  expect(
    await db
      .prepare('SELECT storage_bytes FROM accounts WHERE id=?')
      .bind(OWNER)
      .first('storage_bytes'),
  ).toBe(Number(before) + 1024);
});
