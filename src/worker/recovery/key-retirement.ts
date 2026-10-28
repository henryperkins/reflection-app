import { z } from 'zod';
import { timingSafeEqual } from 'node:crypto';
import { canonicalJson, sha256Json } from '../../domain/json.ts';
import { IdentityCrypto, type IdentityKeyring } from '../identity/crypto.ts';
import type { ApplicationRuntime } from '../runtime/application.ts';
import type { OfflineContext } from './hosted-coordinator.ts';
import type { BackupInventory } from './backup-inventory.ts';
import { inventoryKeyReferences, type KeyReferenceInventory } from './key-inventory.ts';
import { assertion } from '../identity/checkpoint.ts';
import { statement as q, DB_NOW } from '../db/core.ts';

const hash = z.string().regex(/^[a-f0-9]{64}$/),
  name = z.string().regex(/^[\w-]{1,64}$/),
  count = z.number().int().nonnegative();
const KeyReference = z.strictObject({
  ownerId: z.uuid(),
  version: z.number().int().positive(),
  wrapKeyId: name,
  active: z.boolean(),
  liveFields: count,
  operationalReferences: count,
  unfinishedJob: z.boolean(),
  backupRequired: z.boolean(),
});
const Inventory = z.strictObject({
  version: z.literal(1),
  environmentId: name,
  coordinatorEpoch: z.number().int().positive(),
  registryHash: hash,
  manifestDigest: hash,
  referenceDigest: hash,
  observedAt: z.iso.datetime(),
  referencedKeyIds: z.array(name).max(32),
  accountKeys: z.array(KeyReference).max(100000),
  counts: z.strictObject({
    wraps: count,
    fields: count,
    checkpoints: count,
    securityOperations: count,
    erasureChains: count,
    backups: count,
    unfinishedRekeys: count,
  }),
  complete: z.boolean(),
  digest: hash,
  limitations: z.array(z.string().max(2000)).max(20),
});
const common = {
  version: z.literal(1),
  operationId: z.uuid(),
  environmentId: name,
  coordinatorEpoch: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  inventoryDigest: hash,
  referenceDigest: hash,
  manifestDigest: hash,
  registryHash: hash,
  allowed: z.boolean(),
  reasons: z.array(z.string().max(100)).max(100),
};
const EnvironmentPlan = z.strictObject({
  ...common,
  kind: z.literal('environment'),
  sourceKeyringDigest: hash,
  removeKeyIds: z.array(name).min(1).max(31),
  retainedKeyIds: z.array(name).max(32),
  planHash: hash,
});
const DataPlan = z.strictObject({
  ...common,
  kind: z.literal('account-data'),
  ownerId: z.uuid(),
  keyVersion: z.number().int().positive(),
  planHash: hash,
});
export type RetirementPlan = z.infer<typeof EnvironmentPlan>;
export type AccountDataRetirementPlan = z.infer<typeof DataPlan>;
const EnvReceipt = z.strictObject({
  version: z.literal(1),
  kind: z.literal('environment'),
  operationId: z.uuid(),
  environmentId: name,
  coordinatorEpoch: z.number().int().positive(),
  status: z.literal('prepared'),
  sourceKeyringDigest: hash,
  candidateKeyringDigest: hash,
  removedKeyIds: z.array(name).min(1).max(31),
  planHash: hash,
  inventoryDigest: hash,
  referenceDigest: hash,
  manifestDigest: hash,
  createdAt: z.iso.datetime(),
  installed: z.literal(false),
  destroyed: z.literal(false),
  stillOffline: z.literal(true),
});
export type RetirementReceipt = z.infer<typeof EnvReceipt>;
const DataReceipt = z.strictObject({
  version: z.literal(1),
  kind: z.literal('account-data'),
  operationId: z.uuid(),
  environmentId: name,
  coordinatorEpoch: z.number().int().positive(),
  status: z.literal('committed'),
  retiredVersion: z.number().int().positive(),
  planHash: hash,
  inventoryDigest: hash,
  createdAt: z.iso.datetime(),
  stillOffline: z.literal(true),
});

export function normalizedKeyring(crypt: IdentityCrypto): IdentityKeyring {
  return {
    v: 1,
    environment: crypt.secrets.environment,
    activeKeyId: crypt.secrets.keyId,
    identityHmacKey: crypt.identityHmacKey,
    keys: [crypt, ...crypt.retainedKeys()]
      .map((k) => {
        const { environment: _, ...bundle } = k.secrets;
        return bundle;
      })
      .sort((a, b) => a.keyId.localeCompare(b.keyId)),
  };
}
async function inventoryReasons(input: KeyReferenceInventory) {
  const value = Inventory.parse(input),
    { digest, ...document } = value,
    reasons: string[] = [];
  if ((await sha256Json(document)) !== digest) reasons.push('INVENTORY_INTEGRITY');
  if (!value.complete) reasons.push('INVENTORY_INCOMPLETE');
  if (
    Date.now() - Date.parse(value.observedAt) > 300000 ||
    Date.parse(value.observedAt) > Date.now() + 60000
  )
    reasons.push('INVENTORY_EXPIRED');
  return { value, reasons };
}
function planBase(value: KeyReferenceInventory, reasons: string[]) {
  const now = Date.now();
  return {
    version: 1 as const,
    operationId: crypto.randomUUID(),
    environmentId: value.environmentId,
    coordinatorEpoch: value.coordinatorEpoch,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(
      Math.min(now + 300000, Date.parse(value.observedAt) + 300000),
    ).toISOString(),
    inventoryDigest: value.digest,
    referenceDigest: value.referenceDigest,
    manifestDigest: value.manifestDigest,
    registryHash: value.registryHash,
    allowed: reasons.length === 0,
    reasons,
  };
}
export async function planKeyRetirement(
  current: IdentityKeyring,
  input: KeyReferenceInventory,
  keyIds: string[],
): Promise<RetirementPlan> {
  const ring = normalizedKeyring(new IdentityCrypto(current)),
    { value, reasons } = await inventoryReasons(input),
    remove = [...new Set(z.array(name).min(1).max(31).parse(keyIds))].sort();
  if (remove.length !== keyIds.length) reasons.push('DUPLICATE_KEY');
  if (ring.environment !== value.environmentId) reasons.push('ENVIRONMENT_MISMATCH');
  for (const id of remove) {
    if (id === ring.activeKeyId) reasons.push('ACTIVE_KEY');
    if (!ring.keys.some((k) => k.keyId === id)) reasons.push('UNKNOWN_KEY');
    if (value.referencedKeyIds.includes(id)) reasons.push('KEY_REFERENCED');
  }
  const base = {
    ...planBase(value, reasons),
    kind: 'environment' as const,
    sourceKeyringDigest: await sha256Json(ring),
    removeKeyIds: remove,
    retainedKeyIds: ring.keys.filter((k) => !remove.includes(k.keyId)).map((k) => k.keyId),
  };
  return EnvironmentPlan.parse({ ...base, planHash: await sha256Json(base) });
}
export async function planAccountDataKeyRetirement(
  input: KeyReferenceInventory,
  ownerId: string,
  keyVersion: number,
): Promise<AccountDataRetirementPlan> {
  const { value, reasons } = await inventoryReasons(input);
  z.uuid().parse(ownerId);
  z.number().int().positive().parse(keyVersion);
  const key = value.accountKeys.find((k) => k.ownerId === ownerId && k.version === keyVersion);
  if (!key) reasons.push('UNKNOWN_ACCOUNT_KEY');
  else {
    if (key.active) reasons.push('ACTIVE_ACCOUNT_KEY');
    if (key.liveFields || key.operationalReferences) reasons.push('ACCOUNT_KEY_REFERENCED');
    if (key.unfinishedJob) reasons.push('UNFINISHED_REKEY');
    if (key.backupRequired) reasons.push('BACKUP_REQUIRES_KEY');
  }
  const base = { ...planBase(value, reasons), kind: 'account-data' as const, ownerId, keyVersion };
  return { ...base, planHash: await sha256Json(base) };
}
async function validatePlan(
  plan: RetirementPlan | AccountDataRetirementPlan,
  context: OfflineContext,
) {
  const { planHash, ...document } = plan;
  if (
    !plan.allowed ||
    plan.reasons.length ||
    (await sha256Json(document)) !== planHash ||
    Date.parse(plan.expiresAt) <= Date.now() ||
    Date.parse(plan.createdAt) > Date.now() + 60000 ||
    context.purpose !== 'retirement' ||
    context.environmentId !== plan.environmentId ||
    context.epoch !== plan.coordinatorEpoch
  )
    throw new Error('Current authenticated retirement plan required');
}
function sameReferences(
  plan: RetirementPlan | AccountDataRetirementPlan,
  inventory: KeyReferenceInventory,
) {
  if (
    !inventory.complete ||
    inventory.environmentId !== plan.environmentId ||
    inventory.coordinatorEpoch !== plan.coordinatorEpoch ||
    inventory.referenceDigest !== plan.referenceDigest ||
    inventory.manifestDigest !== plan.manifestDigest ||
    inventory.registryHash !== plan.registryHash
  )
    throw new Error('Retirement references changed');
}
function offlineGuard(runtime: ApplicationRuntime, context: OfflineContext) {
  return [
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
  ];
}

/** Prepare a protected candidate only; this never installs a secret or destroys an offline copy. */
export async function applyKeyRetirement(
  runtime: ApplicationRuntime,
  context: OfflineContext,
  backups: BackupInventory,
  input: RetirementPlan,
) {
  const plan = EnvironmentPlan.parse(input);
  await validatePlan(plan, context);
  if (!runtime.coordinator) throw new Error('Offline coordinator required');
  const current = normalizedKeyring(runtime.identity.crypt);
  if ((await sha256Json(current)) !== plan.sourceKeyringDigest)
    throw new Error('Installed key material changed');
  return runtime.coordinator.withOffline(context, async () => {
    const inventory = await inventoryKeyReferences(runtime, context, backups);
    sameReferences(plan, inventory);
    const refreshed = await planKeyRetirement(current, inventory, plan.removeKeyIds);
    if (
      !refreshed.allowed ||
      canonicalJson(refreshed.retainedKeyIds) !== canonicalJson(plan.retainedKeyIds)
    )
      throw new Error('Key remains required');
    const candidate = {
      ...current,
      keys: current.keys.filter((k) => !plan.removeKeyIds.includes(k.keyId)),
    };
    new IdentityCrypto(candidate);
    const receipt: RetirementReceipt = {
      version: 1,
      kind: 'environment',
      operationId: plan.operationId,
      environmentId: plan.environmentId,
      coordinatorEpoch: plan.coordinatorEpoch,
      status: 'prepared',
      sourceKeyringDigest: plan.sourceKeyringDigest,
      candidateKeyringDigest: await sha256Json(candidate),
      removedKeyIds: plan.removeKeyIds,
      planHash: plan.planHash,
      inventoryDigest: plan.inventoryDigest,
      referenceDigest: plan.referenceDigest,
      manifestDigest: plan.manifestDigest,
      createdAt: plan.createdAt,
      installed: false,
      destroyed: false,
      stillOffline: true,
    };
    await checkRetirementCandidate(current, candidate, receipt);
    await runtime.base.db.batch([
      ...offlineGuard(runtime, context),
      q(
        runtime.base.db,
        `INSERT OR IGNORE INTO key_retirement_operations VALUES(?,?,?,'environment',NULL,NULL,?,?,${DB_NOW})`,
        plan.operationId,
        plan.environmentId,
        context.epoch,
        plan.planHash,
        canonicalJson(receipt),
      ),
      assertion(
        runtime.base.db,
        'EXISTS(SELECT 1 FROM key_retirement_operations WHERE id=? AND plan_hash=? AND receipt_json=?)',
        plan.operationId,
        plan.planHash,
        canonicalJson(receipt),
      ),
    ]);
    return { candidate, receipt };
  });
}
export async function checkRetirementCandidate(
  currentInput: IdentityKeyring,
  candidateInput: IdentityKeyring,
  input: RetirementReceipt,
) {
  const receipt = EnvReceipt.parse(input),
    current = normalizedKeyring(new IdentityCrypto(currentInput)),
    candidate = normalizedKeyring(new IdentityCrypto(candidateInput));
  if (
    current.environment !== receipt.environmentId ||
    candidate.environment !== current.environment ||
    candidate.activeKeyId !== current.activeKeyId ||
    candidate.identityHmacKey !== current.identityHmacKey ||
    receipt.removedKeyIds.includes(current.activeKeyId) ||
    (await sha256Json(current)) !== receipt.sourceKeyringDigest ||
    (await sha256Json(candidate)) !== receipt.candidateKeyringDigest
  )
    throw new Error('Retirement candidate identity or material changed');
  const expected = {
    ...current,
    keys: current.keys.filter((k) => !receipt.removedKeyIds.includes(k.keyId)),
  };
  if (canonicalJson(expected) !== canonicalJson(candidate))
    throw new Error('Retained key material changed');
  return { valid: true as const, installed: false as const };
}
export async function applyAccountDataKeyRetirement(
  runtime: ApplicationRuntime,
  context: OfflineContext,
  backups: BackupInventory,
  input: AccountDataRetirementPlan,
) {
  const plan = DataPlan.parse(input);
  await validatePlan(plan, context);
  if (!runtime.coordinator) throw new Error('Offline coordinator required');
  return runtime.coordinator.withOffline(context, async () => {
    const previous = await q(
      runtime.base.db,
      'SELECT plan_hash,receipt_json FROM key_retirement_operations WHERE id=?',
      plan.operationId,
    ).first<{ plan_hash: string; receipt_json: string }>();
    if (previous) {
      if (
        previous.plan_hash !== plan.planHash ||
        (await q(
          runtime.base.db,
          'SELECT 1 FROM account_keys WHERE owner_id=? AND version=?',
          plan.ownerId,
          plan.keyVersion,
        ).first())
      )
        throw new Error('Retirement journal mismatch');
      await runtime.base.db.batch(offlineGuard(runtime, context));
      const receipt = DataReceipt.parse(JSON.parse(previous.receipt_json));
      if (
        receipt.operationId !== plan.operationId ||
        receipt.environmentId !== plan.environmentId ||
        receipt.coordinatorEpoch !== plan.coordinatorEpoch ||
        receipt.retiredVersion !== plan.keyVersion ||
        receipt.planHash !== plan.planHash ||
        receipt.inventoryDigest !== plan.inventoryDigest ||
        receipt.createdAt !== plan.createdAt
      )
        throw new Error('Retirement journal mismatch');
      return receipt;
    }
    const inventory = await inventoryKeyReferences(runtime, context, backups);
    sameReferences(plan, inventory);
    if (!(await planAccountDataKeyRetirement(inventory, plan.ownerId, plan.keyVersion)).allowed)
      throw new Error('Account key remains required');
    const keys = (
      await q(
        runtime.base.db,
        'SELECT k.*,(SELECT key_version FROM accounts WHERE id=k.owner_id) current_version FROM account_keys k WHERE owner_id=? AND (version=? OR version=(SELECT key_version FROM accounts WHERE id=?))',
        plan.ownerId,
        plan.keyVersion,
        plan.ownerId,
      ).all<{
        owner_id: string;
        version: number;
        wrap_key_id: string;
        wrapped_index_key_enc: string;
        current_version: number;
      }>()
    ).results;
    if (keys.length !== 2) throw new Error('Active and retired account keys required');
    const indices = await Promise.all(
      keys.map((k) =>
        runtime.identity.crypt.unwrapAccountKey(
          k.owner_id,
          k.wrapped_index_key_enc,
          'index',
          k.version,
        ),
      ),
    );
    if (!timingSafeEqual(indices[0]!, indices[1]!))
      throw new Error('Stable index key differs across versions');
    const receipt = DataReceipt.parse({
      version: 1,
      kind: 'account-data',
      operationId: plan.operationId,
      environmentId: plan.environmentId,
      coordinatorEpoch: plan.coordinatorEpoch,
      status: 'committed',
      retiredVersion: plan.keyVersion,
      planHash: plan.planHash,
      inventoryDigest: plan.inventoryDigest,
      createdAt: plan.createdAt,
      stillOffline: true,
    });
    await runtime.base.db.batch([
      ...offlineGuard(runtime, context),
      assertion(
        runtime.base.db,
        "EXISTS(SELECT 1 FROM accounts WHERE id=? AND status='active' AND key_version!=?)",
        plan.ownerId,
        plan.keyVersion,
      ),
      q(
        runtime.base.db,
        'DELETE FROM account_keys WHERE owner_id=? AND version=?',
        plan.ownerId,
        plan.keyVersion,
      ),
      assertion(runtime.base.db, 'changes()=1'),
      q(
        runtime.base.db,
        `INSERT INTO key_retirement_operations VALUES(?,?,?,'account-data',?,?,?,?,${DB_NOW})`,
        plan.operationId,
        plan.environmentId,
        context.epoch,
        plan.ownerId,
        plan.keyVersion,
        plan.planHash,
        canonicalJson(receipt),
      ),
    ]);
    return receipt;
  });
}

export function parseRetirementPlan(input: unknown) {
  return z.discriminatedUnion('kind', [EnvironmentPlan, DataPlan]).parse(input);
}
