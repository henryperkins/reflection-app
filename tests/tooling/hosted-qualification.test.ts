import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import {
  authorizeHostedTarget,
  runHostedQualification,
  scenarioAssertions,
} from '../../scripts/hosted-qualify.ts';
import { hostedConfigurationDigest } from '../../scripts/hosted-release.ts';
import { verificationStageNames } from '../../scripts/verify.ts';
import { runtimeManifest } from '../fixtures/runtime.ts';

function fixture() {
  const runtime = runtimeManifest(),
    target = {
      version: 1,
      accountId: 'a'.repeat(32),
      isolatedAccounts: [
        { environmentId: runtime.isolatedFrom[0]!.environmentId, accountId: 'b'.repeat(32) },
      ],
      runtime,
    },
    hash = 'c'.repeat(64),
    configurationDigest = hostedConfigurationDigest(target);
  const candidate = {
    target,
    sourceDigest: hash,
    artifactDigest: 'd'.repeat(64),
    configurationDigest,
    context: { commit: 'e'.repeat(40), branch: 'main' },
    verification: {
      version: 1,
      status: 'passed',
      sourceDigest: hash,
      node: 'v26.12.1',
      finishedAt: new Date().toISOString(),
      durationMs: 1,
      deadlineMs: 540000,
      stages: verificationStageNames.map((name) => ({ name, status: 'passed', durationMs: 0 })),
      scope: 'synthetic-local-only',
      hostedQualification: 'not-run',
    },
  };
  const authorization = {
    version: 1,
    accountId: target.accountId,
    environmentId: runtime.environmentId,
    applicationDigest: hash,
    artifactDigest: candidate.artifactDigest,
    configurationDigest,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    allowedScenarios: ['batch-rollback'],
    acceptedRpoMs: 1000,
    acceptedRtoMs: 1000,
  };
  const bytes = new TextEncoder().encode('PRIVATE_FAULT_PROOF /recovery?cap=PRIVATE_SENTINEL'),
    evidenceSha256 = createHash('sha256').update(bytes).digest('hex');
  const observation = {
    version: 1,
    scope: 'hosted-synthetic',
    scenario: 'batch-rollback',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    assertions: ['ROLLBACK_READING', 'ROLLBACK_EVIDENCE', 'ROLLBACK_QUOTA', 'ROLLBACK_EVENTS'].map(
      (code) => ({ code, passed: true, evidenceSha256 }),
    ),
    limitations: ['SYNTHETIC_PROVIDER_ONLY'],
    measuredRpoMs: null,
    measuredRtoMs: null,
    backupClasses: [],
  };
  const adapter = {
    inspect: async () => ({
      accountId: target.accountId,
      environmentId: runtime.environmentId,
      resources: runtime.resources,
      applicationDigest: hash,
      artifactDigest: candidate.artifactDigest,
      configurationDigest,
      provider: 'intercepted-counter',
      productionCredentialsPresent: false,
    }),
    run: async () => observation,
    readEvidence: async () => bytes,
  };
  return { candidate, authorization, adapter, observation };
}

test('the private runner binds actual adapter observations and evidence bytes to the allowed synthetic candidate', async () => {
  const f = fixture(),
    target = await authorizeHostedTarget(f.candidate, f.authorization, f.adapter);
  const receipt = await runHostedQualification(target, 'batch-rollback');
  expect(receipt).toMatchObject({
    status: 'passed',
    scope: 'hosted-synthetic',
    productionActivationAllowed: false,
  });
  expect(receipt.assertions.map((a) => a.code)).toEqual(scenarioAssertions['batch-rollback']);
  expect(JSON.stringify(receipt)).not.toMatch(/PRIVATE_|cap=|recovery\?/);
});
test.each(['production', 'missing-authorization', 'resource', 'expired', 'artifact'] as const)(
  'refuses %s before running any drill',
  async (fault) => {
    const f = fixture();
    let ran = false;
    f.adapter.run = async () => {
      ran = true;
      return f.observation;
    };
    if (fault === 'production') f.candidate.target.runtime.mode = 'production';
    if (fault === 'resource')
      f.adapter.inspect = async () => ({
        ...(await fixture().adapter.inspect()),
        resources: {
          ...f.candidate.target.runtime.resources,
          databaseId: '99999999-9999-4999-8999-999999999999',
        },
      });
    if (fault === 'expired') f.authorization.expiresAt = new Date(0).toISOString();
    if (fault === 'artifact') f.authorization.artifactDigest = 'f'.repeat(64);
    await expect(
      authorizeHostedTarget(
        f.candidate,
        fault === 'missing-authorization' ? null : f.authorization,
        f.adapter,
      ),
    ).rejects.toThrow();
    expect(ran).toBe(false);
  },
);
test.each(['incomplete', 'evidence', 'drift', 'fabricated', 'scenario'] as const)(
  'refuses %s evidence and capabilities',
  async (fault) => {
    const f = fixture(),
      target = await authorizeHostedTarget(f.candidate, f.authorization, f.adapter);
    if (fault === 'incomplete') f.observation.assertions.pop();
    if (fault === 'evidence') f.adapter.readEvidence = async () => new Uint8Array([1]);
    if (fault === 'drift')
      f.adapter.inspect = async () => ({
        ...(await fixture().adapter.inspect()),
        applicationDigest: 'f'.repeat(64),
      });
    await expect(
      runHostedQualification(
        fault === 'fabricated' ? ({ environmentId: 'invented' } as typeof target) : target,
        fault === 'scenario' ? 'request-races' : 'batch-rollback',
      ),
    ).rejects.toThrow();
  },
);
