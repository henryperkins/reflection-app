import type { HostedCoordinator, OfflineContext } from './hosted-coordinator.ts';
/** One trusted local runner only; this is not a distributed production lock. */
export type RecoveryLease = symbol | { coordinator: HostedCoordinator; context: OfflineContext };
const environments = new Map<string, { writers: number; exclusive: RecoveryLease | null }>();
function state(environment: string) {
  let value = environments.get(environment);
  if (!value) {
    value = { writers: 0, exclusive: null };
    environments.set(environment, value);
  }
  return value;
}
export async function recoveryWrite<T>(
  environment: string,
  work: () => Promise<T>,
  lease?: RecoveryLease,
): Promise<T> {
  if (lease && typeof lease === 'object') {
    if (lease.context.environmentId !== environment) throw new Error('Wrong recovery environment');
    return lease.coordinator.withOffline(lease.context, work);
  }
  const current = state(environment);
  if (current.exclusive !== null && current.exclusive !== lease)
    throw new Error('Offline recovery operation is running');
  current.writers++;
  try {
    return await work();
  } finally {
    current.writers--;
  }
}
export async function recoveryExclusive<T>(
  environment: string,
  work: (lease: RecoveryLease) => Promise<T>,
): Promise<T> {
  const current = state(environment);
  if (current.exclusive !== null || current.writers !== 0)
    throw new Error('Recovery writer or offline operation is already running');
  const lease = Symbol('local recovery operator');
  current.exclusive = lease;
  try {
    return await work(lease);
  } finally {
    current.exclusive = null;
  }
}
