import { sha256Json } from '../../domain/json.ts';
import type { BackupInventory } from './backup-inventory.ts';
import { bytesDigest } from './digest.ts';
import { objects } from './ledger.ts';

/** Verify exact current names and bytes against a separately signed complete inventory.
 * During replay only writes actually observed through the fenced service may extend it.
 */
export async function verifyAttestedRecoveryObjects(
  backups: BackupInventory,
  bucket: R2Bucket,
  environmentId: string,
  epoch: number,
  mutations: ReadonlyMap<string, string | null> = new Map(),
) {
  const manifests = await backups.list();
  for (const manifest of manifests)
    if (manifest.environmentId !== environmentId || !(await backups.verify(manifest)))
      throw new Error('Independent backup bytes unavailable');
  const current = manifests.filter(
    (m) => m.kind === 'recovery' && m.purpose === 'inventory' && m.coordinatorEpoch === epoch,
  );
  if (current.length !== 1 || !current[0]!.recoveryObjects)
    throw new Error('Current independent recovery attestation required');
  const expected = new Map(current[0]!.recoveryObjects.map((o) => [o.key, o.sha256]));
  if (expected.size !== current[0]!.recoveryObjects.length)
    throw new Error('Duplicate independent recovery identity');
  for (const [key, digest] of mutations) {
    if (digest === null) expected.delete(key);
    else expected.set(key, digest);
  }
  const listed = await objects(bucket, '');
  if (listed.length !== expected.size)
    throw new Error('Recovery store differs from independent inventory');
  const descriptors = [];
  for (const object of listed) {
    if (!expected.has(object.key)) throw new Error('Unattested recovery object');
    const body = await bucket.get(object.key);
    if (!body || body.etag !== object.etag || body.size > 64 * 1024 * 1024)
      throw new Error('Recovery object unavailable');
    const sha256 = await bytesDigest(await body.arrayBuffer());
    if (sha256 !== expected.get(object.key))
      throw new Error('Recovery object differs from attested bytes');
    descriptors.push({ key: object.key, sha256 });
  }
  return {
    manifestDigest: await sha256Json(manifests),
    objectDigest: await sha256Json(descriptors.sort((a, b) => a.key.localeCompare(b.key))),
  };
}
