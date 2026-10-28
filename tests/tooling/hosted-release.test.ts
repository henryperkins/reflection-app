import { expect, test } from 'vitest';
import {
  checkHostedCandidate,
  hostedConfigurationDigest,
  verifyWorkersBuildContext,
} from '../../scripts/hosted-release.ts';
import { runtimeManifest } from '../fixtures/runtime.ts';
import { verificationStageNames } from '../../scripts/verify.ts';
const sha = 'a'.repeat(40),
  hash = 'b'.repeat(64);
function fixture(mode: 'hosted-synthetic' | 'production' = 'hosted-synthetic') {
  const runtime = runtimeManifest(mode),
    target = {
      version: 1 as const,
      accountId: 'a'.repeat(32),
      isolatedAccounts: [
        { environmentId: runtime.isolatedFrom[0]!.environmentId, accountId: 'b'.repeat(32) },
      ],
      runtime,
    };
  const verification = {
    version: 1,
    status: 'passed',
    sourceDigest: hash,
    node: 'v26.12.1',
    finishedAt: new Date().toISOString(),
    durationMs: 100,
    deadlineMs: 540000,
    stages: verificationStageNames.map((name) => ({ name, status: 'passed', durationMs: 1 })),
    scope: 'synthetic-local-only',
    applicationBrowserAcceptance: 'local-identity-and-saved-reading-only',
    hostedQualification: 'not-run',
  };
  return {
    target,
    verification,
    input: {
      trustedBranch: 'main',
      commit: sha,
      applicationDigest: hash,
      environmentManifest: runtime,
      target,
      verification,
      artifactDigest: 'c'.repeat(64),
      expectedArtifactDigest: 'c'.repeat(64),
      configurationDigest: hostedConfigurationDigest(target),
    },
  };
}
test('a complete local gate permits only the isolated synthetic qualification artifact', () => {
  const f = fixture();
  expect(checkHostedCandidate(f.input)).toMatchObject({
    syntheticQualificationAllowed: true,
    productionActivationAllowed: false,
  });
});
test.each(['stale', 'failed', 'partial', 'artifact', 'config', 'account', 'resources'] as const)(
  'hosted gate rejects %s input',
  (failure) => {
    const f = fixture();
    if (failure === 'stale') f.verification.sourceDigest = 'd'.repeat(64);
    if (failure === 'failed') f.verification.status = 'failed';
    if (failure === 'partial') f.verification.stages.pop();
    if (failure === 'artifact') f.input.expectedArtifactDigest = 'd'.repeat(64);
    if (failure === 'config') f.input.configurationDigest = 'd'.repeat(64);
    if (failure === 'account') f.target.isolatedAccounts[0]!.accountId = f.target.accountId;
    if (failure === 'resources')
      f.target.runtime.resources.recoveryBucket = f.target.runtime.isolatedFrom[0]!.recoveryBucket;
    expect(() => checkHostedCandidate(f.input)).toThrow();
  },
);
test('non-main production and synthetic receipt promotion never grant production activation', () => {
  const f = fixture('production');
  f.input.trustedBranch = 'codex/unsafe';
  expect(() => checkHostedCandidate(f.input)).toThrow();
  f.input.trustedBranch = 'main';
  expect(checkHostedCandidate(f.input)).toMatchObject({
    productionActivationAllowed: false,
    syntheticQualificationAllowed: false,
  });
});
test('authenticated Workers Builds metadata must match the local checkout, target and protected command', () => {
  const f = fixture(),
    build = {
      build_uuid: '11111111-1111-4111-8111-111111111111',
      status: 'running',
      build_trigger_metadata: {
        branch: 'main',
        commit_hash: sha,
        build_command: 'npm run hosted:build',
        deploy_command: 'npm run hosted:stage-synthetic',
      },
      trigger: { branch_includes: ['main'] },
    };
  expect(
    verifyWorkersBuildContext(build, {
      buildId: build.build_uuid,
      commit: sha,
      branch: 'main',
      mode: 'hosted-synthetic',
    }),
  ).toMatchObject({ branch: 'main', commit: sha });
  for (const change of [{ commit: 'f'.repeat(40) }, { branch: 'codex/spoof' }])
    expect(() =>
      verifyWorkersBuildContext(build, {
        buildId: build.build_uuid,
        commit: sha,
        branch: 'main',
        mode: f.target.runtime.mode,
        ...change,
      }),
    ).toThrow();
});
