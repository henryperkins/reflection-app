import { z } from 'zod';
import { canonicalJson } from '../../domain/json.ts';
import { decode } from '../identity/crypto.ts';
import { bytesDigest } from './hosted-coordinator.ts';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[\w-]{1,100}$/);
export const BackupManifestSchema = z
  .strictObject({
    version: z.literal(1),
    id: z.uuid(),
    environmentId: id,
    kind: z.enum(['d1', 'recovery', 'offline-keys']),
    objectKey: z.string().regex(/^snapshots\/[\w/-]+$/),
    sha256: digest,
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    recoveryEpoch: z.number().int().nonnegative(),
    requiredEnvironmentKeyIds: z.array(id).max(32),
    requiredAccountKeys: z
      .array(z.strictObject({ ownerId: z.uuid(), version: z.number().int().positive() }))
      .max(100000),
  })
  .refine((m) => Date.parse(m.expiresAt) > Date.parse(m.createdAt));
export type BackupManifest = z.infer<typeof BackupManifestSchema>;
const IndexSchema = z.strictObject({
  version: z.literal(1),
  environmentId: id,
  complete: z.literal(true),
  epoch: z.number().int().nonnegative(),
  manifestIds: z.array(z.uuid()).max(10000),
  updatedAt: z.iso.datetime(),
});
export interface BackupInventory {
  list(): Promise<BackupManifest[]>;
  verify(manifest: BackupManifest): Promise<boolean>;
}

/** Private, independently stored, signed inventory. An absent index is never an empty inventory. */
export class ProtectedBackupInventory implements BackupInventory {
  constructor(
    readonly bucket: R2Bucket | undefined,
    readonly environmentId: string,
    readonly publicKey: CryptoKey,
  ) {}
  private async authenticated<T>(key: string, schema: z.ZodType<T>): Promise<T> {
    if (!this.bucket) throw new Error('Independent backup inventory unavailable');
    const object = await this.bucket.get(key);
    if (!object || object.size > 8 * 1024 * 1024)
      throw new Error('Independent backup inventory unavailable');
    const envelope = z
      .strictObject({ document: z.unknown(), signature: z.string().regex(/^[\w-]{86}$/) })
      .parse(await object.json());
    const value = schema.parse(envelope.document);
    if (
      !(await crypto.subtle.verify(
        'Ed25519',
        this.publicKey,
        decode(envelope.signature),
        new TextEncoder().encode(canonicalJson(value)),
      ))
    )
      throw new Error('Invalid backup inventory signature');
    return value;
  }
  private prefix() {
    return `inventory/${this.environmentId}/`;
  }
  async list(): Promise<BackupManifest[]> {
    const index = await this.authenticated(this.prefix() + 'index.json', IndexSchema);
    if (
      index.environmentId !== this.environmentId ||
      Date.parse(index.updatedAt) > Date.now() + 60_000 ||
      Date.now() - Date.parse(index.updatedAt) > 86400000 ||
      new Set(index.manifestIds).size !== index.manifestIds.length
    )
      throw new Error('Incomplete or stale backup inventory');
    const keys = new Set<string>();
    let cursor: string | undefined;
    const cursors = new Set<string>();
    do {
      const page = await this.bucket!.list({
        prefix: this.prefix() + 'manifests/',
        ...(cursor ? { cursor } : {}),
      });
      for (const object of page.objects) {
        if (keys.has(object.key) || keys.size >= 10000)
          throw new Error('Duplicate or oversized backup inventory');
        keys.add(object.key);
      }
      cursor = page.truncated ? page.cursor : undefined;
      if (cursor) {
        if (cursors.has(cursor)) throw new Error('Incomplete backup listing');
        cursors.add(cursor);
      }
    } while (cursor);
    const expected = new Set(
      index.manifestIds.map((value) => this.prefix() + 'manifests/' + value + '.json'),
    );
    if (keys.size !== expected.size || [...keys].some((key) => !expected.has(key)))
      throw new Error('Incomplete backup inventory');
    const manifests: BackupManifest[] = [];
    for (const key of [...keys].sort()) {
      const manifest = await this.authenticated(key, BackupManifestSchema);
      if (
        manifest.environmentId !== this.environmentId ||
        key !== this.prefix() + 'manifests/' + manifest.id + '.json' ||
        manifest.recoveryEpoch > index.epoch ||
        new Set(manifest.requiredEnvironmentKeyIds).size !==
          manifest.requiredEnvironmentKeyIds.length ||
        new Set(manifest.requiredAccountKeys.map((k) => `${k.ownerId}:${k.version}`)).size !==
          manifest.requiredAccountKeys.length
      )
        throw new Error('Invalid backup manifest identity');
      manifests.push(manifest);
    }
    // Detect inventory replacement or new/removed entries while listing.
    if (
      canonicalJson(index) !==
      canonicalJson(await this.authenticated(this.prefix() + 'index.json', IndexSchema))
    )
      throw new Error('Backup inventory changed');
    return manifests;
  }
  async verify(manifest: BackupManifest): Promise<boolean> {
    if (!this.bucket || manifest.environmentId !== this.environmentId) return false;
    const registered = await this.authenticated(
      this.prefix() + 'manifests/' + manifest.id + '.json',
      BackupManifestSchema,
    );
    if (canonicalJson(registered) !== canonicalJson(manifest)) return false;
    const object = await this.bucket.get(manifest.objectKey);
    if (!object || object.size > 64 * 1024 * 1024) return false;
    return (await bytesDigest(await object.arrayBuffer())) === manifest.sha256;
  }
  async verified() {
    const first = await this.list();
    for (const manifest of first)
      if (!(await this.verify(manifest))) throw new Error('Backup bytes unavailable or changed');
    const second = await this.list();
    if (canonicalJson(first) !== canonicalJson(second)) throw new Error('Backup inventory changed');
    return {
      manifests: first,
      digest: await bytesDigest(new TextEncoder().encode(canonicalJson(first))),
    };
  }
}
