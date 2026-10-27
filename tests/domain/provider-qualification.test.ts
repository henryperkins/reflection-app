import { expect, test } from 'vitest';
import {
  authenticateProviderQualification,
  verifyProviderQualification,
} from '../../src/worker/provider/qualification.ts';
import { qualificationFixture } from '../fixtures/provider.ts';

test('only a signature and matching evidence bytes create an immutable runtime qualification', async () => {
  const f = await qualificationFixture();
  const artifact = await authenticateProviderQualification(f.signed, f.options);
  expect(verifyProviderQualification(artifact, f.expected)).toBe(artifact);
  expect(Object.isFrozen(artifact)).toBe(true);
  expect(Object.isFrozen(artifact.evidence)).toBe(true);
  for (const untrusted of [
    f.signed.document,
    f.signed,
    structuredClone(artifact),
    JSON.parse(JSON.stringify(artifact)),
  ]) {
    expect(() => verifyProviderQualification(untrusted, f.expected)).toThrow();
  }
  // Every fresh isolate/bootstrap must authenticate the persisted bytes again.
  expect(
    verifyProviderQualification(
      await authenticateProviderQualification(f.signed, f.options),
      f.expected,
    ),
  ).toEqual(artifact);
});

test.each([
  'signature',
  'evidence',
  'manifest',
  'project',
  'environment',
  'reviewer',
  'policy',
  'content',
  'untrusted-key',
])('authentication rejects changed %s before creating an artifact', async (kind) => {
  const f = await qualificationFixture();
  if (kind === 'signature') f.signed.signature = 'A'.repeat(86);
  if (kind === 'evidence')
    f.options.evidence.pricing = new TextEncoder().encode('CHANGED_PRIVATE_MARKER');
  if (kind === 'manifest')
    f.options.evaluationManifest = new TextEncoder().encode('different corpus');
  if (kind === 'project') f.options.projectId = 'other-project';
  if (kind === 'environment') f.options.environmentId = 'other-environment';
  if (kind === 'reviewer') f.options.reviewerId = 'other-reviewer';
  if (kind === 'policy') f.options.policyHash = 'c'.repeat(64);
  if (kind === 'content') f.options.contentHash = 'c'.repeat(64);
  if (kind === 'untrusted-key')
    f.options.publicKey = (
      await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
    ).publicKey;
  await expect(authenticateProviderQualification(f.signed, f.options)).rejects.toThrow(
    'Provider qualification rejected',
  );
});

test.each([
  { scope: 'evaluation' },
  { expiresAt: '2000-01-01T00:00:00Z' },
  { issuedAt: '2099-01-01T00:00:00Z' },
  { model: 'gpt-5.6-terra' },
])('even a correctly signed invalid authorization is rejected: %j', async (patch) => {
  const f = await qualificationFixture(patch);
  await expect(authenticateProviderQualification(f.signed, f.options)).rejects.toThrow();
});

test('runtime checks current hashes and expiry on every dispatch', async () => {
  const f = await qualificationFixture(),
    artifact = await authenticateProviderQualification(f.signed, f.options);
  for (const patch of [
    { policyHash: 'a'.repeat(64) },
    { contentHash: 'a'.repeat(64) },
    { now: f.expected.now + 3600000 },
    { now: NaN },
  ]) {
    expect(() => verifyProviderQualification(artifact, { ...f.expected, ...patch })).toThrow();
  }
});
