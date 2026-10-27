import { ProviderReceipt } from '../../contracts/index.ts';
import type { ReadingProviderPolicy } from '../../contracts/provider-policy.ts';
import { canonicalJson, sha256Json } from '../../domain/json.ts';
import { providerPolicyHash } from '../../domain/provider-policy.ts';
import { priceReceipt } from '../../domain/provider-cost.ts';
import { statement as q, DB_NOW, DAY, MONTH } from '../db/core.ts';
import { assertion, onlineGuard } from '../identity/checkpoint.ts';

export async function costReservationStatement(
  db: D1Database,
  input: {
    id: string;
    ownerId: string;
    dispatchId: string;
    applicationPolicyHash: string;
    policy: ReadingProviderPolicy;
  },
): Promise<D1PreparedStatement> {
  const { policy } = input;
  return q(
    db,
    `INSERT INTO cost_reservations(id,owner_id,dispatch_id,day_period,month_period,state,reserved_microusd,price_basis_json,created_at,dispatch_hash,requested_model,application_policy_hash,provider_policy_hash,price_hash) VALUES (?,?,?,${DAY},${MONTH},'reserved',?,?,${DB_NOW},?,?,?,?,?)`,
    input.id,
    input.ownerId,
    input.dispatchId,
    policy.reservationMicrousd,
    canonicalJson(policy.priceBasis),
    await sha256Json({ dispatchId: input.dispatchId }),
    policy.model,
    input.applicationPolicyHash,
    await providerPolicyHash(policy),
    await sha256Json(policy.priceBasis),
  );
}
type Cost = {
  id: string;
  state: string;
  reserved_microusd: number;
  actual_microusd: number | null;
  provider_policy_hash: string | null;
  price_hash: string | null;
  requested_model: string | null;
  price_basis_json: string;
  receipt_hash: string | null;
  owner_id: string | null;
};
type Result = { state: 'actual' | 'unknown'; actualMicrousd: number | null };
const result = (row: Cost): Result =>
  row.state === 'actual'
    ? { state: 'actual', actualMicrousd: row.actual_microusd }
    : { state: 'unknown', actualMicrousd: null };
async function conflict(db: D1Database): Promise<never> {
  await db.batch([
    onlineGuard(db),
    q(
      db,
      `UPDATE system_state SET generation_enabled=0,revision=revision+1,updated_at=${DB_NOW} WHERE id=1`,
    ),
  ]);
  throw new Error('Provider cost receipt conflicts with settled usage');
}
async function unknown(db: D1Database, row: Cost, receiptHash: string | null): Promise<Result> {
  if (row.state === 'actual') return result(row);
  await db.batch([
    onlineGuard(db),
    q(
      db,
      `UPDATE cost_reservations SET state='unknown',settled_at=${DB_NOW} WHERE id=? AND state='reserved'`,
      row.id,
    ),
    q(
      db,
      'UPDATE accounts SET data_revision=data_revision+1 WHERE id=? AND changes()=1',
      row.owner_id,
    ),
  ]);
  const current = await q(db, 'SELECT * FROM cost_reservations WHERE id=?', row.id).first<Cost>();
  if (
    current?.state === 'actual' &&
    current.receipt_hash &&
    receiptHash &&
    current.receipt_hash !== receiptHash
  )
    return conflict(db);
  return current ? result(current) : { state: 'unknown', actualMicrousd: null };
}

/** Trusted transport/operator input only. There is no HTTP reconciliation endpoint. */
export async function reconcileProviderCost(
  db: D1Database,
  input: {
    dispatchId: string;
    receiptId: string;
    receipt: ProviderReceipt | null;
    policy: ReadingProviderPolicy;
  },
): Promise<Result> {
  if (
    !/^[A-Za-z0-9._:-]{1,128}$/.test(input.receiptId) ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(input.dispatchId)
  )
    throw new Error('Invalid cost receipt identity');
  const dispatchHash = await sha256Json({ dispatchId: input.dispatchId });
  const row = await q(
    db,
    'SELECT * FROM cost_reservations WHERE dispatch_id=? OR dispatch_hash=?',
    input.dispatchId,
    dispatchHash,
  ).first<Cost>();
  if (!row) return { state: 'unknown', actualMicrousd: null };
  const parsed = ProviderReceipt.safeParse(input.receipt),
    policyHash = await providerPolicyHash(input.policy),
    priceHash = await sha256Json(input.policy.priceBasis);
  // Receipt identity conflicts matter even when the new model/tier cannot be priced.
  const receiptHash = parsed.success
    ? await sha256Json({
        responseId: parsed.data.responseId,
        returnedModel: parsed.data.returnedModel,
        serviceTier: parsed.data.serviceTier,
        usage: parsed.data.usage,
      })
    : null;
  if (row.state === 'actual' && row.receipt_hash && receiptHash && row.receipt_hash !== receiptHash)
    return conflict(db);
  const priced = parsed.success ? priceReceipt(parsed.data, input.policy) : null;
  if (
    !priced ||
    row.provider_policy_hash !== policyHash ||
    row.price_hash !== priceHash ||
    row.requested_model !== input.policy.model ||
    row.price_basis_json !== canonicalJson(input.policy.priceBasis)
  )
    return unknown(db, row, receiptHash);
  const receipt = parsed.data!;
  if (row.state === 'actual') {
    if (row.receipt_hash === receiptHash && row.actual_microusd === priced.actualMicrousd)
      return result(row);
    return conflict(db);
  }
  const { usage } = receipt,
    actual = priced.actualMicrousd;
  try {
    await db.batch([
      onlineGuard(db),
      q(
        db,
        `UPDATE cost_reservations SET state='actual',actual_microusd=?,settled_at=${DB_NOW},receipt_id=?,receipt_hash=?,returned_model=?,service_tier=?,input_tokens=?,cached_input_tokens=?,cache_write_tokens=?,output_tokens=?,reasoning_tokens=?,reconciled_policy_hash=? WHERE id=? AND state IN ('reserved','unknown') AND receipt_hash IS NULL AND provider_policy_hash=? AND price_hash=?`,
        actual,
        input.receiptId,
        receiptHash,
        receipt.returnedModel,
        receipt.serviceTier,
        usage.inputTokens,
        usage.cachedInputTokens,
        usage.cacheWriteTokens,
        usage.outputTokens,
        usage.reasoningTokens,
        policyHash,
        row.id,
        policyHash,
        priceHash,
      ),
      assertion(db, 'changes()=1'),
      q(
        db,
        'UPDATE spend_buckets SET committed_microusd=committed_microusd+? WHERE period IN (SELECT day_period FROM cost_reservations WHERE id=? UNION SELECT month_period FROM cost_reservations WHERE id=?)',
        actual - row.reserved_microusd,
        row.id,
        row.id,
      ),
      assertion(db, 'changes()=2'),
      q(
        db,
        `INSERT INTO cost_adjustments VALUES (?,?,?,?,'usage',${DB_NOW})`,
        `${row.id}:${input.receiptId}`,
        row.id,
        row.reserved_microusd,
        actual,
      ),
      q(
        db,
        'UPDATE accounts SET data_revision=data_revision+1 WHERE id=(SELECT owner_id FROM cost_reservations WHERE id=?)',
        row.id,
      ),
      q(
        db,
        `UPDATE system_state SET generation_enabled=0,revision=revision+1,updated_at=${DB_NOW} WHERE id=1 AND (? > ? OR EXISTS(SELECT 1 FROM spend_buckets WHERE committed_microusd>=ceiling_microusd))`,
        actual,
        row.reserved_microusd,
      ),
    ]);
  } catch (error) {
    const current = await q(db, 'SELECT * FROM cost_reservations WHERE id=?', row.id).first<Cost>();
    if (
      current?.state === 'actual' &&
      current.receipt_hash === receiptHash &&
      current.actual_microusd === actual
    )
      return result(current);
    if (current?.state === 'actual') return conflict(db);
    throw error;
  }
  return { state: 'actual', actualMicrousd: actual };
}
