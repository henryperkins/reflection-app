import { expect, test } from 'vitest';
import { describePasskeyFailure } from '../../src/client/passkey-errors.ts';

const tagged = (code: string, name = 'UnknownError') =>
  Object.assign(new Error('raw platform detail'), { name, code });

test('tagged WebAuthn failures map to actionable guidance', () => {
  expect(
    describePasskeyFailure(tagged('ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED'), 'create').message,
  ).toContain('already registered');
  expect(
    describePasskeyFailure(
      tagged('ERROR_AUTHENTICATOR_MISSING_DISCOVERABLE_CREDENTIAL_SUPPORT', 'ConstraintError'),
      'create',
    ).message,
  ).toContain('discoverable');
  expect(
    describePasskeyFailure(
      tagged('ERROR_AUTHENTICATOR_MISSING_USER_VERIFICATION_SUPPORT', 'ConstraintError'),
      'create',
    ).message,
  ).toContain('fingerprint, face, or device PIN');
  expect(
    describePasskeyFailure(tagged('ERROR_INVALID_RP_ID', 'SecurityError'), 'sign-in').message,
  ).toContain('exact address');
});

test('cancelled or timed-out prompts say so for both ceremonies', () => {
  const cancelled = Object.assign(new Error('The operation either timed out or was not allowed'), {
    name: 'NotAllowedError',
    code: 'ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY',
  });
  expect(describePasskeyFailure(cancelled, 'create').message).toContain('closed or timed out');
  expect(describePasskeyFailure(cancelled, 'sign-in').message).toContain('no matching passkey');
});

test('unknown errors pass through unchanged and non-errors get a fallback', () => {
  const original = new Error('Registration is unavailable.');
  expect(describePasskeyFailure(original, 'create')).toBe(original);
  expect(describePasskeyFailure('nope', 'sign-in').message).toContain('was not completed');
});
