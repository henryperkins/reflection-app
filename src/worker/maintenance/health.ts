import { DB_NOW } from '../db/core.ts';

/** Operator-only aggregate telemetry. No question, identifier, ciphertext or provider response is selected. */
export async function maintenanceHealth(db: D1Database) {
  const results = await db.batch<{ n: number; age: number; amount: number }>([
    db.prepare(
      `SELECT count(*) n,coalesce(max(${DB_NOW}-created_at),0) age FROM generation_requests WHERE state NOT IN ('published','cancelled','expired','blocked','failed')`,
    ),
    db.prepare(
      `SELECT count(*) n,coalesce(max(${DB_NOW}-created_at),0) age FROM security_operations WHERE state!='applied'`,
    ),
    db.prepare(
      `SELECT count(*) n,coalesce(max(${DB_NOW}-created_at),0) age FROM deletion_jobs WHERE state!='complete'`,
    ),
    db.prepare(
      "SELECT count(*) n,coalesce(sum(reserved_microusd),0) amount FROM cost_reservations WHERE state='unknown'",
    ),
    db.prepare(
      "SELECT committed_microusd amount FROM spend_buckets WHERE period='day:'||strftime('%Y-%m-%d','now')",
    ),
    db.prepare(
      "SELECT committed_microusd amount FROM spend_buckets WHERE period='month:'||strftime('%Y-%m','now')",
    ),
  ]);
  if (results.some((result) => !result.success))
    throw new Error('Maintenance counters unavailable');
  const generation = results[0]!.results[0]!;
  const security = results[1]!.results[0]!;
  const erasure = results[2]!.results[0]!;
  const liability = results[3]!.results[0]!;
  const dailySpendMicrousd = results[4]!.results[0]?.amount ?? 0;
  const monthlySpendMicrousd = results[5]!.results[0]?.amount ?? 0;
  const alerts: string[] = [];
  if (generation.n >= 100 || generation.age > 60_000) alerts.push('GENERATION_BACKLOG');
  if (security.age > 300_000) alerts.push('SECURITY_LAG');
  if (erasure.age > 86_400_000) alerts.push('ERASURE_LAG');
  if (liability.n) alerts.push('PROVIDER_COST_UNKNOWN');
  if (dailySpendMicrousd >= 10_000_000 || monthlySpendMicrousd >= 100_000_000)
    alerts.push('SPEND_LIMIT');
  return {
    event: 'maintenance_health',
    pendingGeneration: generation.n,
    oldestGenerationMs: generation.age,
    pendingSecurity: security.n,
    oldestSecurityMs: security.age,
    pendingErasure: erasure.n,
    oldestErasureMs: erasure.age,
    unknownProviderCosts: liability.n,
    unknownLiabilityMicrousd: liability.amount,
    dailySpendMicrousd,
    monthlySpendMicrousd,
    alerts,
  } as const;
}
