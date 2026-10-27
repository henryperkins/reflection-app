import { env } from 'cloudflare:workers';
import {
  createRuntime,
  createRuntimeWorker,
  type RuntimeBindings,
} from '../../src/worker/runtime/application.ts';
import { objects } from '../../src/worker/recovery/ledger.ts';
import { bytesDigest } from '../../src/worker/recovery/digest.ts';
import { runtimeManifest, runtimeSecrets } from './runtime.ts';
import { backupInventoryFixture } from './backup-inventory.ts';
import { readingAccount, ReadingClient } from './reading-client.ts';
import type { BackupManifest } from '../../src/worker/recovery/backup-inventory.ts';
export async function keyInventoryFixture() {
  const m = runtimeManifest();
  m.environmentId = 'inventory-' + crypto.randomUUID();
  m.ingress = 'on';
  m.generation = 'intercepted';
  const first = runtimeSecrets(m.environmentId),
    second = { ...runtimeSecrets(m.environmentId), keyId: 'unused-retained' };
  const { environment: _, ...active } = first,
    { environment: __, ...unused } = second;
  const keyring = {
    v: 1 as const,
    environment: m.environmentId,
    activeKeyId: active.keyId,
    identityHmacKey: first.hmacKey,
    keys: [active, unused],
  };
  const b: RuntimeBindings = {
    DB: env.DB,
    RECOVERY: env.RECOVERY,
    OFFLINE_COORDINATOR: env.OFFLINE_COORDINATOR,
    RECOVERY_CONTROL_SECRET: 'synthetic-offline-control-token-not-a-deployed-secret',
    RUNTIME_MANIFEST: JSON.stringify(m),
    RUNTIME_RESOURCE_IDENTITIES: JSON.stringify(m.resources),
    IDENTITY_ORIGIN: m.origin,
    IDENTITY_SECRETS: JSON.stringify(keyring),
  };
  const client = new ReadingClient(b, createRuntimeWorker()),
    account = await readingAccount(true, true, client);
  const created = await client.create('Synthetic key reference inventory.');
  const runtime = await createRuntime(b),
    context = await runtime.coordinator!.acquire('retirement');
  const owner = (await env.DB.prepare('SELECT id FROM accounts').first<string>('id'))!;
  const backups = await backupInventoryFixture(0, m.environmentId);
  async function attest(currentContext = context) {
    for (const old of [...backups.manifests])
      if (old.purpose === 'inventory') {
        await env.BACKUP_INVENTORY.delete(backups.prefix + 'manifests/' + old.id + '.json');
        await env.BACKUP_INVENTORY.delete(old.objectKey);
        backups.manifests.splice(backups.manifests.indexOf(old), 1);
        backups.index.manifestIds.splice(backups.index.manifestIds.indexOf(old.id), 1);
      }

    const recoveryObjects = [];
    for (const object of await objects(env.RECOVERY, '')) {
      const body = await env.RECOVERY.get(object.key);
      if (!body) throw new Error('Missing fixture object');
      recoveryObjects.push({
        key: object.key,
        sha256: await bytesDigest(await body.arrayBuffer()),
      });
    }
    const id = crypto.randomUUID(),
      objectKey = 'snapshots/' + m.environmentId + '/' + id,
      bytes = new TextEncoder().encode(
        JSON.stringify({ version: 1, environmentId: m.environmentId, objects: recoveryObjects }),
      );
    const manifest: BackupManifest = {
      version: 1,
      id,
      environmentId: m.environmentId,
      kind: 'recovery',
      purpose: 'inventory',
      coordinatorEpoch: currentContext.epoch,
      recoveryObjects,
      objectKey,
      sha256: await bytesDigest(bytes),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      recoveryEpoch: 0,
      requiredEnvironmentKeyIds: [],
      requiredAccountKeys: [],
    };
    await env.BACKUP_INVENTORY.put(objectKey, bytes);
    await env.BACKUP_INVENTORY.put(
      backups.prefix + 'manifests/' + id + '.json',
      JSON.stringify(await backups.sign(manifest)),
    );
    backups.manifests.push(manifest);
    backups.index.manifestIds.push(id);
    await env.BACKUP_INVENTORY.put(
      backups.prefix + 'index.json',
      JSON.stringify(await backups.sign(backups.index)),
    );
    return manifest;
  }
  await attest();
  return { m, b, runtime, context, owner, backups, attest, account, keyring, client, created };
}
