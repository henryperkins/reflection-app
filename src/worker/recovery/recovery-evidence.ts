import { z } from 'zod';
import { sha256Json } from '../../domain/json.ts';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const environmentName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);

export const RecoveryValidation = z.strictObject({
  version: z.literal(1),
  producer: z.literal('restore-validator.v1'),
  status: z.literal('passed'),
  environmentId: environmentName,
  operationId: z.uuid(),
  epoch: z.number().int().nonnegative(),
  sourceDigest: hash,
  configurationDigest: hash,
  backupInventoryDigest: hash,
  recoveryValidationDigest: hash,
  financialReconciliationDigest: hash,
  validatedAt: z.iso.datetime(),
  generation: z.literal('off'),
});
export type RecoveryValidationDocument = z.infer<typeof RecoveryValidation>;

/** Signed by the independent recovery validator; the app Worker holds no such private key. */
export const SignedRecoveryValidation = z.strictObject({
  document: RecoveryValidation,
  signature: z.string().regex(/^[\w-]{86}$/),
});

/** Canonical financial snapshot both the validator and the coordinator hash identically. */
export async function financialReconciliationDigest(db: D1Database): Promise<string> {
  const [reservations, spendBuckets, dispatches] = await Promise.all([
    db
      .prepare(
        'SELECT state,count(*) AS n,coalesce(sum(reserved_microusd),0) AS reserved_microusd,coalesce(sum(actual_microusd),0) AS actual_microusd FROM cost_reservations GROUP BY state ORDER BY state',
      )
      .all(),
    db
      .prepare(
        'SELECT period,ceiling_microusd,committed_microusd FROM spend_buckets ORDER BY period',
      )
      .all(),
    db
      .prepare('SELECT state,count(*) AS n FROM provider_dispatches GROUP BY state ORDER BY state')
      .all(),
  ]);
  return sha256Json({
    reservations: reservations.results,
    spendBuckets: spendBuckets.results,
    dispatches: dispatches.results,
  });
}

/**
 * Digest of the signed backup manifests' documents, in manifest-key order.
 * The coordinator extracts documents without trusting them: the recovery
 * validator's signature is what binds this digest to a verified inventory,
 * and recomputation here proves the inventory has not changed since.
 */
export async function backupInventoryManifestDigest(
  bucket: R2Bucket,
  environmentId: string,
): Promise<string> {
  const keys: string[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await bucket.list({
      prefix: 'inventory/' + environmentId + '/manifests/',
      ...(cursor ? { cursor } : {}),
    });
    for (const object of page.objects) keys.push(object.key);
    cursor = page.truncated ? page.cursor : undefined;
    if (cursor) {
      if (cursors.has(cursor)) throw new Error('Recovery validation required');
      cursors.add(cursor);
    }
  } while (cursor);
  keys.sort();
  const documents: unknown[] = [];
  for (const key of keys) {
    const object = await bucket.get(key);
    if (!object || object.size > 8 * 1024 * 1024) throw new Error('Recovery validation required');
    documents.push(
      z.strictObject({ document: z.unknown(), signature: z.string() }).parse(await object.json())
        .document,
    );
  }
  return sha256Json(documents);
}
