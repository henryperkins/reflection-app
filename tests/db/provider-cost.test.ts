import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, expect, test } from 'vitest';
import { SyntheticGenerationPrototype } from '../../src/worker/db/prototype.ts';
import { reconcileProviderCost } from '../../src/worker/provider/costs.ts';
import { READING_PROVIDER_POLICY } from '../../src/contracts/provider-policy.ts';
import { providerReceipt } from '../fixtures/provider.ts';
import { clearDatabase, seedDatabase, OWNER } from '../fixtures/database.ts';
import { maintenanceHealth } from '../../src/worker/maintenance/health.ts';

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(() => clearDatabase(env.DB));
async function reserved() {
  const plan = await seedDatabase(env.DB);
  const service = new SyntheticGenerationPrototype(
    env.DB,
    { write: async () => ({ kind: 'uncertain', reason: 'timeout', receipt: null }) },
    {
      beforeReceipt: async () => {
        throw new Error('Synthetic lost worker');
      },
    },
  );
  const requestId = await service.start(plan),
    lease = (await service.claim(OWNER, requestId))!;
  await expect(service.dispatch(lease, new Uint8Array([1]))).rejects.toThrow(
    'Synthetic lost worker',
  );
  const row = (await env.DB.prepare('SELECT id FROM provider_dispatches').first<{ id: string }>())!;
  return {
    dispatchId: row.id,
    receiptId: 'bill-1',
    receipt: providerReceipt({
      returnedModel: 'gpt-6.1-terra',
      usage: {
        inputTokens: 1000,
        cachedInputTokens: 200,
        cacheWriteTokens: 300,
        outputTokens: 100,
        reasoningTokens: 0,
      },
    }),
    policy: READING_PROVIDER_POLICY,
  };
}
test('known usage reconciles once even after a lost acknowledgment and concurrent attempts', async () => {
  const input = await reserved();
  const results = await Promise.all([
    reconcileProviderCost(env.DB, input),
    reconcileProviderCost(env.DB, input),
  ]);
  expect(results).toEqual([
    { state: 'actual', actualMicrousd: 1385 },
    { state: 'actual', actualMicrousd: 1385 },
  ]);
  expect(await env.DB.prepare('SELECT count(*) AS n FROM cost_adjustments').first('n')).toBe(1);
  expect(
    await env.DB.prepare('SELECT sum(committed_microusd) AS n FROM spend_buckets').first('n'),
  ).toBe(2770);
  expect(await reconcileProviderCost(env.DB, input)).toEqual(results[0]);
  const changed = {
    ...input,
    receiptId: 'different-bill',
    receipt: { ...input.receipt, usage: { ...input.receipt.usage, outputTokens: 101 } },
  };
  await expect(reconcileProviderCost(env.DB, changed)).rejects.toThrow();
});
test('unknown receipt retains the reservation and can later be reconciled exactly once', async () => {
  const input = await reserved();
  expect(await reconcileProviderCost(env.DB, { ...input, receipt: null })).toEqual({
    state: 'unknown',
    actualMicrousd: null,
  });
  expect(
    await env.DB.prepare('SELECT sum(committed_microusd) AS n FROM spend_buckets').first('n'),
  ).toBe(80000);
  expect(await reconcileProviderCost(env.DB, input)).toEqual({
    state: 'actual',
    actualMicrousd: 1385,
  });
});
test('reconciliation adjusts original UTC buckets after a month boundary', async () => {
  const input = await reserved();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO spend_buckets VALUES ('day:old',10000000,40000),('month:old',100000000,40000),('day:new',10000000,7),('month:new',100000000,7)",
    ),
    env.DB.prepare("UPDATE cost_reservations SET day_period='day:old',month_period='month:old'"),
  ]);
  await reconcileProviderCost(env.DB, input);
  expect(
    (
      await env.DB.prepare(
        "SELECT committed_microusd FROM spend_buckets WHERE period IN ('day:old','month:old')",
      ).all()
    ).results,
  ).toEqual([{ committed_microusd: 1385 }, { committed_microusd: 1385 }]);
  expect(
    await env.DB.prepare(
      "SELECT sum(committed_microusd) AS n FROM spend_buckets WHERE period IN ('day:new','month:new')",
    ).first('n'),
  ).toBe(14);
});
test('deletion before reconciliation preserves aggregate liability without recreating account or dispatch links', async () => {
  const input = await reserved();
  await env.DB.batch([
    env.DB.prepare('UPDATE cost_reservations SET owner_id=NULL,dispatch_id=NULL'),
    env.DB.prepare('DELETE FROM accounts WHERE id=?').bind(OWNER),
  ]);
  expect(await reconcileProviderCost(env.DB, input)).toEqual({
    state: 'actual',
    actualMicrousd: 1385,
  });
  expect(
    await env.DB.prepare('SELECT owner_id,dispatch_id FROM cost_reservations').first(),
  ).toEqual({ owner_id: null, dispatch_id: null });
  expect(
    await env.DB.prepare('SELECT count(*) AS n FROM accounts WHERE id=?').bind(OWNER).first('n'),
  ).toBe(0);
  expect(await env.DB.prepare('SELECT count(*) AS n FROM provider_dispatches').first('n')).toBe(0);
});
test('above-reservation and above-ceiling costs are recorded in full, disable generation and alert', async () => {
  const input = await reserved();
  await env.DB.prepare('UPDATE spend_buckets SET ceiling_microusd=40000').run();
  const receipt = providerReceipt({
    returnedModel: 'gpt-6.1-terra',
    usage: {
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 10000,
      reasoningTokens: 0,
    },
  });
  expect(await reconcileProviderCost(env.DB, { ...input, receipt })).toEqual({
    state: 'actual',
    actualMicrousd: 50000,
  });
  expect(
    await env.DB.prepare('SELECT sum(committed_microusd) AS n FROM spend_buckets').first('n'),
  ).toBe(100000);
  expect(
    await env.DB.prepare('SELECT generation_enabled FROM system_state').first('generation_enabled'),
  ).toBe(0);
  expect((await maintenanceHealth(env.DB)).alerts).toContain('PROVIDER_COST_OVERRUN');
});
test('a different policy cannot reprice an admitted reservation', async () => {
  const input = await reserved();
  await env.DB.prepare('UPDATE cost_reservations SET provider_policy_hash=?')
    .bind('e'.repeat(64))
    .run();
  expect(await reconcileProviderCost(env.DB, input)).toEqual({
    state: 'unknown',
    actualMicrousd: null,
  });
  expect(
    await env.DB.prepare('SELECT sum(committed_microusd) AS n FROM spend_buckets').first('n'),
  ).toBe(80000);
});
test('racing conflicting receipts stop generation rather than silently accepting the losing bill', async () => {
  const input = await reserved();
  const other = {
    ...input,
    receiptId: 'bill-2',
    receipt: { ...input.receipt, usage: { ...input.receipt.usage, outputTokens: 101 } },
  };
  const results = await Promise.allSettled([
    reconcileProviderCost(env.DB, input),
    reconcileProviderCost(env.DB, other),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  expect(
    await env.DB.prepare('SELECT generation_enabled FROM system_state').first('generation_enabled'),
  ).toBe(0);
  expect(await env.DB.prepare('SELECT count(*) n FROM cost_adjustments').first('n')).toBe(1);
});
