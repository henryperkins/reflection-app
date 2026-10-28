import type { ApplicationRuntime } from '../runtime/application.ts';
import { SessionErasure } from '../readings/erasure.ts';
import { RetentionMaintenance } from './retention.ts';
import { maintenanceHealth } from './health.ts';

export type MaintenanceSummary = Awaited<ReturnType<typeof runMaintenance>>;
/** Every service is bounded; no abandoned promises can outlive the coordinator registration. */
export async function runMaintenance(
  runtime: ApplicationRuntime,
  budget: { deadlineMs: number; concurrency: 4 },
) {
  if (
    !Number.isFinite(budget.deadlineMs) ||
    budget.deadlineMs <= Date.now() ||
    budget.deadlineMs - Date.now() > 300000 ||
    budget.concurrency !== 4
  )
    throw new Error('Invalid maintenance budget');
  const started = Date.now(),
    services: string[] = [];
  const work = { identity: 0, erasure: 0, retention: 0, generation: { attempted: 0 } };
  // Safety queues run before inference on every wake, including after missed wakes.
  const identityDeadline = Math.min(budget.deadlineMs, Date.now() + 10000);
  await runtime.identity.maintenance(identityDeadline);
  services.push('identity');
  work.identity++;
  if (Date.now() < budget.deadlineMs) {
    await new SessionErasure(runtime.base, runtime.recoveryBucket).maintenance(
      Math.min(budget.deadlineMs, Date.now() + 10000),
    );
    services.push('erasure');
    work.erasure++;
  }
  if (Date.now() < budget.deadlineMs) {
    await new RetentionMaintenance(runtime.base.db).run(
      Math.min(budget.deadlineMs, Date.now() + 10000),
    );
    services.push('retention');
    work.retention++;
  }
  if (Date.now() < budget.deadlineMs) {
    work.generation = await runtime.generation.maintenance(budget);
    services.push('generation');
  }
  return {
    ...(await maintenanceHealth(runtime.base.db)),
    completedAt: Date.now(),
    durationMs: Date.now() - started,
    services,
    work,
  };
}
