import { encode } from '../../src/worker/identity/crypto.ts';
import { IDENTITY_SECRETS } from './identity.ts';

/** Public, deterministic keys for isolated local tests only. */
export const NEXT_IDENTITY_SECRETS = {
  environment: 'synthetic-local',
  keyId: 'synthetic-v2',
  wrapKey: encode(new Uint8Array(32).fill(4)),
  recoveryKey: encode(new Uint8Array(32).fill(5)),
  hmacKey: encode(new Uint8Array(32).fill(6)),
};
export const ROTATED_KEYRING = {
  v: 1 as const,
  environment: 'synthetic-local',
  activeKeyId: NEXT_IDENTITY_SECRETS.keyId,
  identityHmacKey: IDENTITY_SECRETS.hmacKey,
  keys: [IDENTITY_SECRETS, NEXT_IDENTITY_SECRETS].map(({ environment: _, ...key }) => key),
};
