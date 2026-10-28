import { expect, test } from 'vitest';
import {
  summarizeKeyInventory,
  type KeyReferenceInventory,
} from '../../src/worker/recovery/key-inventory.ts';

test('public inventory summaries contain counts and digests while private identities stay in the protected record', () => {
  const value = {
    version: 1,
    environmentId: 'PRIVATE_ENVIRONMENT',
    coordinatorEpoch: 1,
    registryHash: 'a'.repeat(64),
    manifestDigest: 'b'.repeat(64),
    referenceDigest: 'c'.repeat(64),
    observedAt: new Date().toISOString(),
    referencedKeyIds: ['PRIVATE_KEY_ID'],
    accountKeys: [
      {
        ownerId: 'PRIVATE_OWNER_ID',
        version: 1,
        wrapKeyId: 'PRIVATE_WRAP_ID',
        active: true,
        liveFields: 1,
        operationalReferences: 1,
        unfinishedJob: false,
        backupRequired: false,
      },
    ],
    counts: {
      wraps: 1,
      fields: 1,
      checkpoints: 1,
      securityOperations: 1,
      erasureChains: 0,
      backups: 1,
      unfinishedRekeys: 0,
    },
    complete: true,
    digest: 'd'.repeat(64),
    limitations: ['PRIVATE_OPERATIONAL_DETAIL'],
  } as KeyReferenceInventory;
  const summary = summarizeKeyInventory(value);
  expect(summary).toMatchObject({ complete: true, digest: 'd'.repeat(64), counts: { fields: 1 } });
  expect(JSON.stringify(summary)).not.toContain('PRIVATE_');
});
