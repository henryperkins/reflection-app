import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, expect, test } from 'vitest';
import { maintenanceHealth } from '../../src/worker/maintenance/health.ts';
import { clearDatabase } from '../fixtures/database.ts';
import { readingAccount } from '../fixtures/reading-client.ts';
import { DB_NOW } from '../../src/worker/db/core.ts';

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(() => clearDatabase(env.DB));

test('maintenance metrics expose only aggregate queue health and never private content or identifiers', async () => {
  const { client, kit } = await readingAccount();
  const { started } = await client.create('PRIVATE_HEALTH_SENTINEL a reflective exercise');
  const health = await maintenanceHealth(env.DB);
  expect(health).toMatchObject({
    event: 'maintenance_health',
    pendingGeneration: 0,
    pendingSecurity: 0,
    pendingErasure: 0,
    alerts: [],
  });
  const serialized = JSON.stringify(health);
  for (const forbidden of [
    'PRIVATE_HEALTH_SENTINEL',
    kit.subjectId,
    started.sessionId,
    started.requestId,
  ])
    expect(serialized).not.toContain(forbidden);
});

test('stalled requests and security jobs create bounded, content-free alert codes', async () => {
  const { client } = await readingAccount();
  const { started } = await client.create();
  await env.DB.prepare(
    `UPDATE generation_requests SET state='prepared',created_at=${DB_NOW}-120000 WHERE id=?`,
  )
    .bind(started.requestId)
    .run();
  await env.DB.prepare(
    `UPDATE security_operations SET state='fenced',created_at=${DB_NOW}-600000`,
  ).run();
  const health = await maintenanceHealth(env.DB);
  expect(health).toMatchObject({
    pendingGeneration: 1,
    alerts: expect.arrayContaining(['GENERATION_BACKLOG', 'SECURITY_LAG']),
  });
});

test('a database failure cannot be reported as healthy zero counters', async () => {
  const unavailable = {
    batch: async () => {
      throw new Error('unavailable');
    },
    prepare: env.DB.prepare.bind(env.DB),
  } as unknown as D1Database;
  await expect(maintenanceHealth(unavailable)).rejects.toThrow();
});

test('unknown cost, old erasure and actual configured spend limits remain visible', async () => {
  const { client } = await readingAccount();
  await client.create();
  await env.DB.prepare("UPDATE cost_reservations SET state='unknown'").run();
  await env.DB.prepare('UPDATE spend_buckets SET ceiling_microusd=1,committed_microusd=2').run();
  await env.DB.prepare(
    `INSERT INTO deletion_jobs(id,scope,target_hmac,state,ledger_key,next_run_at,created_at) VALUES(?,'session',?,'erasing',?,1,${DB_NOW}-86400001)`,
  )
    .bind(crypto.randomUUID(), 'f'.repeat(64), 'PRIVATE_LEDGER_SENTINEL')
    .run();
  const health = await maintenanceHealth(env.DB);
  expect(health).toMatchObject({
    dailyLimitMicrousd: 1,
    monthlyLimitMicrousd: 1,
    alerts: expect.arrayContaining(['ERASURE_LAG', 'PROVIDER_COST_UNKNOWN', 'SPEND_LIMIT']),
  });
  expect(JSON.stringify(health)).not.toContain('PRIVATE_LEDGER_SENTINEL');
});
