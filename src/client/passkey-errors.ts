// Turn browser WebAuthn ceremony failures into actionable text. The
// SimpleWebAuthn browser helpers tag most failures with a stable `code`;
// platform-cancelled prompts arrive as a passthrough NotAllowedError instead.
export function describePasskeyFailure(error: unknown, ceremony: 'create' | 'sign-in'): Error {
  const code = (error as { code?: unknown } | null)?.code;
  const name = error instanceof Error ? error.name : '';
  switch (code) {
    case 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED':
      return new Error(
        'That passkey is already registered. Try signing in with it, or choose a different passkey provider to create a new one.',
      );
    case 'ERROR_AUTHENTICATOR_MISSING_DISCOVERABLE_CREDENTIAL_SUPPORT':
      return new Error(
        'That authenticator cannot save a discoverable account passkey. Try your device passkey, iCloud Keychain, Google Password Manager, or Windows Hello.',
      );
    case 'ERROR_AUTHENTICATOR_MISSING_USER_VERIFICATION_SUPPORT':
    case 'ERROR_AUTO_REGISTER_USER_VERIFICATION_FAILURE':
      return new Error(
        'That authenticator cannot verify you with a fingerprint, face, or device PIN. Try a device passkey that can.',
      );
    case 'ERROR_AUTHENTICATOR_NO_SUPPORTED_PUBKEYCREDPARAMS_ALG':
      return new Error(
        'That authenticator does not support the passkey types accepted here. Try a passkey from your phone, tablet, or computer.',
      );
    case 'ERROR_INVALID_DOMAIN':
    case 'ERROR_INVALID_RP_ID':
      return new Error(
        'Passkeys are not available at this site address. Open Reflection at its exact address and try again.',
      );
    case 'ERROR_CEREMONY_ABORTED':
      return new Error('The passkey prompt was cancelled. Try again when you are ready.');
    default:
      break;
  }
  switch (name) {
    case 'NotAllowedError':
      return new Error(
        ceremony === 'create'
          ? 'The passkey prompt was closed or timed out before a passkey was created. Try again and complete the prompt.'
          : 'The passkey prompt was closed, timed out, or no matching passkey was selected. Try again and choose the passkey for this account.',
      );
    case 'SecurityError':
      return new Error(
        'Passkeys are blocked at this site address. Open Reflection at its exact address over a secure connection and try again.',
      );
    case 'InvalidStateError':
      return new Error(
        ceremony === 'create'
          ? 'That passkey is already registered. Try signing in with it, or choose a different passkey provider.'
          : 'That passkey is no longer valid for this account. Try another passkey, or recover your account with your recovery kit.',
      );
    case 'NotSupportedError':
      return new Error(
        'This browser or device does not support the passkey types accepted here. Try a current browser with your device passkey, iCloud Keychain, or Google Password Manager.',
      );
    case 'AbortError':
      return new Error('The passkey prompt was cancelled. Try again when you are ready.');
    default:
      return error instanceof Error
        ? error
        : new Error('The passkey action was not completed. Please try again.');
  }
}
