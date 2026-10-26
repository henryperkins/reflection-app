import { z } from 'zod';
import { IdentityCheckpoint } from '../../contracts/index.ts';
import { canonicalJson } from '../../domain/json.ts';

export type Checkpoint = z.infer<typeof IdentityCheckpoint>;
export interface IdentitySecrets {
  environment: string;
  keyId: string;
  wrapKey: string;
  recoveryKey: string;
  hmacKey: string;
}
export interface WrappedKeys {
  wrapKeyId: string;
  wrappedKey: string;
  wrappedIndexKey: string;
}
const Envelope = z.strictObject({
  v: z.literal(1),
  alg: z.literal('A256GCM'),
  keyId: z.string().regex(/^[\w-]{1,64}$/),
  nonce: z.string().max(16),
  data: z.string().max(90_000),
});
const utf8 = new TextEncoder();
export function encode(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
export function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[\w-]+$/.test(value)) throw new Error('Invalid encoding');
  const result = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (c) =>
    c.charCodeAt(0),
  );
  if (encode(result) !== value) throw new Error('Noncanonical encoding');
  return result;
}
export const randomToken = (bytes = 32): string =>
  encode(crypto.getRandomValues(new Uint8Array(bytes)));
export function uuidBytes(id: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(id.replaceAll('-', '').match(/../g) ?? [], (x) => Number.parseInt(x, 16));
}
export class IdentityCrypto {
  constructor(readonly secrets: IdentitySecrets) {
    for (const key of [secrets.wrapKey, secrets.recoveryKey, secrets.hmacKey]) {
      if (decode(key).byteLength !== 32) throw new Error('Identity key unavailable');
    }
  }
  async mac(purpose: string, value: unknown): Promise<Uint8Array<ArrayBuffer>> {
    const base = await crypto.subtle.importKey('raw', decode(this.secrets.hmacKey), 'HKDF', false, [
      'deriveKey',
    ]);
    const key = await crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: utf8.encode(this.secrets.environment),
        info: utf8.encode(`reflection.identity.v1:${purpose}`),
      },
      base,
      { name: 'HMAC', hash: 'SHA-256', length: 256 },
      false,
      ['sign'],
    );
    return new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8.encode(canonicalJson(value))));
  }
  async hash(purpose: string, value: unknown): Promise<string> {
    return Array.from(await this.mac(purpose, value), (b) => b.toString(16).padStart(2, '0')).join(
      '',
    );
  }
  async seal(value: unknown, purpose: unknown[], rawKey: string): Promise<string> {
    const key = await crypto.subtle.importKey('raw', decode(rawKey), 'AES-GCM', false, ['encrypt']);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = utf8.encode(canonicalJson(value));
    if (plaintext.length > 64 * 1024) throw new Error('Identity payload too large');
    const data = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: nonce,
        additionalData: utf8.encode(canonicalJson(purpose)),
        tagLength: 128,
      },
      key,
      plaintext,
    );
    return canonicalJson({
      v: 1,
      alg: 'A256GCM',
      keyId: this.secrets.keyId,
      nonce: encode(nonce),
      data: encode(new Uint8Array(data)),
    });
  }
  async open(value: string, purpose: unknown[], rawKey: string): Promise<unknown> {
    if (value.length > 91_000) throw new Error('Identity payload too large');
    const envelope = Envelope.parse(JSON.parse(value));
    if (envelope.keyId !== this.secrets.keyId) throw new Error('Identity key unavailable');
    const nonce = decode(envelope.nonce),
      data = decode(envelope.data);
    if (nonce.length !== 12 || data.length < 16 || data.length > 64 * 1024 + 16)
      throw new Error('Invalid envelope');
    const key = await crypto.subtle.importKey('raw', decode(rawKey), 'AES-GCM', false, ['decrypt']);
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: nonce,
        additionalData: utf8.encode(canonicalJson(purpose)),
        tagLength: 128,
      },
      key,
      data,
    );
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
  }
  async createAccountKeys(owner: string): Promise<WrappedKeys> {
    const wrap = (purpose: string) =>
      this.seal(
        { key: randomToken() },
        [this.secrets.environment, 'account-key.v1', owner, 1, purpose],
        this.secrets.wrapKey,
      );
    return {
      wrapKeyId: this.secrets.keyId,
      wrappedKey: await wrap('data'),
      wrappedIndexKey: await wrap('index'),
    };
  }
  async unwrapAccountKey(
    owner: string,
    value: string,
    purpose: 'data' | 'index',
  ): Promise<Uint8Array<ArrayBuffer>> {
    const plain = z
      .strictObject({ key: z.string() })
      .parse(
        await this.open(
          value,
          [this.secrets.environment, 'account-key.v1', owner, 1, purpose],
          this.secrets.wrapKey,
        ),
      );
    const key = decode(plain.key);
    if (key.length !== 32) throw new Error('Invalid account key');
    return key;
  }
  async checkpointKey(snapshot: Checkpoint): Promise<string> {
    return `identity/v1/${await this.hash('identity-subject', snapshot.subjectId)}/${snapshot.epoch}-${snapshot.operationId}.enc`;
  }
  private async checkpointAAD(owner: string, epoch: number, operation: string) {
    return [
      this.secrets.environment,
      'identity-checkpoint',
      await this.hash('identity-subject', owner),
      epoch,
      operation,
      1,
    ];
  }
  async sealCheckpoint(snapshot: Checkpoint): Promise<string> {
    return this.seal(
      IdentityCheckpoint.parse(snapshot),
      await this.checkpointAAD(snapshot.subjectId, snapshot.epoch, snapshot.operationId),
      this.secrets.recoveryKey,
    );
  }
  async openCheckpoint(
    owner: string,
    epoch: number,
    operation: string,
    value: string,
  ): Promise<Checkpoint> {
    const snapshot = IdentityCheckpoint.parse(
      await this.open(
        value,
        await this.checkpointAAD(owner, epoch, operation),
        this.secrets.recoveryKey,
      ),
    );
    if (
      snapshot.subjectId !== owner ||
      snapshot.epoch !== epoch ||
      snapshot.operationId !== operation
    )
      throw new Error('Checkpoint identity mismatch');
    return snapshot;
  }
}
