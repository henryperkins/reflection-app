import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, expect, test } from 'vitest';
import { apiSchemas } from '../../src/contracts/index.ts';
import { RetentionMaintenance } from '../../src/worker/maintenance/retention.ts';
import { DB_NOW } from '../../src/worker/db/core.ts';
import { randomToken } from '../../src/worker/identity/crypto.ts';
import { clearDatabase } from '../fixtures/database.ts';
import { gate } from '../fixtures/barrier.ts';
import { ReadingClient, readingAccount, readingBindings } from '../fixtures/reading-client.ts';

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(() => clearDatabase(env.DB));
const DAY = 86400000;
const run = () => new RetentionMaintenance(env.DB).run();
const count = (table: string) =>
  env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<number>('n');
const bytes = (owner: string) =>
  env.DB.prepare('SELECT storage_bytes FROM accounts WHERE id=?')
    .bind(owner)
    .first<number>('storage_bytes');
async function exportRecords(client: ReadingClient) {
  const ticket = apiSchemas.ExportTicket.parse(await (await client.request('/exports', {})).json());
  const page = apiSchemas.ExportPage.parse(
    await (await client.request(`/exports/${ticket.id}`)).json(),
  );
  return { ticket, page };
}
async function failed() {
  const account = await readingAccount();
  const paused = gate((sql) => sql.some((s) => s.includes('INSERT INTO reading_editions')));
  const client = new ReadingClient({ ...readingBindings, DB: paused.db });
  client.cookies = account.client.cookies;
  client.csrf = account.client.csrf;
  const pending = client.start('Synthetic interrupted request');
  await paused.ready;
  try {
    await account.client.permission(false);
  } finally {
    paused.release();
  }
  const started = apiSchemas.StartResponse.parse(await (await pending).json());
  return { ...account, started };
}

test('expired export tickets are removed in bounded pages and row capacity is released exactly once', async () => {
  const { kit } = await readingAccount();
  await env.DB.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<105)
    INSERT INTO export_tickets SELECT 'expired-'||x,?,1,1,1 FROM n`)
    .bind(kit.subjectId)
    .run();
  await env.DB.prepare("INSERT INTO export_tickets VALUES ('future',?,1,1,9999999999999)")
    .bind(kit.subjectId)
    .run();
  const before = (await bytes(kit.subjectId))!;
  await run();
  expect(await count('export_tickets')).toBe(6);
  expect(await bytes(kit.subjectId)).toBe(before - 100 * 1024);
  await run();
  expect(await count('export_tickets')).toBe(1);
  const after = await bytes(kit.subjectId);
  expect(after).toBe(before - 105 * 1024);
  await run();
  expect(await bytes(kit.subjectId)).toBe(after);
});

test('candidate expiry preserves saved accepted text, source payload and authored revisions with AI off', async () => {
  const { client, kit } = await readingAccount();
  const { started, reading } = await client.create();
  const reflection = apiSchemas.Reflection.parse(
    await (
      await client.request(`/sessions/${started.sessionId}/reflections`, {
        text: 'Synthetic reflection retained by its author',
        stance: 'unsure',
        editionId: reading.editionId,
      })
    ).json(),
  );
  await client.permission(false);
  const before = await env.DB.prepare(
    'SELECT transmission_enc,candidate_enc FROM provider_dispatches WHERE request_id=?',
  )
    .bind(started.requestId)
    .first<{ transmission_enc: string; candidate_enc: string }>();
  await env.DB.prepare(`UPDATE provider_dispatches SET received_at=${DB_NOW}-${DAY}-1`).run();
  const { ticket } = await exportRecords(client);
  const storage = (await bytes(kit.subjectId))!;
  await run();
  expect(
    await env.DB.prepare('SELECT candidate_enc FROM provider_dispatches').first('candidate_enc'),
  ).toBeNull();
  expect(
    await env.DB.prepare('SELECT transmission_enc FROM provider_dispatches').first(
      'transmission_enc',
    ),
  ).toBe(before!.transmission_enc);
  expect(await bytes(kit.subjectId)).toBe(
    storage - new TextEncoder().encode(before!.candidate_enc).length,
  );
  expect(await (await client.request(`/readings/${reading.editionId}`)).json()).toEqual(reading);
  expect(await (await client.request(`/reflections/${reflection.id}`)).json()).toEqual(reflection);
  expect((await client.request(`/exports/${ticket.id}`)).status).toBe(409);
});

test('failed private payloads expire at 24 hours while recent failures retain their recovery bodies', async () => {
  const { started } = await failed();
  await env.DB.prepare(
    `UPDATE generation_requests SET finished_at=${DB_NOW}-${DAY}+60000 WHERE id=?`,
  )
    .bind(started.requestId)
    .run();
  await run();
  expect(
    await env.DB.prepare('SELECT input_enc FROM generation_requests').first('input_enc'),
  ).not.toBeNull();
  await env.DB.prepare(`UPDATE generation_requests SET finished_at=${DB_NOW}-${DAY}-1 WHERE id=?`)
    .bind(started.requestId)
    .run();
  await run();
  expect(
    await env.DB.prepare('SELECT input_enc,plan_enc FROM generation_requests').first(),
  ).toEqual({ input_enc: null, plan_enc: null });
  expect(
    await env.DB.prepare(
      'SELECT transmission_enc,candidate_enc,provider_response_id_enc FROM provider_dispatches',
    ).first(),
  ).toEqual({ transmission_enc: null, candidate_enc: null, provider_response_id_enc: null });
  expect(await count('generation_requests')).toBe(1);
});

test('30-day failed metadata cleanup releases references without refunding financial spend', async () => {
  const { kit, started } = await failed();
  const dispatch = await env.DB.prepare('SELECT id FROM provider_dispatches').first<string>('id');
  await env.DB.prepare("INSERT INTO spend_buckets VALUES ('synthetic-liability',100,40)").run();
  await env.DB.prepare(`INSERT INTO cost_reservations(id,owner_id,dispatch_id,day_period,month_period,state,reserved_microusd,price_basis_json,created_at)
    VALUES ('liability',?,?,'synthetic-liability','synthetic-liability','unknown',40,'{}',1)`)
    .bind(kit.subjectId, dispatch)
    .run();
  await env.DB.prepare(
    `UPDATE generation_requests SET finished_at=${DB_NOW}-${31 * DAY} WHERE id=?`,
  )
    .bind(started.requestId)
    .run();
  await run();
  expect(await count('generation_requests')).toBe(0);
  expect(await count('provider_dispatches')).toBe(0);
  expect(await count('generation_attempts')).toBe(0);
  expect(
    await env.DB.prepare(
      'SELECT owner_id,dispatch_id,state,reserved_microusd FROM cost_reservations',
    ).first(),
  ).toEqual({ owner_id: null, dispatch_id: null, state: 'unknown', reserved_microusd: 40 });
  expect(
    await env.DB.prepare('SELECT committed_microusd FROM spend_buckets').first(
      'committed_microusd',
    ),
  ).toBe(40);
  expect(await env.DB.prepare('PRAGMA foreign_key_check').all()).toMatchObject({ results: [] });
});

test('settled cost detail expires after 90 days and exported cost becomes expired rather than zero', async () => {
  const { client, kit } = await readingAccount();
  const { started } = await client.create();
  const dispatch = await env.DB.prepare('SELECT id FROM provider_dispatches').first<string>('id');
  await env.DB.prepare("INSERT INTO spend_buckets VALUES ('synthetic-paid',100,12)").run();
  await env.DB.prepare(`INSERT INTO cost_reservations(id,owner_id,dispatch_id,day_period,month_period,state,reserved_microusd,actual_microusd,price_basis_json,created_at,settled_at)
    VALUES ('paid',?,?,'synthetic-paid','synthetic-paid','actual',15,12,'{}',${DB_NOW}-${91 * DAY},${DB_NOW}-${89 * DAY})`)
    .bind(kit.subjectId, dispatch)
    .run();
  await run();
  expect(await count('cost_reservations')).toBe(1);
  const { ticket, page } = await exportRecords(client);
  expect(page.records.find((r) => r.kind === 'generation_receipt')).toMatchObject({
    value: { requestId: started.requestId, costState: 'actual', actualCostMicroUsd: 12 },
  });
  await env.DB.prepare(`UPDATE cost_reservations SET settled_at=${DB_NOW}-${90 * DAY}-1`).run();
  await run();
  expect(await count('cost_reservations')).toBe(0);
  expect((await client.request(`/exports/${ticket.id}`)).status).toBe(409);
  const next = await exportRecords(client);
  expect(next.page.records.find((r) => r.kind === 'generation_receipt')).toMatchObject({
    value: { costState: 'expired', actualCostMicroUsd: null },
  });
});

test('capabilities, seven-day events and applied security operations expire without touching pending security state', async () => {
  const { client, kit } = await readingAccount();
  const { started, reading } = await client.create();
  await env.DB.prepare(`UPDATE request_events SET created_at=${DB_NOW}-${7 * DAY}-1`).run();
  await env.DB.prepare('UPDATE idempotency_keys SET expires_at=1').run();
  await env.DB.prepare(`UPDATE security_operations SET applied_at=${DB_NOW}-${30 * DAY}-1`).run();
  const pending = await env.DB.prepare(
    'SELECT id FROM security_operations ORDER BY epoch DESC LIMIT 1',
  ).first<string>('id');
  await env.DB.prepare("UPDATE security_operations SET state='fenced' WHERE id=?")
    .bind(pending)
    .run();
  await env.DB.prepare('UPDATE auth_challenges SET expires_at=1').run();
  await env.DB.prepare('UPDATE rate_buckets SET expires_at=1').run();
  await run();
  for (const table of ['request_events', 'idempotency_keys', 'auth_challenges', 'rate_buckets'])
    expect(await count(table)).toBe(0);
  expect(await count('security_operations')).toBe(1);
  expect(await env.DB.prepare('SELECT id FROM security_operations').first('id')).toBe(pending);
  expect(await env.DB.prepare('SELECT id FROM accounts').first('id')).toBe(kit.subjectId);
  expect(await count('generation_attempts')).toBe(1); // accepted dispatch still references it
  const status = apiSchemas.RequestStatus.parse(
    await (await client.request(`/requests/${started.requestId}`)).json(),
  );
  expect(status).toMatchObject({
    state: 'published',
    editionId: reading.editionId,
    nextSequence: 2,
    events: [],
  });
});

test('old deleted session metadata is removed only after erasure while its receipt remains available', async () => {
  const { client, kit } = await readingAccount();
  const { started } = await client.create();
  const proof = { receiptId: crypto.randomUUID(), receiptToken: randomToken() };
  expect(
    (
      await client.request(`/sessions/${started.sessionId}`, proof, {
        method: 'DELETE',
        revision: 1,
      })
    ).status,
  ).toBe(202);
  await env.DB.prepare(`UPDATE reading_sessions SET deleted_at=${DB_NOW}-${31 * DAY}`).run();
  const before = (await bytes(kit.subjectId))!;
  await run();
  for (const table of [
    'reading_sessions',
    'basis_snapshots',
    'reading_editions',
    'generation_requests',
    'provider_dispatches',
    'generation_attempts',
    'quota_reservations',
    'quota_events',
    'request_events',
  ])
    expect(await count(table)).toBe(0);
  expect((await bytes(kit.subjectId))!).toBeLessThan(before);
  const after = await bytes(kit.subjectId);
  await run();
  expect(await bytes(kit.subjectId)).toBe(after);
  const receipt = await client.request(`/deletions/${proof.receiptId}`, undefined, {
    headers: { 'X-Deletion-Token': proof.receiptToken },
  });
  expect(apiSchemas.DeletionStatus.parse(await receipt.json()).state).toBe('complete');
  expect(await count('deletion_jobs')).toBe(1);
});

test('old unreferenced quota periods expire while live and referenced balances remain unchanged', async () => {
  const { client, kit } = await readingAccount();
  await client.create();
  const before = (await env.DB.prepare('SELECT * FROM quota_buckets ORDER BY period').all())
    .results;
  await env.DB.prepare(
    "INSERT INTO quota_buckets VALUES (?,'month:2000-01',30,0,0),(?,'day:2000-01-02',3,0,0)",
  )
    .bind(kit.subjectId, kit.subjectId)
    .run();
  await run();
  expect(
    (await env.DB.prepare('SELECT * FROM quota_buckets ORDER BY period').all()).results,
  ).toEqual(before);
});

test('uncertain held quota prevents failure metadata removal without silently releasing its balance', async () => {
  const { started } = await failed();
  await env.DB.prepare(`UPDATE generation_requests SET finished_at=${DB_NOW}-${31 * DAY}`).run();
  await env.DB.prepare("UPDATE quota_reservations SET state='held' WHERE request_id=?")
    .bind(started.requestId)
    .run();
  await env.DB.prepare('UPDATE quota_buckets SET held=1').run();
  await run();
  expect(await count('generation_requests')).toBe(1);
  expect(await count('provider_dispatches')).toBe(1);
  expect((await env.DB.prepare('SELECT held,consumed FROM quota_buckets').all()).results).toEqual([
    { held: 1, consumed: 0 },
    { held: 1, consumed: 0 },
  ]);
  expect(await env.DB.prepare('SELECT state FROM quota_reservations').first('state')).toBe('held');
});

test('a cleanup batch delayed until restore fencing commits cannot remove expired metadata', async () => {
  const { kit } = await readingAccount();
  await env.DB.prepare("INSERT INTO export_tickets VALUES ('expired',?,1,1,1)")
    .bind(kit.subjectId)
    .run();
  const paused = gate((sql) => sql.some((s) => s.includes('DELETE FROM export_tickets')));
  const pending = new RetentionMaintenance(paused.db).run();
  await paused.ready;
  try {
    await env.DB.prepare(
      'INSERT INTO system_state(id,provider_policy_hash,updated_at,restore_in_progress) VALUES (1,?,1,1) ON CONFLICT(id) DO UPDATE SET restore_in_progress=1',
    )
      .bind('0'.repeat(64))
      .run();
  } finally {
    paused.release();
  }
  await expect(pending).rejects.toThrow();
  expect(await count('export_tickets')).toBe(1);
});
