import { isoCBOR } from '@simplewebauthn/server/helpers';
import type { z } from 'zod';
import type { AuthOptions } from '../../src/contracts/index.ts';
import { decode, encode, randomToken } from '../../src/worker/identity/crypto.ts';
const bytes = (s: string) => new TextEncoder().encode(s);
const concat = (...arrays: Uint8Array[]) => {
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let at = 0;
  for (const a of arrays) {
    out.set(a, at);
    at += a.length;
  }
  return out;
};
const sha = async (b: Uint8Array<ArrayBuffer>) =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', b));
export async function syntheticPasskey() {
  const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const publicKey = await crypto.subtle.exportKey('jwk', key.publicKey);
  const id = randomToken(32);
  const cose = isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, decode(publicKey.x!)],
      [-3, decode(publicKey.y!)],
    ]),
  );
  const authData = async (rp: string, flag: number, counter: number) => {
    const count = new Uint8Array(4);
    new DataView(count.buffer).setUint32(0, counter);
    return concat(await sha(bytes(rp)), new Uint8Array([flag]), count);
  };
  return {
    id,
    async register(
      options: z.infer<typeof AuthOptions>,
      origin = 'http://localhost:8787',
      verified = true,
    ) {
      const clientDataJSON = encode(
        bytes(
          JSON.stringify({
            type: 'webauthn.create',
            challenge: options.challenge,
            origin,
            crossOrigin: false,
          }),
        ),
      );
      const credentialId = decode(id);
      const size = new Uint8Array(2);
      new DataView(size.buffer).setUint16(0, credentialId.length);
      const data = concat(
        await authData(options.rpId, verified ? 0x45 : 0x41, 0),
        new Uint8Array(16),
        size,
        credentialId,
        cose,
      );
      const attestation = isoCBOR.encode(
        new Map<string, unknown>([
          ['fmt', 'none'],
          ['attStmt', new Map()],
          ['authData', data],
        ]) as Parameters<typeof isoCBOR.encode>[0],
      );
      return {
        id,
        rawId: id,
        type: 'public-key' as const,
        response: {
          clientDataJSON,
          attestationObject: encode(attestation),
          transports: ['internal' as const],
        },
        clientExtensionResults: { credProps: { rk: true } },
      };
    },
    async authenticate(
      options: z.infer<typeof AuthOptions>,
      userHandle: string,
      counter = 1,
      origin = 'http://localhost:8787',
    ) {
      const client = bytes(
        JSON.stringify({
          type: 'webauthn.get',
          challenge: options.challenge,
          origin,
          crossOrigin: false,
        }),
      );
      const data = await authData(options.rpId, 5, counter);
      const signature = new Uint8Array(
        await crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          key.privateKey,
          concat(data, await sha(client)),
        ),
      );
      const integer = (part: Uint8Array) => {
        let i = 0;
        while (i < part.length - 1 && part[i] === 0) i++;
        let value = part.slice(i);
        if (value[0]! >= 128) value = concat(new Uint8Array([0]), value);
        return concat(new Uint8Array([2, value.length]), value);
      };
      const sequence = concat(integer(signature.slice(0, 32)), integer(signature.slice(32)));
      return {
        id,
        rawId: id,
        type: 'public-key' as const,
        response: {
          clientDataJSON: encode(client),
          authenticatorData: encode(data),
          signature: encode(concat(new Uint8Array([0x30, sequence.length]), sequence)),
          userHandle,
        },
        clientExtensionResults: {},
      };
    },
  };
}
