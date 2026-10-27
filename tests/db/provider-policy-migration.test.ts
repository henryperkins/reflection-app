import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { expect, test } from 'vitest';
import { SyntheticGenerationPrototype } from '../../src/worker/db/prototype.ts';
import { CONTENT, HASH, OTHER, OWNER, seedDatabase, sql } from '../fixtures/database.ts';

async function rows() {
  const tables = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('d1_migrations','_cf_METADATA') ORDER BY name",
  ).all<{ name: string }>();
  return Promise.all(
    tables.results.map(async ({ name }) => [
      name,
      (await env.DB.prepare(`SELECT * FROM "${name}"`).all()).results
        .map((row) => JSON.stringify(row))
        .sort(),
    ]),
  );
}

test('forward policy migration preserves populated 5.6 data, accounting, indexes, triggers and ownership', async () => {
  const previous = env.TEST_MIGRATIONS.filter((m) => m.name < '0009');
  await applyD1Migrations(env.DB, previous);
  const plan = await seedDatabase(env.DB);
  const service = new SyntheticGenerationPrototype(env.DB, {
    write: async () => {
      throw new Error('Migration must never call a writer');
    },
  });
  const request = await service.start(plan);
  const lease = (await service.claim(OWNER, request))!;
  const dispatch = crypto.randomUUID();
  await env.DB.batch([
    sql(
      env.DB,
      `INSERT INTO provider_dispatches(id,owner_id,request_id,attempt_id,state,provider,requested_model,returned_model,transmission_enc,transmission_hmac,candidate_enc,provider_response_id_enc,key_version,prompt_hash,validator_hash,content_hash,parameters_json,input_tokens,output_tokens,duration_ms,authorized_at,received_at,cost_expired_at)
      VALUES (?,?,?,?,'received','openai','gpt-5.6-terra','gpt-5.6-terra','OLD_TRANSMISSION',?,'OLD_CANDIDATE','OLD_RESPONSE_ID',1,?,?,?,'{"model":"gpt-5.6-terra"}',100,50,7,1,2,99)`,
      dispatch,
      OWNER,
      request,
      lease.attemptId,
      HASH,
      HASH,
      HASH,
      CONTENT,
    ),
    env.DB.prepare(
      "INSERT INTO spend_buckets VALUES ('day:historical',10000000,800),('month:historical',100000000,800)",
    ),
    sql(
      env.DB,
      "INSERT INTO cost_reservations VALUES ('historical-cost',?,?,'day:historical','month:historical','actual',40000,800,'{\"oldRate\":true}',1,2)",
      OWNER,
      dispatch,
    ),
    env.DB.prepare(
      "INSERT INTO cost_adjustments VALUES ('historical-adjustment','historical-cost',40000,800,'usage',2)",
    ),
    sql(
      env.DB,
      `INSERT INTO reading_editions(id,owner_id,session_id,edition_number,request_id,basis_id,status,mode,body_enc,key_version,content_hash,accepted_at)
      VALUES ('historical-reading',?,?,1,?,?,'accepted','model','IMMUTABLE_5.6_READING',1,?,2)`,
      OWNER,
      plan.sessionId,
      request,
      plan.basisId,
      CONTENT,
    ),
    env.DB.prepare(
      "UPDATE system_state SET generation_enabled=0,dispatch_mode='off',restore_in_progress=1",
    ),
  ]);
  const before = await rows();
  const triggers = await env.DB.prepare(
    "SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name",
  ).all();
  const indexes = await env.DB.prepare('PRAGMA index_list(provider_dispatches)').all();
  const foreignKeys = await env.DB.prepare('PRAGMA foreign_key_list(provider_dispatches)').all();
  const upgrade = env.TEST_MIGRATIONS.filter((m) => m.name.startsWith('0009_'));
  expect(upgrade).toHaveLength(1);
  const replacement = upgrade[0]!;
  const dropped = replacement.queries.findIndex((query) =>
    query.includes('DROP TABLE provider_dispatches'),
  );
  expect(dropped).toBeGreaterThan(0);
  await expect(
    applyD1Migrations(env.DB, [
      {
        ...replacement,
        queries: [
          ...replacement.queries.slice(0, dropped + 1),
          'INSERT INTO assertion_probe VALUES (0)',
          ...replacement.queries.slice(dropped + 1),
        ],
      },
    ]),
  ).rejects.toThrow();
  expect(await rows()).toEqual(before);
  expect(
    (
      await env.DB.prepare(
        "SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name",
      ).all()
    ).results,
  ).toEqual(triggers.results);
  await applyD1Migrations(env.DB, upgrade);
  expect(await rows()).toEqual(before);
  expect(
    (
      await env.DB.prepare(
        "SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name",
      ).all()
    ).results,
  ).toEqual(triggers.results);
  expect((await env.DB.prepare('PRAGMA index_list(provider_dispatches)').all()).results).toEqual(
    indexes.results,
  );
  expect(
    (await env.DB.prepare('PRAGMA foreign_key_list(provider_dispatches)').all()).results,
  ).toEqual(foreignKeys.results);
  expect((await env.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);

  // Receipt storage is a separate additive upgrade; legacy unknown categories stay NULL.
  const historicalUsage = await env.DB.prepare(
    'SELECT id,input_tokens,output_tokens,returned_model,cost_expired_at FROM provider_dispatches',
  ).first();
  await applyD1Migrations(
    env.DB,
    env.TEST_MIGRATIONS.filter((m) => m.name.startsWith('0010_')),
  );
  expect(
    await env.DB.prepare(
      'SELECT id,input_tokens,output_tokens,returned_model,cost_expired_at FROM provider_dispatches',
    ).first(),
  ).toEqual(historicalUsage);
  expect(
    await env.DB.prepare(
      'SELECT cached_input_tokens,cache_write_tokens,reasoning_tokens,service_tier FROM provider_dispatches',
    ).first(),
  ).toEqual({
    cached_input_tokens: null,
    cache_write_tokens: null,
    reasoning_tokens: null,
    service_tier: null,
  });

  // Admission remains disabled, so create only synthetic rows to exercise the new table contract.
  const newRequest = crypto.randomUUID(),
    newAttempt = crypto.randomUUID(),
    newDispatch = crypto.randomUUID();
  await env.DB.batch([
    sql(
      env.DB,
      `INSERT INTO generation_requests(id,owner_id,session_id,client_intent_id,basis_id,operation,payload_hmac,state,next_run_at,permission_revision,key_version,content_hash,content_policy_revision,policy_hash,created_at,expires_at)
      SELECT ?,owner_id,session_id,?,basis_id,operation,payload_hmac,'prepared',next_run_at,permission_revision,key_version,content_hash,content_policy_revision,policy_hash,created_at,expires_at FROM generation_requests WHERE id=?`,
      newRequest,
      crypto.randomUUID(),
      request,
    ),
    sql(
      env.DB,
      "INSERT INTO generation_attempts(id,owner_id,request_id,run_epoch,lease_token,started_at) VALUES (?,?,?,1,'new-lease',1)",
      newAttempt,
      OWNER,
      newRequest,
    ),
    sql(
      env.DB,
      `INSERT INTO provider_dispatches(id,owner_id,request_id,attempt_id,state,provider,requested_model,transmission_enc,transmission_hmac,key_version,prompt_hash,validator_hash,content_hash,parameters_json,authorized_at)
      VALUES (?,?,?,?,'authorized','openai','gpt-6.1-terra','new',?,1,?,?,?,'{}',1)`,
      newDispatch,
      OWNER,
      newRequest,
      newAttempt,
      HASH,
      HASH,
      HASH,
      CONTENT,
    ),
  ]);
  expect(
    (
      await env.DB.prepare(
        'SELECT requested_model FROM provider_dispatches ORDER BY requested_model',
      ).all()
    ).results,
  ).toEqual([{ requested_model: 'gpt-5.6-terra' }, { requested_model: 'gpt-6.1-terra' }]);
  for (const [column, value] of [
    ['requested_model', 'unrelated-model'],
    ['provider', 'other-provider'],
    ['state', 'invalid'],
    ['owner_id', OTHER],
    ['key_version', 999],
    ['input_tokens', -1],
    ['parameters_json', 'not-json'],
  ] as const) {
    await expect(
      sql(
        env.DB,
        `UPDATE provider_dispatches SET ${column}=? WHERE id=?`,
        value,
        newDispatch,
      ).run(),
    ).rejects.toThrow();
  }
  await expect(
    sql(
      env.DB,
      'UPDATE provider_dispatches SET request_id=? WHERE id=?',
      request,
      newDispatch,
    ).run(),
  ).rejects.toThrow();
  const storage = await sql(
    env.DB,
    'SELECT storage_bytes FROM accounts WHERE id=?',
    OWNER,
  ).first<number>('storage_bytes');
  await sql(
    env.DB,
    'UPDATE provider_dispatches SET candidate_enc=? WHERE id=?',
    'é😀',
    newDispatch,
  ).run();
  expect(
    await sql(env.DB, 'SELECT storage_bytes FROM accounts WHERE id=?', OWNER).first(
      'storage_bytes',
    ),
  ).toBe(storage! + 6);
  await sql(env.DB, 'DELETE FROM accounts WHERE id=?', OWNER).run();
  expect(await env.DB.prepare('SELECT count(*) AS n FROM provider_dispatches').first('n')).toBe(0);
  expect((await env.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  expect(
    await env.DB.prepare(
      "SELECT state,actual_microusd FROM cost_reservations WHERE id='historical-cost'",
    ).first(),
  ).toEqual({ state: 'actual', actual_microusd: 800 });
});
