import { expect, test } from 'vitest';
import { checkHeartbeat, checkMonitoring } from '../../scripts/monitoring-check.ts';

const now = 1000000;
function summary() {
  return {
    event: 'maintenance_health',
    completedAt: now,
    durationMs: 20,
    pendingGeneration: 0,
    oldestGenerationMs: 0,
    pendingSecurity: 0,
    oldestSecurityMs: 0,
    pendingErasure: 0,
    oldestErasureMs: 0,
    unknownProviderCosts: 0,
    unknownLiabilityMicrousd: 0,
    dailySpendMicrousd: 0,
    monthlySpendMicrousd: 0,
    dailyLimitMicrousd: 10,
    monthlyLimitMicrousd: 100,
    alerts: [],
    services: ['identity', 'erasure', 'retention', 'generation'],
    work: { identity: 1, erasure: 1, retention: 1, generation: { attempted: 0 } },
  };
}
test('an independent clock detects three missed completed heartbeats', () => {
  expect(checkHeartbeat(now, now + 179999, 60000)).toBe('healthy');
  expect(checkHeartbeat(now, now + 180000, 60000)).toBe('missing');
  expect(checkHeartbeat(null, now, 60000)).toBe('missing');
  expect(() => checkHeartbeat(now + 1, now, 60000)).toThrow();
});
test('only content-free fixed signals leave the independent monitor', () => {
  const s = summary();
  Object.assign(s, {
    oldestSecurityMs: 300001,
    oldestErasureMs: 86400001,
    pendingGeneration: 100,
    oldestGenerationMs: 60001,
    unknownProviderCosts: 1,
    unknownLiabilityMicrousd: 4,
    dailySpendMicrousd: 10,
  });
  expect(checkMonitoring({ now, lastCompletedAt: now, summary: s })).toMatchObject({
    status: 'attention',
    codes: [
      'GENERATION_BACKLOG',
      'SECURITY_LAG',
      'ERASURE_LAG',
      'PROVIDER_COST_UNKNOWN',
      'SPEND_LIMIT',
    ],
  });
  expect(checkMonitoring({ now: now + 180000, lastCompletedAt: now, summary: s }).codes).toContain(
    'HEARTBEAT_MISSING',
  );
  expect(checkMonitoring({ now, lastCompletedAt: now, summary: summary() })).toMatchObject({
    status: 'healthy',
    codes: [],
  });
});
test.each(['url', 'secret', 'exception', 'userId'] as const)(
  'rejects unreviewed %s telemetry fields',
  (field) => {
    expect(() =>
      checkMonitoring({
        now,
        lastCompletedAt: now,
        summary: { ...summary(), [field]: 'PRIVATE_MARKER https://x.invalid/?cap=secret' },
      }),
    ).toThrow();
  },
);

test('failure does not advance completion and mismatched heartbeat timestamps fail', () => {
  expect(
    checkMonitoring({
      now,
      lastCompletedAt: now - 180000,
      summary: { event: 'maintenance_failed' },
    }),
  ).toMatchObject({ status: 'attention', codes: ['HEARTBEAT_MISSING', 'MAINTENANCE_FAILED'] });
  expect(() => checkMonitoring({ now, lastCompletedAt: now - 1, summary: summary() })).toThrow();
});
