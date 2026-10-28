import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, expect, test } from 'vitest';
import { keyInventoryFixture } from '../fixtures/key-inventory.ts';
import { clearDatabase } from '../fixtures/database.ts';
import { objects } from '../../src/worker/recovery/ledger.ts';
import { validateAndResumeRecovery } from '../../src/worker/recovery/recovery-validation.ts';

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await clearDatabase(env.DB);
  for (const object of await objects(env.RECOVERY, '')) await env.RECOVERY.delete(object.key);
});

async function validatorKey() {
  return crypto.subtle.importKey(
    'jwk',
    JSON.parse(env.TEST_RECOVERY_VALIDATION_SIGNING_KEY),
    'Ed25519',
    false,
    ['sign'],
  );
}

test('signed recovery validation produced from a complete inventory resumes ingress with generation off', async () => {
  const f = await keyInventoryFixture();
  await expect(f.runtime.coordinator!.withWriter(async () => 42)).rejects.toThrow();
  const receipt = await validateAndResumeRecovery({
    runtime: f.runtime,
    context: f.context,
    backups: f.backups.inventory,
    bucket: env.BACKUP_INVENTORY,
    signingKey: await validatorKey(),
    sourceDigest: 'a'.repeat(64),
    configurationDigest: 'b'.repeat(64),
  });
  expect(receipt).toMatchObject({
    environmentId: f.m.environmentId,
    operationId: f.context.operationId,
    epoch: f.context.epoch,
    generation: 'off',
    resumed: true,
  });
  expect(
    await env.DB.prepare('SELECT state FROM hosted_coordination WHERE environment_id=?')
      .bind(f.m.environmentId)
      .first('state'),
  ).toBe('online');
  expect(
    await env.DB.prepare(
      'SELECT restore_in_progress,generation_enabled FROM system_state WHERE id=1',
    ).first(),
  ).toEqual({ restore_in_progress: 0, generation_enabled: 0 });
  const artifact = await env.BACKUP_INVENTORY.get(
    'recovery-validation/' + receipt.evidenceHash + '.json',
  );
  expect(artifact).not.toBeNull();
  await expect(f.runtime.coordinator!.withWriter(async () => 42)).resolves.toBe(42);
});

test('recovery validation with the wrong validator key leaves the environment offline', async () => {
  const f = await keyInventoryFixture();
  const wrong = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  await expect(
    validateAndResumeRecovery({
      runtime: f.runtime,
      context: f.context,
      backups: f.backups.inventory,
      bucket: env.BACKUP_INVENTORY,
      signingKey: wrong.privateKey,
      sourceDigest: 'a'.repeat(64),
      configurationDigest: 'b'.repeat(64),
    }),
  ).rejects.toThrow();
  await expect(f.runtime.coordinator!.withWriter(async () => 42)).rejects.toThrow();
});
