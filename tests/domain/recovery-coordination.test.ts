import { expect, test } from 'vitest';
import { recoveryWrite, recoveryExclusive } from '../../src/worker/recovery/coordination.ts';
test('a fabricated local lease cannot authorize recovery mutations', async () => {
  await expect(
    recoveryWrite('local-' + crypto.randomUUID(), async () => 42, Symbol('unowned')),
  ).rejects.toThrow();
});
test('a local lease authorizes only work inside its owning exclusive operation', async () => {
  const environment = 'local-' + crypto.randomUUID();
  let captured: symbol | undefined;
  expect(
    await recoveryExclusive(environment, async (lease) => {
      if (typeof lease !== 'symbol') throw new Error('Local symbol required');
      captured = lease;
      return recoveryWrite(environment, async () => 42, lease);
    }),
  ).toBe(42);
  await expect(recoveryWrite(environment, async () => 42, captured)).rejects.toThrow();
});
