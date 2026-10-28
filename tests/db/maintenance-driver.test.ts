import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, expect, test, vi } from 'vitest';
import {
  createRuntime,
  createRuntimeWorker,
  type RuntimeBindings,
} from '../../src/worker/runtime/application.ts';
import { runMaintenance } from '../../src/worker/maintenance/driver.ts';
import { clearDatabase } from '../fixtures/database.ts';
import { runtimeManifest, runtimeSecrets } from '../fixtures/runtime.ts';
import { ReadingClient, readingAccount } from '../fixtures/reading-client.ts';
import { HostedCoordinator } from '../../src/worker/recovery/hosted-coordinator.ts';
const secret = 'synthetic-offline-control-token-not-a-deployed-secret';
beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(() => clearDatabase(env.DB));
function bindings() {
  const m = runtimeManifest();
  m.environmentId = 'driver-' + crypto.randomUUID();
  m.ingress = 'on';
  m.generation = 'intercepted';
  const b: RuntimeBindings = {
    DB: env.DB,
    RECOVERY: env.RECOVERY,
    OFFLINE_COORDINATOR: env.OFFLINE_COORDINATOR,
    RECOVERY_CONTROL_SECRET: secret,
    RUNTIME_MANIFEST: JSON.stringify(m),
    RUNTIME_RESOURCE_IDENTITIES: JSON.stringify(m.resources),
    IDENTITY_ORIGIN: m.origin,
    IDENTITY_SECRETS: JSON.stringify(runtimeSecrets(m.environmentId)),
  };
  return { m, b };
}

test('hosted HTTP and scheduled writers honor the independent fence even after database rollback', async () => {
  const { m, b } = bindings(),
    worker = createRuntimeWorker(),
    client = new ReadingClient(b, worker);
  await readingAccount(true, true, client);
  const coordinator = new HostedCoordinator(env.OFFLINE_COORDINATOR, secret, m.environmentId);
  const context = await coordinator.acquire('restore');
  await coordinator.assertCurrent(context);
  expect(await (await worker.fetch(new Request(m.origin + '/health'), b)).json()).toMatchObject({
    generationReady: false,
  });
  await env.DB.prepare('UPDATE system_state SET restore_in_progress=0').run();
  expect((await client.request('/me')).status).toBe(503);
  await expect(
    worker.scheduled({} as ScheduledController, b, {} as ExecutionContext),
  ).rejects.toThrow();
});

test('fresh overlapping wakes preserve one publication and run security/erasure/retention first', async () => {
  const { b } = bindings(),
    client = new ReadingClient(b, createRuntimeWorker());
  await readingAccount(true, true, client);
  await client.create('Synthetic scheduler overlap and security backlog.');
  const runtimes = await Promise.all([createRuntime(b), createRuntime(b)]);
  const summaries = await Promise.all(
    runtimes.map((runtime) =>
      runMaintenance(runtime, { deadlineMs: Date.now() + 90000, concurrency: 4 }),
    ),
  );
  for (const summary of summaries) {
    expect(summary.completedAt).toBeGreaterThan(0);
    expect(summary.services.slice(0, 3)).toEqual(['identity', 'erasure', 'retention']);
    expect(summary.pendingGeneration).toBe(0);
    expect(JSON.stringify(summary)).not.toContain('Synthetic scheduler');
  }
  expect(await env.DB.prepare('SELECT count(*) n FROM reading_editions').first('n')).toBe(1);
  expect(await env.DB.prepare('SELECT count(*) n FROM provider_dispatches').first('n')).toBe(1);
});

test('exhausted budgets do not start work and sub-policy budgets cannot dispatch a provider call', async () => {
  const { b } = bindings(),
    runtime = await createRuntime(b);
  await expect(
    runMaintenance(runtime, { deadlineMs: Date.now() - 1, concurrency: 4 }),
  ).rejects.toThrow('budget');
  const summary = await runMaintenance(runtime, { deadlineMs: Date.now() + 1000, concurrency: 4 });
  expect(summary.work.generation.attempted).toBe(0);
  expect(await env.DB.prepare('SELECT count(*) n FROM provider_dispatches').first('n')).toBe(0);
});

test('the hosted Cron emits a completed content-free heartbeat', async () => {
  const { b } = bindings(),
    worker = createRuntimeWorker(),
    client = new ReadingClient(b, worker);
  await readingAccount(true, true, client);
  await client.create('PRIVATE_HEARTBEAT_SENTINEL');
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  try {
    await worker.scheduled({} as ScheduledController, b, {} as ExecutionContext);
    expect(info).toHaveBeenCalledTimes(1);
    const output = info.mock.calls[0]![0] as string;
    expect(JSON.parse(output)).toMatchObject({
      event: 'maintenance_health',
      completedAt: expect.any(Number),
      work: { identity: 1 },
    });
    expect(output).not.toContain('PRIVATE_HEARTBEAT_SENTINEL');
  } finally {
    info.mockRestore();
  }
});

test('a prepared v2 request waits for a fitting budget then recovers once with its original quota period', async () => {
  const { b } = bindings();
  const { failingDatabase } = await import('../fixtures/failing-generation-db.ts');
  b.DB = failingDatabase('before-dispatch');
  const client = new ReadingClient(b, createRuntimeWorker());
  await readingAccount(true, true, client);
  expect((await client.start('Synthetic prepared scheduler request.')).status).toBe(202);
  const before = await env.DB.prepare(
    'SELECT day_period,month_period FROM quota_reservations',
  ).first();
  b.DB = env.DB;
  await env.DB.prepare('UPDATE generation_requests SET lease_expires_at=1,next_run_at=1').run();
  const short = await runMaintenance(await createRuntime(b), {
    deadlineMs: Date.now() + 1000,
    concurrency: 4,
  });
  expect(short.work.generation.attempted).toBe(0);
  expect(await env.DB.prepare('SELECT count(*) n FROM provider_dispatches').first('n')).toBe(0);
  await runMaintenance(await createRuntime(b), { deadlineMs: Date.now() + 90000, concurrency: 4 });
  await runMaintenance(await createRuntime(b), { deadlineMs: Date.now() + 90000, concurrency: 4 });
  expect(await env.DB.prepare('SELECT count(*) n FROM reading_editions').first('n')).toBe(1);
  expect(await env.DB.prepare('SELECT count(*) n FROM provider_dispatches').first('n')).toBe(1);
  expect(
    await env.DB.prepare('SELECT day_period,month_period FROM quota_reservations').first(),
  ).toEqual(before);
});
