import { expect, test } from 'vitest';
import {
  authenticateProviderQualification,
  verifyProviderQualification,
} from '../../src/worker/provider/qualification.ts';
import { qualificationFixture } from '../fixtures/provider.ts';

test('Workers Web Crypto authenticates qualification evidence and rejects a tampered deployment artifact', async () => {
  const f = await qualificationFixture();
  const artifact = await authenticateProviderQualification(f.signed, f.options);
  expect(verifyProviderQualification(artifact, f.expected)).toBe(artifact);
  await expect(
    authenticateProviderQualification(
      { ...f.signed, document: { ...f.signed.document, reviewerId: 'changed' } },
      f.options,
    ),
  ).rejects.toThrow();
  expect(() =>
    verifyProviderQualification(JSON.parse(JSON.stringify(artifact)), f.expected),
  ).toThrow();
});
