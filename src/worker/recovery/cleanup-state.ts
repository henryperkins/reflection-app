import { z } from 'zod';
import { canonicalJson } from '../../domain/json.ts';
import { statement as q } from '../db/core.ts';
import type { ErasureLedger } from './ledger.ts';

export const CLEANUP_STATE_KEY = 'maintenance/v1/cleanup.json';
export const CLEANUP_LIMIT = 1000;
export const CLEANUP_BYTES = 512 * 1024;
const uuid = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const objectKey = z
  .string()
  .max(256)
  .regex(
    new RegExp(
      `^(erasures/v1/${uuid}/(intent\\.json|passes/[1-9][0-9]*/(start|complete)\\.json)|identity/v1/[a-f0-9]{64}/[1-9][0-9]*-${uuid}\\.enc)$`,
    ),
  );
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const common = {
  v: z.literal(1),
  epoch: z.number().int().positive(),
  keyId: z.string().regex(/^[\w-]{1,64}$/),
  backupSha256: hash,
  updatedAt: z.iso.datetime(),
  signature: hash,
};
const Pending = z.strictObject({
  ...common,
  phase: z.literal('pending'),
  retainedInventorySha256: hash,
  objects: z
    .array(z.strictObject({ key: objectKey, etag: z.string().min(1).max(128) }))
    .min(1)
    .max(CLEANUP_LIMIT),
});
const Complete = z.strictObject({
  ...common,
  phase: z.literal('complete'),
  purgedObjects: z.number().int().positive().max(CLEANUP_LIMIT),
});
const State = z.discriminatedUnion('phase', [Pending, Complete]);
export type PendingCleanup = z.infer<typeof Pending>;
export type CleanupReceipt = z.infer<typeof Complete>;
export type CleanupState = z.infer<typeof State>;
export interface LoadedCleanup {
  value: CleanupState;
  etag: string;
}

/** Authenticated, CAS-updated purge journal, independent of the database being restored. */
export class CleanupJournal {
  constructor(readonly ledger: ErasureLedger) {}
  async read(): Promise<LoadedCleanup | null> {
    const object = await this.ledger.bucket.get(CLEANUP_STATE_KEY);
    if (!object) return null;
    if (object.size > CLEANUP_BYTES) throw new Error('Oversized cleanup state');
    const raw = await object.text(),
      value = State.parse(JSON.parse(raw));
    const { signature, ...unsigned } = value,
      key = this.ledger.key(value.keyId);
    if (
      canonicalJson(value) !== raw ||
      signature !==
        (await key.recoveryHash('cleanup-state.v1', [key.secrets.environment, unsigned]))
    )
      throw new Error('Invalid cleanup state authentication');
    if (
      value.phase === 'pending' &&
      new Set(value.objects.map((o) => o.key)).size !== value.objects.length
    )
      throw new Error('Duplicate cleanup plan objects');
    return { value, etag: object.etag };
  }
  async write(
    fields:
      | Omit<PendingCleanup, 'signature' | 'keyId' | 'v' | 'updatedAt'>
      | Omit<CleanupReceipt, 'signature' | 'keyId' | 'v' | 'updatedAt'>,
    previous: LoadedCleanup | null,
  ): Promise<LoadedCleanup> {
    const key = this.ledger.crypt;
    const unsigned = {
      ...fields,
      v: 1 as const,
      keyId: key.secrets.keyId,
      updatedAt: new Date().toISOString(),
    };
    const value = State.parse({
      ...unsigned,
      signature: await key.recoveryHash('cleanup-state.v1', [key.secrets.environment, unsigned]),
    });
    const raw = canonicalJson(value);
    if (new TextEncoder().encode(raw).length > CLEANUP_BYTES)
      throw new Error('Oversized cleanup plan');
    const object = await this.ledger.bucket.put(CLEANUP_STATE_KEY, raw, {
      onlyIf: previous ? { etagMatches: previous.etag } : { etagDoesNotMatch: '*' },
    });
    if (!object) throw new Error('Cleanup state changed');
    return { value, etag: object.etag };
  }
  async requireRestorable(db: D1Database) {
    const state = await this.read();
    const epoch =
      (await q(db, 'SELECT recovery_epoch FROM system_state WHERE id=1').first<number>(
        'recovery_epoch',
      )) ?? 0;
    if (state?.value.phase === 'pending')
      throw new Error('Interrupted cleanup purge must finish before restore');
    if (state ? epoch < state.value.epoch : epoch > 0)
      throw new Error(
        'Recovery epoch is older than cleanup floor or its independent receipt is missing',
      );
    return state;
  }
}
