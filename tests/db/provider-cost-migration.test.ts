import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { expect, test } from 'vitest';
import { seedDatabase, OWNER, HASH, CONTENT } from '../fixtures/database.ts';
import { SyntheticGenerationPrototype } from '../../src/worker/db/prototype.ts';
test('0011 preserves populated financial and content rows, FKs and triggers and rolls back a failed rebuild', async () => {
  await applyD1Migrations(
    env.DB,
    env.TEST_MIGRATIONS.filter((m) => m.name < '0011'),
  );
  const plan = await seedDatabase(env.DB),
    service = new SyntheticGenerationPrototype(env.DB, {
      write: async () => {
        throw new Error();
      },
    });
  const id = await service.start(plan),
    lease = (await service.claim(OWNER, id))!,
    dispatch = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO provider_dispatches(id,owner_id,request_id,attempt_id,state,provider,requested_model,transmission_hmac,key_version,prompt_hash,validator_hash,content_hash,parameters_json,authorized_at) VALUES (?,?,?,?,'unknown','openai','gpt-6.1-terra',?,1,?,?,?,'{}',1)",
    ).bind(dispatch, OWNER, id, lease.attemptId, HASH, HASH, HASH, CONTENT),
    env.DB.prepare(
      "INSERT INTO spend_buckets VALUES ('day:history',1000,800),('month:history',1000,800)",
    ),
    env.DB.prepare(
      "INSERT INTO cost_reservations VALUES ('history',?,?,'day:history','month:history','actual',40000,800,'{\"historic\":true}',1,2)",
    ).bind(OWNER, dispatch),
    env.DB.prepare(
      "INSERT INTO cost_adjustments VALUES ('history-adjustment','history',40000,800,'usage',2)",
    ),
  ]);
  const cost = await env.DB.prepare('SELECT * FROM cost_reservations').first(),
    content = (await env.DB.prepare('SELECT * FROM content_editions').all()).results;
  const triggers = (
    await env.DB.prepare(
      "SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name",
    ).all()
  ).results;
  const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith('0011_'))!,
    drop = migration.queries.findIndex((q) => q.includes('DROP TABLE spend_buckets'));
  expect(drop).toBeGreaterThan(0);
  await expect(
    applyD1Migrations(env.DB, [
      {
        ...migration,
        queries: [
          ...migration.queries.slice(0, drop + 1),
          'INSERT INTO assertion_probe VALUES(0)',
          ...migration.queries.slice(drop + 1),
        ],
      },
    ]),
  ).rejects.toThrow();
  expect(await env.DB.prepare('SELECT * FROM cost_reservations').first()).toEqual(cost);
  await applyD1Migrations(env.DB, [migration]);
  expect(await env.DB.prepare('SELECT * FROM cost_reservations').first()).toMatchObject({
    ...cost,
    provider_policy_hash: null,
    receipt_hash: null,
  });
  expect((await env.DB.prepare('SELECT * FROM content_editions').all()).results).toMatchObject(
    content,
  );
  expect(
    (
      await env.DB.prepare(
        "SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name",
      ).all()
    ).results,
  ).toEqual(triggers);
  expect((await env.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  await env.DB.prepare('UPDATE spend_buckets SET committed_microusd=50000').run();
  expect(
    await env.DB.prepare('SELECT sum(committed_microusd) n FROM spend_buckets').first('n'),
  ).toBe(100000);
});
