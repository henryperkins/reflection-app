import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, expect, test } from 'vitest';
import worker from '../../src/worker/index.ts';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

test('actual migration has the request table and a working database clock', async () => {
  const row = await env.DB.prepare('SELECT count(*) AS count FROM generation_requests').first<{
    count: number;
  }>();
  expect(row?.count).toBe(0);
  const clock = await env.DB.prepare(
    "SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) AS now",
  ).first<{ now: number }>();
  expect(clock?.now).toBeGreaterThan(0);
});

test('health is available and personal routes are disabled', async () => {
  const response = await worker.fetch(new Request('https://local.test/health'), { DB: env.DB });
  expect(await response.json()).toEqual({ status: 'ok', milestone: 1, mode: 'synthetic-only' });
  expect(
    (await worker.fetch(new Request('https://local.test/api/v1/requests'), { DB: env.DB })).status,
  ).toBe(503);
});
