import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, test } from 'vitest';
import { HostedCoordinator } from '../../src/worker/recovery/hosted-coordinator.ts';

test('elapsed wall time cannot establish quiescence while a writer is still running', async () => {
  const environment = 'live-http-' + crypto.randomUUID(),
    secret = 'synthetic-offline-control-token-not-a-deployed-secret';
  const writer = new HostedCoordinator(env.OFFLINE_COORDINATOR, secret, environment),
    operator = new HostedCoordinator(env.OFFLINE_COORDINATOR, secret, environment);
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>((r) => (entered = r)),
    gate = new Promise<void>((r) => (release = r));
  const running = writer.withWriter(async () => {
    entered();
    await gate;
    return 'still-live';
  });
  await ready;
  const context = await operator.acquire('restore');
  try {
    await runInDurableObject(
      env.OFFLINE_COORDINATOR.getByName(environment),
      async (_instance, state) => {
        state.storage.sql.exec('UPDATE writers SET expires_at=1 WHERE operation_id IS NULL');
      },
    );
    await expect(operator.assertCurrent(context)).rejects.toThrow();
  } finally {
    release();
    await running;
  }
  await operator.assertCurrent(context);
});

test('a synchronous callback failure still deregisters the writer and preserves the original error', async () => {
  let finishes = 0;
  const namespace = {
    getByName: () => ({
      registerWriter: async () => 0,
      finishWriter: async () => {
        finishes++;
      },
    }),
  } as unknown as typeof env.OFFLINE_COORDINATOR;
  const coordinator = new HostedCoordinator(namespace, 'synthetic-control', 'sync-failure');
  const failure = new Error('Synthetic synchronous work failure');
  await expect(
    coordinator.withWriter(() => {
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(finishes).toBe(1);
});
