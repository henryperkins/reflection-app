import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, expect, test } from 'vitest';
import {
  createRuntime,
  createRuntimeWorker,
  type RuntimeBindings,
} from '../../src/worker/runtime/application.ts';
import { OfflineRestore } from '../../src/worker/recovery/restore.ts';
import { clearDatabase } from '../fixtures/database.ts';
import { runtimeManifest, runtimeSecrets } from '../fixtures/runtime.ts';
import { readingAccount, ReadingClient } from '../fixtures/reading-client.ts';
import { localDevelopmentBundle } from '../../src/worker/readings/local-content.ts';
beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(() => clearDatabase(env.DB));

test('hosted restore uses configured identity/content, reestablishes the independent epoch and leaves ingress closed', async () => {
  const manifest = runtimeManifest();
  manifest.environmentId = 'restore-' + crypto.randomUUID();
  manifest.ingress = 'on';
  manifest.generation = 'intercepted';
  const bindings: RuntimeBindings = {
    DB: env.DB,
    RECOVERY: env.RECOVERY,
    OFFLINE_COORDINATOR: env.OFFLINE_COORDINATOR,
    RECOVERY_CONTROL_SECRET: 'synthetic-offline-control-token-not-a-deployed-secret',
    RUNTIME_MANIFEST: JSON.stringify(manifest),
    RUNTIME_RESOURCE_IDENTITIES: JSON.stringify(manifest.resources),
    IDENTITY_ORIGIN: manifest.origin,
    IDENTITY_SECRETS: JSON.stringify(runtimeSecrets(manifest.environmentId)),
  };
  const client = new ReadingClient(bindings, createRuntimeWorker());
  await readingAccount(true, true, client);
  const created = await client.create(
    'Synthetic hosted restore must preserve the exact saved body.',
  );
  await client.request(
    '/sessions/' + created.reading.sessionId + '/save',
    { saved: true },
    { method: 'PUT', revision: 1 },
  );
  const runtime = await createRuntime(bindings),
    coordinator = runtime.coordinator!;
  const context = await coordinator.acquire('restore');
  const restore = new OfflineRestore(
    { ...bindings, RESTORE_MODE: 'offline' },
    {
      runtime,
      offline: { coordinator, context },
      validateContent: async (hash) => hash === localDevelopmentBundle().editionHash,
    },
  );
  await restore.prepare();
  await env.DB.prepare('DELETE FROM hosted_coordination').run();
  const result = await restore.replay();
  expect(result.scope).toBe('hosted-synthetic');
  expect(await env.DB.prepare('SELECT epoch FROM hosted_coordination').first('epoch')).toBe(
    context.epoch,
  );
  expect(
    await env.DB.prepare('SELECT restore_in_progress FROM system_state').first(
      'restore_in_progress',
    ),
  ).toBe(1);
  expect((await client.request('/me')).status).toBe(503);
  expect(
    await env.DB.prepare('SELECT body_enc FROM reading_editions WHERE id=?')
      .bind(created.reading.editionId)
      .first('body_enc'),
  ).not.toBeNull();
});

test('hosted restore rejects missing offline context rather than falling back to a process-local lock', async () => {
  const manifest = runtimeManifest();
  manifest.environmentId = 'missing-' + crypto.randomUUID();
  const bindings: RuntimeBindings = {
    DB: env.DB,
    RECOVERY: env.RECOVERY,
    OFFLINE_COORDINATOR: env.OFFLINE_COORDINATOR,
    RECOVERY_CONTROL_SECRET: 'synthetic-offline-control-token-not-a-deployed-secret',
    RUNTIME_MANIFEST: JSON.stringify(manifest),
    RUNTIME_RESOURCE_IDENTITIES: JSON.stringify(manifest.resources),
    IDENTITY_SECRETS: JSON.stringify(runtimeSecrets(manifest.environmentId)),
  };
  const runtime = await createRuntime(bindings);
  expect(
    () =>
      new OfflineRestore(
        { ...bindings, RESTORE_MODE: 'offline' },
        { runtime, validateContent: async () => true },
      ),
  ).toThrow();
});
