import { expect, test } from 'vitest';
import {
  RecoveryResumeRequest,
  executeRecoveryResume,
  runRecoveryResume,
} from '../../scripts/recovery-resume.ts';

test('recovery resume is an explicit trusted-operator command with no inferred bindings', async () => {
  const help = await runRecoveryResume(['--help']);
  expect(help).toMatchObject({ scope: 'trusted-offline-operator', deploymentAllowed: false });
  await expect(runRecoveryResume([])).rejects.toThrow();
  expect(
    RecoveryResumeRequest.parse({
      version: 1,
      environmentId: 'synthetic-hosted',
      operationId: crypto.randomUUID(),
      epoch: 3,
      purpose: 'restore',
      sourceDigest: 'a'.repeat(64),
      configurationDigest: 'b'.repeat(64),
    }).purpose,
  ).toBe('restore');
});

test('recovery resume refuses a context that does not match the request', async () => {
  const operationId = crypto.randomUUID();
  await expect(
    executeRecoveryResume(
      {
        runtime: { environmentId: 'other-environment' },
        context: {
          environmentId: 'other-environment',
          operationId,
          epoch: 1,
          purpose: 'restore',
        },
        backups: {},
        bucket: {},
        signingKey: {},
      } as never,
      {
        version: 1,
        environmentId: 'synthetic-hosted',
        operationId,
        epoch: 1,
        purpose: 'restore',
        sourceDigest: 'a'.repeat(64),
        configurationDigest: 'b'.repeat(64),
      },
    ),
  ).rejects.toThrow('Wrong recovery environment or operation');
});
