import { expect, test } from 'vitest';
import { validateRuntimeManifest, renderHostedConfig } from '../../src/worker/runtime/config.ts';
import { runtimeManifest } from '../fixtures/runtime.ts';

test('hosted manifest binds an exact HTTPS origin, RP ID, immutable environment and isolated resources', () => {
  const manifest = runtimeManifest();
  expect(validateRuntimeManifest(manifest)).toEqual(manifest);
});

test.each([
  'origin',
  'rpId',
  'database',
  'recovery',
  'coordinator',
  'backups',
  'evidence',
  'environment',
  'partial',
  'unknown',
])('rejects an invalid or shared %s boundary', (failure) => {
  const manifest = runtimeManifest();
  if (failure === 'origin') manifest.origin = 'http://qualification.example.test';
  if (failure === 'rpId') manifest.rpId = 'unrelated.example.test';
  if (failure === 'database') manifest.resources.databaseId = manifest.isolatedFrom[0]!.databaseId;
  if (failure === 'recovery')
    manifest.resources.recoveryBucket = manifest.isolatedFrom[0]!.recoveryBucket;
  if (failure === 'coordinator')
    manifest.resources.coordinatorId = manifest.isolatedFrom[0]!.coordinatorId;
  if (failure === 'backups')
    manifest.resources.backupInventoryBucket = manifest.isolatedFrom[0]!.backupInventoryBucket;
  if (failure === 'evidence')
    manifest.resources.qualificationBucket = manifest.isolatedFrom[0]!.qualificationBucket;
  if (failure === 'environment') manifest.environmentId = manifest.isolatedFrom[0]!.environmentId;
  const input: Record<string, unknown> = manifest;
  if (failure === 'partial') delete input.resources;
  if (failure === 'unknown') input.providerKey = 'PRIVATE_CONFIG_MARKER';
  expect(() => validateRuntimeManifest(input)).toThrow('Runtime configuration unavailable');
});

test('local runtime permits localhost only and production cannot select an intercepted writer', () => {
  expect(validateRuntimeManifest(runtimeManifest('synthetic-local')).mode).toBe('synthetic-local');
  const local = runtimeManifest('synthetic-local');
  local.origin = 'https://remote.example.test';
  local.rpId = 'remote.example.test';
  expect(() => validateRuntimeManifest(local)).toThrow();
  const production = runtimeManifest('production');
  production.generation = 'intercepted';
  expect(() => validateRuntimeManifest(production)).toThrow();
});

test('production config rendering begins with ingress and generation closed and contains no credentials', () => {
  const manifest = runtimeManifest('production');
  manifest.ingress = 'on';
  manifest.generation = 'qualified';
  manifest.qualificationEvidenceDigest = 'c'.repeat(64);
  const config = renderHostedConfig(manifest);
  const installed = JSON.parse(config.vars.RUNTIME_MANIFEST);
  expect(installed.ingress).toBe('off');
  expect(installed.generation).toBe('off');
  expect(config.d1_databases[0]!.database_id).toBe(manifest.resources.databaseId);
  expect(config.r2_buckets.map((binding) => binding.bucket_name)).toEqual(
    expect.arrayContaining([
      manifest.resources.recoveryBucket,
      manifest.resources.backupInventoryBucket,
    ]),
  );
  expect(JSON.stringify(config)).not.toMatch(/wrapKey|recoveryKey|hmacKey|OPENAI_API_KEY/);
  expect(config.main).toBe('src/worker/runtime/application.ts');
});

test('hosted configuration refuses a local manifest or missing peer resource inventory', () => {
  expect(() => renderHostedConfig(runtimeManifest('synthetic-local'))).toThrow();
  const hosted = runtimeManifest();
  hosted.isolatedFrom = [];
  expect(() => validateRuntimeManifest(hosted)).toThrow();
});

test('a recovery bucket cannot reuse another environment backup or qualification bucket', () => {
  const manifest = runtimeManifest();
  manifest.resources.recoveryBucket = manifest.isolatedFrom[0]!.backupInventoryBucket;
  expect(() => validateRuntimeManifest(manifest)).toThrow('Runtime configuration unavailable');
});
