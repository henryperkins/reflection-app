import { z } from 'zod';
import { canonicalJson } from '../../domain/json.ts';
import { encode } from '../identity/crypto.ts';
import { statement as q, DB_NOW } from '../db/core.ts';
import { assertion } from '../identity/checkpoint.ts';
import type { ApplicationRuntime } from '../runtime/application.ts';
import type { BackupInventory } from './backup-inventory.ts';
import type { OfflineContext } from './hosted-coordinator.ts';
import {
  RecoveryValidation,
  financialReconciliationDigest,
  type RecoveryValidationDocument,
} from './recovery-evidence.ts';
import { bytesDigest } from './digest.ts';
import { inventoryKeyReferences } from './key-inventory.ts';

const hash = z.string().regex(/^[a-f0-9]{64}$/);

export interface RecoveryValidationInput {
  runtime: ApplicationRuntime;
  context: OfflineContext;
  backups: BackupInventory;
  /** Bucket the coordinator reads `recovery-validation/<digest>.json` from. */
  bucket: R2Bucket;
  /**
   * Independent validator private key. It is supplied only by the trusted
   * operator executor and must never be an application Worker binding; the
   * coordinator pins the matching public key as RECOVERY_VALIDATION_TRUST.
   */
  signingKey: CryptoKey;
  /** Candidate identities the validator verified against the release packet. */
  sourceDigest: string;
  configurationDigest: string;
}

export interface ProducedRecoveryValidation {
  document: RecoveryValidationDocument;
  evidenceHash: string;
}

export interface RecoveryResumeReceipt {
  version: 1;
  environmentId: string;
  operationId: string;
  epoch: number;
  purpose: OfflineContext['purpose'];
  evidenceHash: string;
  validatedAt: string;
  generation: 'off';
  resumed: true;
}

/** Sign one validation document; the signature covers canonical document JSON. */
export async function signRecoveryValidation(
  document: RecoveryValidationDocument,
  signingKey: CryptoKey,
): Promise<{ document: RecoveryValidationDocument; signature: string }> {
  const parsed = RecoveryValidation.parse(document);
  if (
    signingKey.type !== 'private' ||
    signingKey.algorithm.name !== 'Ed25519' ||
    !signingKey.usages.includes('sign')
  )
    throw new Error('Independent recovery validation signing key required');
  const signature = encode(
    new Uint8Array(
      await crypto.subtle.sign(
        'Ed25519',
        signingKey,
        new TextEncoder().encode(canonicalJson(parsed)),
      ),
    ),
  );
  return { document: parsed, signature };
}

/**
 * The missing producer step for hosted resumption. Under the persistent
 * offline fence it runs the complete key-reference inventory, hashes the
 * financial tables and the signed backup inventory as the coordinator will
 * recompute them, signs the result with the independent validator key,
 * stores the content-addressed artifact and mirrors it as `validated` in D1.
 * The environment stays offline until `resume` re-verifies all of it.
 */
export async function produceRecoveryValidation(
  input: RecoveryValidationInput,
): Promise<ProducedRecoveryValidation> {
  const { runtime, context, backups, bucket, signingKey } = input;
  hash.parse(input.sourceDigest);
  hash.parse(input.configurationDigest);
  if (
    !runtime.coordinator ||
    context.environmentId !== runtime.environmentId ||
    runtime.coordinator.environmentId !== runtime.environmentId
  )
    throw new Error('Offline coordinator required');
  if (
    signingKey.type !== 'private' ||
    signingKey.algorithm.name !== 'Ed25519' ||
    !signingKey.usages.includes('sign')
  )
    throw new Error('Independent recovery validation signing key required');
  return runtime.coordinator.withOffline(context, async () => {
    const inventory = await inventoryKeyReferences(runtime, context, backups);
    if (!inventory.complete) throw new Error('Recovery validation inventory incomplete');
    const document = RecoveryValidation.parse({
      version: 1,
      producer: 'restore-validator.v1',
      status: 'passed',
      environmentId: context.environmentId,
      operationId: context.operationId,
      epoch: context.epoch,
      sourceDigest: input.sourceDigest,
      configurationDigest: input.configurationDigest,
      backupInventoryDigest: inventory.manifestDigest,
      recoveryValidationDigest: inventory.referenceDigest,
      financialReconciliationDigest: await financialReconciliationDigest(runtime.base.db),
      validatedAt: new Date().toISOString(),
      generation: 'off',
    });
    const envelope = await signRecoveryValidation(document, signingKey);
    const bytes = new TextEncoder().encode(canonicalJson(envelope));
    const evidenceHash = await bytesDigest(bytes);
    await bucket.put('recovery-validation/' + evidenceHash + '.json', bytes);
    await runtime.base.db.batch([
      assertion(
        runtime.base.db,
        "EXISTS(SELECT 1 FROM hosted_coordination WHERE environment_id=? AND epoch=? AND state='offline')",
        context.environmentId,
        context.epoch,
      ),
      assertion(
        runtime.base.db,
        "EXISTS(SELECT 1 FROM system_state WHERE id=1 AND restore_in_progress=1 AND generation_enabled=0 AND dispatch_mode='off')",
      ),
      q(
        runtime.base.db,
        `INSERT INTO hosted_coordination VALUES(?,?,'validated',?,${DB_NOW}) ON CONFLICT(environment_id) DO UPDATE SET epoch=excluded.epoch,state='validated',evidence_hash=excluded.evidence_hash,updated_at=excluded.updated_at`,
        context.environmentId,
        context.epoch,
        evidenceHash,
      ),
    ]);
    return { document, evidenceHash };
  });
}

/**
 * Produce fresh signed evidence, complete the offline operation with it and
 * resume ingress (generation stays off). Any failure leaves the environment
 * offline with its durable progress intact.
 */
export async function validateAndResumeRecovery(
  input: RecoveryValidationInput,
): Promise<RecoveryResumeReceipt> {
  const { runtime, context } = input;
  if (!runtime.coordinator) throw new Error('Offline coordinator required');
  const { document, evidenceHash } = await produceRecoveryValidation(input);
  await runtime.coordinator.complete(context, evidenceHash);
  await runtime.coordinator.resume(context, evidenceHash);
  return {
    version: 1,
    environmentId: context.environmentId,
    operationId: context.operationId,
    epoch: context.epoch,
    purpose: context.purpose,
    evidenceHash,
    validatedAt: document.validatedAt,
    generation: 'off',
    resumed: true,
  };
}
