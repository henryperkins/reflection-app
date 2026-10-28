import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const OperationalCode = z.enum([
  'HEARTBEAT_MISSING',
  'MAINTENANCE_FAILED',
  'GENERATION_BACKLOG',
  'SECURITY_LAG',
  'ERASURE_LAG',
  'PROVIDER_COST_UNKNOWN',
  'PROVIDER_COST_OVERRUN',
  'SPEND_LIMIT',
]);
const Summary = z.strictObject({
  event: z.literal('maintenance_health'),
  completedAt: count,
  durationMs: count,
  pendingGeneration: count,
  oldestGenerationMs: count,
  pendingSecurity: count,
  oldestSecurityMs: count,
  pendingErasure: count,
  oldestErasureMs: count,
  unknownProviderCosts: count,
  unknownLiabilityMicrousd: count,
  dailySpendMicrousd: count,
  monthlySpendMicrousd: count,
  dailyLimitMicrousd: count.nullable(),
  monthlyLimitMicrousd: count.nullable(),
  alerts: z.array(OperationalCode).max(8),
  services: z.array(z.enum(['identity', 'erasure', 'retention', 'generation'])).max(4),
  work: z.strictObject({
    identity: count,
    erasure: count,
    retention: count,
    generation: z.strictObject({ attempted: count }),
  }),
});
export function checkHeartbeat(
  lastCompletedAt: number | null,
  now: number,
  expectedIntervalMs: 60000,
): 'healthy' | 'missing' {
  count.parse(now);
  if (lastCompletedAt !== null) count.parse(lastCompletedAt);
  if (expectedIntervalMs !== 60000 || (lastCompletedAt !== null && lastCompletedAt > now))
    throw new Error('Invalid independent heartbeat clock');
  return lastCompletedAt === null || now - lastCompletedAt >= 3 * expectedIntervalMs
    ? 'missing'
    : 'healthy';
}
export function checkMonitoring(input: unknown) {
  const value = z
    .strictObject({
      now: count,
      lastCompletedAt: count.nullable(),
      summary: z
        .union([Summary, z.strictObject({ event: z.literal('maintenance_failed') })])
        .nullable(),
    })
    .parse(input);
  const codes = new Set<z.infer<typeof OperationalCode>>();
  if (checkHeartbeat(value.lastCompletedAt, value.now, 60000) === 'missing')
    codes.add('HEARTBEAT_MISSING');
  if (value.summary?.event === 'maintenance_failed') codes.add('MAINTENANCE_FAILED');
  if (value.summary?.event === 'maintenance_health') {
    const s = value.summary;
    if (s.completedAt !== value.lastCompletedAt) throw new Error('Heartbeat completion mismatch');
    if (s.pendingGeneration >= 100 || s.oldestGenerationMs > 60000) codes.add('GENERATION_BACKLOG');
    if (s.oldestSecurityMs > 300000) codes.add('SECURITY_LAG');
    if (s.oldestErasureMs > 86400000) codes.add('ERASURE_LAG');
    if (s.unknownProviderCosts > 0) codes.add('PROVIDER_COST_UNKNOWN');
    if (s.alerts.includes('PROVIDER_COST_OVERRUN')) codes.add('PROVIDER_COST_OVERRUN');
    if (
      (s.dailyLimitMicrousd !== null && s.dailySpendMicrousd >= s.dailyLimitMicrousd) ||
      (s.monthlyLimitMicrousd !== null && s.monthlySpendMicrousd >= s.monthlyLimitMicrousd)
    )
      codes.add('SPEND_LIMIT');
  }
  return {
    event: 'reflection_operational_signal',
    observedAt: value.now,
    status: codes.size ? ('attention' as const) : ('healthy' as const),
    codes: [...codes],
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [flag, file, extra] = process.argv.slice(2);
    if (
      flag !== '--dry-run' ||
      !file ||
      extra ||
      !statSync(file).isFile() ||
      statSync(file).size > 32768
    )
      throw new Error('Bounded aggregate sample required');
    console.log(
      JSON.stringify({
        ...checkMonitoring(JSON.parse(readFileSync(file, 'utf8'))),
        delivery: 'not-sent',
      }),
    );
  } catch {
    console.error(
      'Monitoring check rejected invalid aggregate input; no private values were displayed or notification sent.',
    );
    process.exitCode = 1;
  }
}
