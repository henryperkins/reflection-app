import { encode } from '../../src/worker/identity/crypto.ts';

export function runtimeManifest(
  mode: 'synthetic-local' | 'hosted-synthetic' | 'production' = 'hosted-synthetic',
) {
  return {
    version: 1 as const,
    mode,
    environmentId: mode === 'synthetic-local' ? 'synthetic-local' : 'qualification-test',
    workerName: 'reflection-qualification-test',
    origin:
      mode === 'synthetic-local' ? 'http://localhost:8787' : 'https://qualification.example.test',
    rpId: mode === 'synthetic-local' ? 'localhost' : 'qualification.example.test',
    resources: {
      databaseId: '11111111-1111-4111-8111-111111111111',
      recoveryBucket: 'qualification-test-recovery',
      coordinatorId: 'qualification-test-control',
      backupInventoryBucket: 'qualification-test-backups',
      qualificationBucket: 'qualification-test-evidence',
    },
    isolatedFrom: [
      {
        environmentId: 'reserved-preview',
        databaseId: '22222222-2222-4222-8222-222222222222',
        recoveryBucket: 'reserved-preview-recovery',
        coordinatorId: 'reserved-preview-control',
        backupInventoryBucket: 'reserved-preview-backups',
        qualificationBucket: 'reserved-preview-evidence',
      },
    ],
    generation: 'off' as 'off' | 'intercepted' | 'qualified',
    ingress: 'off' as 'off' | 'on',
    policyHash: 'a'.repeat(64),
    contentHash: 'b'.repeat(64),
    qualificationEvidenceDigest: null as string | null,
  };
}

export function runtimeSecrets(environment: string) {
  return {
    environment,
    keyId: 'qualification-test-only',
    wrapKey: encode(crypto.getRandomValues(new Uint8Array(32))),
    recoveryKey: encode(crypto.getRandomValues(new Uint8Array(32))),
    hmacKey: encode(crypto.getRandomValues(new Uint8Array(32))),
  };
}
