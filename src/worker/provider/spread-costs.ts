import { ProviderReceipt } from '../../contracts/index.ts';
import { SPREAD_PROVIDER_POLICY as policy } from '../../contracts/spread-policy.ts';
import { canonicalJson, sha256Json } from '../../domain/json.ts';
import { statement as q, DB_NOW, DAY, MONTH } from '../db/core.ts';
import { assertion, onlineGuard } from '../identity/checkpoint.ts';

type SpreadCost = {
  id: string;
  state: string;
  receipt_hash: string | null;
  actual_microusd: number | null;
  reserved_microusd: number;
  provider_policy_hash: string | null;
  price_hash: string | null;
  price_basis_json: string;
  requested_model: string | null;
};

async function conflict(db: D1Database): Promise<never> {
  await db.batch([
    onlineGuard(db),
    q(
      db,
      `UPDATE system_state SET generation_enabled=0,revision=revision+1,updated_at=${DB_NOW} WHERE id=1`,
    ),
  ]);
  throw new Error('Spread cost receipt conflicts with settled usage');
}

/** Include in the same guarded batch as the durable recognition dispatch marker. */
export async function reserveSpreadCost(
  db: D1Database,
  owner: string,
  dispatchId: string,
  applicationPolicy: string,
) {
  return [
    q(
      db,
      `INSERT OR IGNORE INTO spend_buckets(period,ceiling_microusd) VALUES (${DAY},10000000),(${MONTH},100000000)`,
    ),
    q(
      db,
      `UPDATE spend_buckets SET committed_microusd=committed_microusd+? WHERE period IN (${DAY},${MONTH}) AND committed_microusd+?<=ceiling_microusd`,
      policy.reservationMicrousd,
      policy.reservationMicrousd,
    ),
    assertion(db, 'changes()=2'),
    // Unknown liability is retained even after timeout/cancellation; reading quota is separate.
    q(
      db,
      `INSERT INTO cost_reservations(id,owner_id,dispatch_id,day_period,month_period,state,reserved_microusd,price_basis_json,created_at,dispatch_hash,requested_model,application_policy_hash,provider_policy_hash,price_hash) VALUES (?,?,?,${DAY},${MONTH},'unknown',?,?,${DB_NOW},?,?,?,?,?)`,
      crypto.randomUUID(),
      owner,
      dispatchId,
      policy.reservationMicrousd,
      canonicalJson(policy.priceBasis),
      await sha256Json({ dispatchId }),
      policy.model,
      applicationPolicy,
      await sha256Json(policy),
      await sha256Json(policy.priceBasis),
    ),
  ];
}

/** Meta has automatic cache reads, with no separately billed cache-write category. */
export async function settleSpreadCost(
  db: D1Database,
  dispatchId: string,
  candidate: ProviderReceipt,
) {
  const parsed = ProviderReceipt.safeParse(candidate);
  if (!parsed.success) return;
  const receipt = parsed.data,
    u = receipt.usage,
    hash = await sha256Json({
      responseId: receipt.responseId,
      returnedModel: receipt.returnedModel,
      serviceTier: receipt.serviceTier,
      usage: receipt.usage,
    }),
    policyHash = await sha256Json(policy),
    priceHash = await sha256Json(policy.priceBasis);
  const row = await q(
    db,
    'SELECT * FROM cost_reservations WHERE dispatch_id=? OR dispatch_hash=?',
    dispatchId,
    await sha256Json({ dispatchId }),
  ).first<SpreadCost>();
  if (!row) return;
  if (row.state === 'actual') {
    if (row.receipt_hash === hash) return;
    return conflict(db);
  }
  if (
    receipt.returnedModel !== policy.model ||
    !policy.serviceTiers.some((tier) => tier === receipt.serviceTier) ||
    u.cacheWriteTokens !== 0 ||
    row.state !== 'unknown' ||
    row.provider_policy_hash !== policyHash ||
    row.price_hash !== priceHash ||
    row.requested_model !== policy.model ||
    row.price_basis_json !== canonicalJson(policy.priceBasis)
  )
    return;
  const p = policy.priceBasis;
  const total =
    BigInt(u.inputTokens - u.cachedInputTokens) * BigInt(p.inputMicrousdPerMillion) +
    BigInt(u.cachedInputTokens) * BigInt(p.cachedInputMicrousdPerMillion) +
    BigInt(u.outputTokens) * BigInt(p.outputMicrousdPerMillion);
  const rounded = (total + 999999n) / 1000000n;
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) return;
  const actual = Number(rounded);
  try {
    await db.batch([
      onlineGuard(db),
      q(
        db,
        `UPDATE cost_reservations SET state='actual',actual_microusd=?,settled_at=${DB_NOW},receipt_hash=?,returned_model=?,service_tier=?,input_tokens=?,cached_input_tokens=?,cache_write_tokens=0,output_tokens=?,reasoning_tokens=?,reconciled_policy_hash=? WHERE id=? AND state='unknown' AND receipt_hash IS NULL AND provider_policy_hash=? AND price_hash=?`,
        actual,
        hash,
        receipt.returnedModel,
        receipt.serviceTier,
        u.inputTokens,
        u.cachedInputTokens,
        u.outputTokens,
        u.reasoningTokens,
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
        `${row.id}:usage`,
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
    const current = await q(
      db,
      'SELECT * FROM cost_reservations WHERE id=?',
      row.id,
    ).first<SpreadCost>();
    if (current?.state === 'actual') {
      if (current.receipt_hash === hash && current.actual_microusd === actual) return;
      return conflict(db);
    }
    throw error;
  }
}
