import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import type { z } from 'zod';
import { apiSchemas, type AuthOptions, AuthResult } from '../contracts/index.ts';
import { api } from './api.ts';
export async function enroll(options: z.infer<typeof AuthOptions>, csrf?: string) {
  if (!options.user) throw new Error('Registration is unavailable.');
  const response = await startRegistration({
    optionsJSON: {
      challenge: options.challenge,
      rp: { id: options.rpId, name: options.rpName },
      user: options.user,
      pubKeyCredParams: options.algorithms.map((alg) => ({ type: 'public-key', alg })),
      timeout: options.timeout,
      attestation: options.attestation,
      authenticatorSelection: {
        residentKey: options.residentKey,
        userVerification: options.userVerification,
      },
      excludeCredentials: options.excludeCredentialIds.map((id) => ({ id, type: 'public-key' })),
      extensions: { credProps: true },
    },
  });
  // Explicitly project the closed application contract; L3 convenience fields are not accepted inputs.
  const credential = {
    id: response.id,
    rawId: response.rawId,
    type: response.type,
    response: {
      clientDataJSON: response.response.clientDataJSON,
      attestationObject: response.response.attestationObject,
      transports: response.response.transports ?? [],
    },
    clientExtensionResults: {
      ...(response.clientExtensionResults.credProps
        ? { credProps: response.clientExtensionResults.credProps }
        : {}),
    },
    ...(response.authenticatorAttachment
      ? { authenticatorAttachment: response.authenticatorAttachment }
      : {}),
  };
  return api('/auth/register', AuthResult, { challengeId: options.challengeId, credential }, csrf);
}
export async function signIn(purpose: 'authenticate' | 'reauthenticate', csrf?: string) {
  const options = await api('/auth/options', apiSchemas.AuthOptions, { purpose }, csrf);
  const response = await startAuthentication({
    optionsJSON: {
      challenge: options.challenge,
      rpId: options.rpId,
      timeout: options.timeout,
      userVerification: options.userVerification,
    },
  });
  const credential = {
    id: response.id,
    rawId: response.rawId,
    type: response.type,
    response: {
      clientDataJSON: response.response.clientDataJSON,
      authenticatorData: response.response.authenticatorData,
      signature: response.response.signature,
      userHandle: response.response.userHandle ?? null,
    },
    clientExtensionResults: response.clientExtensionResults,
    ...(response.authenticatorAttachment
      ? { authenticatorAttachment: response.authenticatorAttachment }
      : {}),
  };
  return api('/auth/authenticate', AuthResult, { challengeId: options.challengeId, credential });
}
