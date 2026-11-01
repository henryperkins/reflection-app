import { encode } from '../../src/worker/identity/crypto.ts';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, expect, test } from 'vitest';
import { z } from 'zod';
import { AccountRekey } from '../../src/worker/recovery/account-rekey.ts';
import { ACCOUNT_FIELD_HANDLERS } from '../../src/worker/recovery/private-fields.ts';
import {
  createRuntime,
  createRuntimeWorker,
  type RuntimeBindings,
} from '../../src/worker/runtime/application.ts';
import { RecordBase } from '../../src/worker/readings/base.ts';
import { snapshot, restoreSnapshot } from '../fixtures/snapshot.ts';
import { OfflineRestore } from '../../src/worker/recovery/restore.ts';
import { localDevelopmentBundle } from '../../src/worker/readings/local-content.ts';
import { RecordCrypto } from '../../src/worker/readings/crypto.ts';
import { objects } from '../../src/worker/recovery/ledger.ts';
import { runtimeManifest, runtimeSecrets } from '../fixtures/runtime.ts';
import { readingAccount, ReadingClient } from '../fixtures/reading-client.ts';
import { clearDatabase } from '../fixtures/database.ts';
import { backupInventoryFixture, attestRecoveryFixture } from '../fixtures/backup-inventory.ts';
beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await clearDatabase(env.DB);
  for (const object of await objects(env.RECOVERY, '')) await env.RECOVERY.delete(object.key);
});

async function fixture(revisions = 2) {
  const m = runtimeManifest();
  m.environmentId = 'rekey-' + crypto.randomUUID();
  m.ingress = 'on';
  m.generation = 'intercepted';
  const b: RuntimeBindings = {
    DB: env.DB,
    RECOVERY: env.RECOVERY,
    OFFLINE_COORDINATOR: env.OFFLINE_COORDINATOR,
    RECOVERY_CONTROL_SECRET: 'synthetic-offline-control-token-not-a-deployed-secret',
    RUNTIME_MANIFEST: JSON.stringify(m),
    RUNTIME_RESOURCE_IDENTITIES: JSON.stringify(m.resources),
    IDENTITY_ORIGIN: m.origin,
    IDENTITY_SECRETS: JSON.stringify(runtimeSecrets(m.environmentId)),
  };
  const client = new ReadingClient(b, createRuntimeWorker());
  await readingAccount(true, true, client);
  const created = await client.create(
    'Synthetic complete rekey must preserve exact private content.',
  );
  const reflection = (await (
    await client.request('/sessions/' + created.reading.sessionId + '/reflections', {
      text: 'Synthetic revision 1',
      stance: 'unspecified',
      editionId: created.reading.editionId,
    })
  ).json()) as { id: string };
  for (let revision = 2; revision <= revisions; revision++)
    expect(
      (
        await client.request(
          '/reflections/' + reflection.id,
          {
            text: 'Synthetic revision ' + revision,
            stance: 'unspecified',
            editionId: created.reading.editionId,
          },
          { method: 'PUT', revision: revision - 1 },
        )
      ).status,
    ).toBe(200);
  const runtime = await createRuntime(b),
    owner = (await runtime.identity.sessions.get(client.cookies.get('__Host-session'))).subjectId;
  return {
    b,
    client,
    runtime,
    owner,
    created,
    service: new AccountRekey(runtime.base, runtime.coordinator!),
  };
}
async function values(f: Awaited<ReturnType<typeof fixture>>) {
  const records = new RecordCrypto(env.DB, f.runtime.identity.crypt),
    result: Record<string, unknown> = {};
  for (const field of ACCOUNT_FIELD_HANDLERS) {
    const rows = (
      await env.DB.prepare(
        `SELECT * FROM ${field.table} WHERE owner_id=? AND ${field.column} IS NOT NULL ORDER BY ${field.keyColumns.join(',')}`,
      )
        .bind(f.owner)
        .all<Record<string, unknown>>()
    ).results;
    for (const row of rows) {
      const body = row[field.column] as string,
        identity = field.identity(row, body);
      result[field.table + '.' + field.column + ':' + identity.recordId] = {
        value: await records.open(identity, body, z.unknown()),
        aadRevision: identity.aadRevision,
      };
    }
  }
  return result;
}

async function deferredFields(f: Awaited<ReturnType<typeof fixture>>) {
  const owner = f.owner,
    edition = f.created.reading.editionId,
    request = (await env.DB.prepare('SELECT id FROM generation_requests LIMIT 1').first<string>(
      'id',
    ))!;
  const encrypt = (
    table: string,
    column: string,
    recordId: string,
    value: unknown,
    aadRevision = 1,
  ) =>
    f.runtime.base.crypt.seal({ ownerId: owner, table, column, recordId, aadRevision }, value, 1);
  const batch = crypto.randomUUID(),
    revisit = crypto.randomUUID(),
    grant = crypto.randomUUID(),
    draft = crypto.randomUUID(),
    dispatch = (await env.DB.prepare('SELECT id FROM provider_dispatches LIMIT 1').first<string>(
      'id',
    ))!;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO import_batches VALUES(?,?,'synthetic',?,'preview',?,?)").bind(
      batch,
      owner,
      'a'.repeat(64),
      Date.now(),
      Date.now() + 86400000,
    ),
    env.DB.prepare(
      "INSERT INTO import_items(batch_id,owner_id,item_index,source_key_hmac,original_hmac,body_enc,key_version,state,session_id) VALUES(?,?,0,?,?,?,1,'ready',?)",
    ).bind(
      batch,
      owner,
      'b'.repeat(64),
      'c'.repeat(64),
      await encrypt('import_items', 'body_enc', batch + ':0', {
        original: 'Synthetic deferred import',
      }),
      f.created.reading.sessionId,
    ),
    env.DB.prepare(
      "INSERT INTO import_identities(owner_id,source_key_hmac,source_entity_hmac,original_hmac,session_id,entity_kind,source_record_enc,key_version) VALUES(?,?,?,?,?,'session',?,1)",
    ).bind(
      owner,
      'd'.repeat(64),
      'e'.repeat(64),
      'f'.repeat(64),
      f.created.reading.sessionId,
      await encrypt('import_identities', 'source_record_enc', 'd'.repeat(64), {
        original: 'Synthetic import identity',
      }),
    ),
    env.DB.prepare(
      'INSERT INTO revisits(id,owner_id,edition_id,note_enc,key_version,created_at,session_id,current_revision,updated_at) VALUES(?,?,?,?,1,?,?,2,?)',
    ).bind(
      revisit,
      owner,
      edition,
      await encrypt(
        'revisits',
        'note_enc',
        revisit,
        { note: 'Synthetic current crypto fixture' },
        2,
      ),
      Date.now(),
      f.created.reading.sessionId,
      Date.now(),
    ),
    env.DB.prepare(
      'INSERT INTO revisit_revisions(revisit_id,owner_id,revision,body_enc,key_version,created_at) VALUES(?,?,1,?,1,?)',
    ).bind(
      revisit,
      owner,
      await encrypt('revisit_revisions', 'body_enc', revisit + ':1', {
        note: 'Synthetic archived crypto fixture',
      }),
      Date.now(),
    ),
    env.DB.prepare(
      "INSERT INTO context_grants(id,owner_id,edition_id,state,created_at,updated_at) VALUES(?,?,?,'allowed',?,?)",
    ).bind(grant, owner, edition, Date.now(), Date.now()),
    env.DB.prepare('INSERT INTO generation_context VALUES(?,?,0,?,1,?,?,1)').bind(
      request,
      owner,
      grant,
      await encrypt('generation_context', 'fragment_enc', request + ':0', {
        fragment: 'Synthetic retained context',
      }),
      'a'.repeat(64),
    ),
    env.DB.prepare('UPDATE provider_dispatches SET provider_response_id_enc=? WHERE id=?').bind(
      await encrypt('provider_dispatches', 'provider_response_id_enc', dispatch, {
        v: 1,
        id: 'synthetic-rekey-response',
      }),
      dispatch,
    ),
    env.DB.prepare(
      'INSERT INTO reading_sessions(id,owner_id,question_enc,created_at,retention_expires_at) VALUES(?,?,?,?,?)',
    ).bind(
      draft,
      owner,
      await encrypt('reading_sessions', 'question_enc', draft, {
        v: 1,
        text: 'Synthetic unsaved draft',
      }),
      Date.now(),
      Date.now() + 86400000,
    ),
  ]);
  const { failingDatabase } = await import('../fixtures/failing-generation-db.ts');
  f.b.DB = failingDatabase('before-dispatch');
  expect((await f.client.start('Synthetic prepared request during rekey.')).status).toBe(202);
  await env.DB.batch(
    f.runtime.base.stopStatements(f.owner, undefined, 'blocked', 'DEPENDENCY_UNAVAILABLE'),
  );
  f.b.DB = failingDatabase('after-receipt');
  const candidateResponse = await f.client.start('Synthetic durable candidate before publication.');
  expect(candidateResponse.status, await candidateResponse.clone().text()).toBe(202);
  f.b.DB = env.DB;
}

test('bounded replacement resumes in fresh instances, preserves exact values and stable index, and retains both wrapped versions', async () => {
  const f = await fixture(25);
  await deferredFields(f);
  const before = await values(f),
    index = await f.runtime.base.crypt.hash(f.owner, 'mutation', { same: 'identity' });
  expect(Object.keys(before).some((key) => key.startsWith('revisit_revisions.body_enc:'))).toBe(
    true,
  );
  expect(new Set(Object.keys(before).map((key) => key.split(':')[0]))).toEqual(
    new Set(ACCOUNT_FIELD_HANDLERS.map((field) => field.table + '.' + field.column)),
  );
  const start = await f.service.begin(f.owner, 1);
  expect(start.targetVersion).toBe(2);
  let result: { phase: string; rewritten: number },
    steps = 0;
  do {
    result = await new AccountRekey(f.runtime.base, f.runtime.coordinator!).step(
      start.operationId,
      20,
    );
    expect(result.rewritten).toBeLessThanOrEqual(20);
    if (++steps > 30) throw new Error('Unbounded rekey');
  } while (result.phase !== 'complete');
  const receipt = await new AccountRekey(f.runtime.base, f.runtime.coordinator!).validate(
    start.operationId,
  );
  expect(receipt).toMatchObject({ fromVersion: 1, toVersion: 2, stillOffline: true });
  expect(await values(f)).toEqual(before);
  expect(
    await new RecordCrypto(env.DB, f.runtime.identity.crypt).hash(f.owner, 'mutation', {
      same: 'identity',
    }),
  ).toBe(index);
  expect(await env.DB.prepare('SELECT key_version FROM accounts').first('key_version')).toBe(2);
  expect(await env.DB.prepare('SELECT count(*) n FROM account_keys').first('n')).toBe(2);
  expect(await env.DB.prepare('SELECT count(*) n FROM auth_sessions').first('n')).toBe(0);
  expect(
    await env.DB.prepare('SELECT restore_in_progress FROM system_state').first(
      'restore_in_progress',
    ),
  ).toBe(1);
  expect(JSON.stringify(receipt)).not.toContain('Synthetic');
  expect(JSON.stringify(receipt)).not.toContain(f.owner);
});

test.each(['ciphertext', 'registry', 'target-key'])(
  'replacement refuses %s changes and keeps traffic offline',
  async (failure) => {
    const f = await fixture(),
      start = await f.service.begin(f.owner, 1);
    while (
      (await env.DB.prepare('SELECT phase FROM account_rekey_jobs').first('phase')) ===
      'inventorying'
    )
      await f.service.step(start.operationId, 20);
    if (failure === 'ciphertext')
      await env.DB.prepare("UPDATE reading_sessions SET question_enc='changed ciphertext'").run();
    if (failure === 'registry')
      await env.DB.prepare('UPDATE account_rekey_jobs SET registry_hash=?')
        .bind('f'.repeat(64))
        .run();
    if (failure === 'target-key')
      await env.DB.prepare('DELETE FROM account_keys WHERE version=2').run();
    await expect(f.service.step(start.operationId, 20)).rejects.toThrow();
    expect((await f.client.request('/me')).status).toBe(503);
  },
);

test('account erasure cascades unfinished replacement state and cannot resurrect the account', async () => {
  const f = await fixture(),
    start = await f.service.begin(f.owner, 1);
  await env.DB.batch([
    env.DB.prepare('PRAGMA defer_foreign_keys=ON'),
    env.DB.prepare('DELETE FROM accounts WHERE id=?').bind(f.owner),
  ]);
  await expect(f.service.step(start.operationId, 20)).rejects.toThrow();
  expect(await env.DB.prepare('SELECT count(*) n FROM account_rekey_jobs').first('n')).toBe(0);
  expect(await env.DB.prepare('SELECT count(*) n FROM account_keys').first('n')).toBe(0);
});

test('a superseded coordinator lease cannot resume without explicit adoption of a current rekey lease', async () => {
  const f = await fixture(),
    start = await f.service.begin(f.owner, 1);
  const row = await env.DB.prepare('SELECT context_json FROM account_rekey_jobs').first<string>(
    'context_json',
  );
  const context = JSON.parse(row!);
  await f.runtime.coordinator!.complete(context, 'a'.repeat(64));
  const next = await f.runtime.coordinator!.acquire('rekey');
  await expect(f.service.step(start.operationId, 20)).rejects.toThrow();
  const resumed = new AccountRekey(f.runtime.base, f.runtime.coordinator!, next);
  await resumed.adopt(start.operationId, next);
  expect((await resumed.step(start.operationId, 20)).phase).toMatch(/inventorying|rewriting/);
});

test('loss between archived and current note rewrites resumes without rewriting completed ciphertext', async () => {
  const f = await fixture();
  await deferredFields(f);
  const start = await f.service.begin(f.owner, 1);
  while (
    (await env.DB.prepare('SELECT phase FROM account_rekey_jobs').first('phase')) === 'inventorying'
  )
    await f.service.step(start.operationId, 20);
  const sql = new WeakMap<object, string>();
  let armed = true;
  const db = new Proxy(env.DB, {
    get(target, name) {
      if (name === 'prepare')
        return (source: string) => {
          const statement = target.prepare(source);
          return new Proxy(statement, {
            get(st, property) {
              if (property === 'bind')
                return (...values: unknown[]) => {
                  const bound = st.bind(...values);
                  sql.set(bound, source);
                  return bound;
                };
              const value = Reflect.get(st, property, st);
              return typeof value === 'function' ? value.bind(st) : value;
            },
          });
        };
      if (name === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          const result = await target.batch(statements);
          if (
            armed &&
            statements.some((st) =>
              (sql.get(st) ?? '').startsWith('UPDATE revisit_revisions SET body_enc='),
            )
          ) {
            armed = false;
            throw new Error('Synthetic Worker loss after commit');
          }
          return result;
        };
      const value = Reflect.get(target, name, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const before = await values(f);
  const interrupted = new AccountRekey(
    new RecordBase(db, f.runtime.identity),
    f.runtime.coordinator!,
  );
  await expect(
    (async () => {
      for (let step = 0; step < 100; step++) await interrupted.step(start.operationId, 1);
    })(),
  ).rejects.toThrow('Synthetic Worker loss');
  const body = await env.DB.prepare('SELECT body_enc FROM revisit_revisions').first<string>(
    'body_enc',
  );
  const current = await env.DB.prepare('SELECT note_enc FROM revisits').first<string>('note_enc');
  expect(JSON.parse(body!).keyVersion).toBe(2);
  expect(JSON.parse(current!).keyVersion).toBe(1);
  let phase = '';
  while (phase !== 'complete')
    phase = (
      await new AccountRekey(f.runtime.base, f.runtime.coordinator!).step(start.operationId, 20)
    ).phase;
  expect(await env.DB.prepare('SELECT body_enc FROM revisit_revisions').first('body_enc')).toBe(
    body,
  );
  expect(await values(f)).toEqual(before);
  await f.service.validate(start.operationId);
});

test.each(['before', 'during', 'after'] as const)(
  'database snapshots taken %s replacement restore and preserve exact values',
  async (point) => {
    const f = await fixture();
    await deferredFields(f);
    const original = await values(f);
    let saved = await snapshot(env.DB);
    const start = await f.service.begin(f.owner, 1);
    while (
      (await env.DB.prepare('SELECT phase FROM account_rekey_jobs').first('phase')) ===
      'inventorying'
    )
      await f.service.step(start.operationId, 20);
    await f.service.step(start.operationId, 1);
    if (point === 'during') saved = await snapshot(env.DB);
    let phase = '';
    while (phase !== 'complete') phase = (await f.service.step(start.operationId, 20)).phase;
    if (point === 'after') saved = await snapshot(env.DB);
    const oldContext = JSON.parse(
      (await env.DB.prepare('SELECT context_json FROM account_rekey_jobs').first<string>(
        'context_json',
      ))!,
    );
    await f.runtime.coordinator!.complete(oldContext, 'a'.repeat(64));
    const restoreContext = await f.runtime.coordinator!.acquire('restore');
    const backups = await backupInventoryFixture(0, f.runtime.environmentId);
    await attestRecoveryFixture(backups, restoreContext);
    await restoreSnapshot(env.DB, saved);
    const restore = new OfflineRestore(
      { ...f.b, RESTORE_MODE: 'offline' },
      {
        runtime: f.runtime,
        offline: { coordinator: f.runtime.coordinator!, context: restoreContext },
        validateContent: async (hash) => hash === localDevelopmentBundle().editionHash,
        backupInventory: backups.inventory,
      },
    );
    await restore.replay();
    expect(await values(f)).toEqual(original);
    if (point === 'during') {
      await f.runtime.coordinator!.complete(restoreContext, 'b'.repeat(64));
      const context = await f.runtime.coordinator!.acquire('rekey'),
        service = new AccountRekey(f.runtime.base, f.runtime.coordinator!, context);
      await service.adopt(start.operationId, context);
      let next = '';
      while (next !== 'complete') next = (await service.step(start.operationId, 20)).phase;
      await service.validate(start.operationId);
    }
  },
);

test.each(['security', 'erasure'] as const)(
  'pending %s work must be flushed before any data-key replacement',
  async (kind) => {
    const f = await fixture();
    if (kind === 'security')
      await env.DB.prepare(
        "UPDATE security_operations SET state='fenced' WHERE id=(SELECT id FROM security_operations LIMIT 1)",
      ).run();
    else {
      const current = (await (
        await f.client.request('/sessions/' + f.created.reading.sessionId)
      ).json()) as { revision: number };
      expect(
        (
          await f.client.request(
            '/sessions/' + f.created.reading.sessionId,
            {
              receiptId: crypto.randomUUID(),
              receiptToken: encode(crypto.getRandomValues(new Uint8Array(32))),
            },
            { method: 'DELETE', revision: current.revision },
          )
        ).status,
      ).toBe(202);
      await env.DB.prepare("UPDATE deletion_jobs SET state='erasing'").run();
    }
    await expect(f.service.begin(f.owner, 1)).rejects.toThrow('pending security and erasure');
    expect(await env.DB.prepare('SELECT count(*) n FROM account_keys').first('n')).toBe(1);
    expect(await env.DB.prepare('SELECT count(*) n FROM account_rekey_jobs').first('n')).toBe(0);
    expect((await f.client.request('/me')).status).toBe(503);
  },
);
