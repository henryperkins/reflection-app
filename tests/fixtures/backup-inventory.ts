import { env } from 'cloudflare:workers';
import { canonicalJson } from '../../src/domain/json.ts';
import { encode } from '../../src/worker/identity/crypto.ts';
import { bytesDigest } from '../../src/worker/recovery/hosted-coordinator.ts';
import {
  ProtectedBackupInventory,
  type BackupManifest,
} from '../../src/worker/recovery/backup-inventory.ts';
export async function backupInventoryFixture(count = 3, environmentId?: string) {
  const environment = environmentId ?? 'backup-' + crypto.randomUUID(),
    keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const prefix = `inventory/${environment}/`;
  const sign = async (document: unknown) => ({
    document,
    signature: encode(
      new Uint8Array(
        await crypto.subtle.sign(
          'Ed25519',
          keys.privateKey,
          new TextEncoder().encode(canonicalJson(document)),
        ),
      ),
    ),
  });
  const manifests: BackupManifest[] = [];
  for (let i = 0; i < count; i++) {
    const bytes = new TextEncoder().encode('Synthetic encrypted backup bytes ' + i),
      id = crypto.randomUUID(),
      objectKey = 'snapshots/' + environment + '/' + id;
    const manifest: BackupManifest = {
      version: 1,
      id,
      environmentId: environment,
      kind: (['d1', 'recovery', 'offline-keys'] as const)[i % 3]!,
      objectKey,
      sha256: await bytesDigest(bytes),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 45 * 86400000).toISOString(),
      recoveryEpoch: 1,
      requiredEnvironmentKeyIds: ['retained-key'],
      requiredAccountKeys: [],
    };
    await env.BACKUP_INVENTORY.put(objectKey, bytes);
    await env.BACKUP_INVENTORY.put(
      prefix + 'manifests/' + id + '.json',
      JSON.stringify(await sign(manifest)),
    );
    manifests.push(manifest);
  }
  const index = {
    version: 1,
    environmentId: environment,
    complete: true as const,
    epoch: 1,
    manifestIds: manifests.map((m) => m.id),
    updatedAt: new Date().toISOString(),
  };
  await env.BACKUP_INVENTORY.put(prefix + 'index.json', JSON.stringify(await sign(index)));
  return {
    environment,
    keys,
    prefix,
    sign,
    index,
    manifests,
    inventory: new ProtectedBackupInventory(env.BACKUP_INVENTORY, environment, keys.publicKey),
  };
}
