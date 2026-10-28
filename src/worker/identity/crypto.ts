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
export interface IdentityKeyring {
  v: 1;
  environment: string;
  activeKeyId: string;
  /** Stable auth/verifier secret; bundle rotation must not invalidate recovery kits. */
  identityHmacKey: string;
  keys: Array<Omit<IdentitySecrets, 'environment'>>;
}
const keyId = z.string().regex(/^[\w-]{1,64}$/);
const keyMaterial = z.string().length(43);
const Key = z.strictObject({
  keyId,
  wrapKey: keyMaterial,
  recoveryKey: keyMaterial,
  hmacKey: keyMaterial,
});
const environment = z.string().regex(/^[\w-]{1,64}$/);
const Secrets = z.union([
  Key.extend({ environment }),
  z.strictObject({
    v: z.literal(1),
    environment,
    activeKeyId: keyId,
    identityHmacKey: keyMaterial,
    keys: z.array(Key).min(1).max(32),
  }),
]);
/** Never echo rejected configuration or key material in a validation error. */
export function parseIdentitySecrets(raw: string): IdentitySecrets | IdentityKeyring {
  try {
    if (raw.length > 32_000) throw new Error();
    const config = Secrets.parse(JSON.parse(raw));
    new IdentityCrypto(config);
    return config;
  } catch {
    throw new Error('Identity key configuration unavailable');
  }
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
  aadRevision: z.literal(2).optional(),
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
  readonly secrets: IdentitySecrets;
  readonly identityHmacKey: string;
  private readonly keyring = new Map<string, IdentitySecrets>();
  constructor(input: IdentitySecrets | IdentityKeyring) {
    try {
      const parsed = Secrets.parse(input);
      const keys = 'v' in parsed ? parsed.keys : [parsed];
      for (const value of keys) {
        if (this.keyring.has(value.keyId)) throw new Error();
        for (const key of [value.wrapKey, value.recoveryKey, value.hmacKey])
          if (decode(key).byteLength !== 32) throw new Error();
        this.keyring.set(value.keyId, { ...value, environment: parsed.environment });
      }
      const active = this.keyring.get('v' in parsed ? parsed.activeKeyId : parsed.keyId);
      if (!active) throw new Error();
      this.secrets = active;
      this.identityHmacKey = 'v' in parsed ? parsed.identityHmacKey : parsed.hmacKey;
      if (decode(this.identityHmacKey).byteLength !== 32) throw new Error();
    } catch {
      throw new Error('Identity key configuration unavailable');
    }
  }
  forKey(id: string): IdentityCrypto {
    if (id === this.secrets.keyId) return this;
    const key = this.keyring.get(id);
    if (!key) throw new Error('Identity key unavailable');
    const { environment, ...bundle } = key;
    return new IdentityCrypto({
      v: 1,
      environment,
      activeKeyId: id,
      identityHmacKey: this.identityHmacKey,
      keys: [bundle],
    });
  }
  retainedKeys() {
    return [...this.keyring.keys()]
      .filter((id) => id !== this.secrets.keyId)
      .map((id) => this.forKey(id));
  }
  envelopeKeyId(value: string) {
    if (value.length > 91_000) throw new Error('Identity payload too large');
    return Envelope.parse(JSON.parse(value)).keyId;
  }
  private async keyedMac(
    rawKey: string,
    purpose: string,
    value: unknown,
  ): Promise<Uint8Array<ArrayBuffer>> {
    const base = await crypto.subtle.importKey('raw', decode(rawKey), 'HKDF', false, ['deriveKey']);
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
  async mac(purpose: string, value: unknown): Promise<Uint8Array<ArrayBuffer>> {
    return this.keyedMac(this.identityHmacKey, purpose, value);
  }
  async hash(purpose: string, value: unknown): Promise<string> {
    return Array.from(await this.mac(purpose, value), (b) => b.toString(16).padStart(2, '0')).join(
      '',
    );
  }
  async recoveryHash(purpose: string, value: unknown): Promise<string> {
    return Array.from(await this.keyedMac(this.secrets.hmacKey, purpose, value), (b) =>
      b.toString(16).padStart(2, '0'),
    ).join('');
  }
  async seal(value: unknown, purpose: unknown[], rawKey: string, aadRevision?: 2): Promise<string> {
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
      ...(aadRevision ? { aadRevision } : {}),
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
  private wrapAccountKey(owner: string, purpose: 'data' | 'index', raw: string, version: number) {
    if (!Number.isSafeInteger(version) || version < 1)
      throw new Error('Invalid account key version');
    return this.seal(
      { key: raw },
      [this.secrets.environment, 'account-key.v2', owner, version, purpose, this.secrets.keyId],
      this.secrets.wrapKey,
      2,
    );
  }
  async createAccountKeys(owner: string, version = 1): Promise<WrappedKeys> {
    return {
      wrapKeyId: this.secrets.keyId,
      wrappedKey: await this.wrapAccountKey(owner, 'data', randomToken(), version),
      wrappedIndexKey: await this.wrapAccountKey(owner, 'index', randomToken(), version),
    };
  }
  /** Replace only the DEK; ordinary rotation retains the separate stable index key. */
  async createAccountDataVersion(
    owner: string,
    version: number,
    index: Uint8Array<ArrayBuffer>,
  ): Promise<WrappedKeys> {
    if (!Number.isSafeInteger(version) || version < 2 || index.length !== 32)
      throw new Error('Invalid data-key version');
    return {
      wrapKeyId: this.secrets.keyId,
      wrappedKey: await this.wrapAccountKey(owner, 'data', randomToken(), version),
      wrappedIndexKey: await this.wrapAccountKey(owner, 'index', encode(index), version),
    };
  }
  async unwrapAccountKey(
    owner: string,
    value: string,
    purpose: 'data' | 'index',
    version = 1,
  ): Promise<Uint8Array<ArrayBuffer>> {
    if (!Number.isSafeInteger(version) || version < 1)
      throw new Error('Invalid account key version');
    if (value.length > 91_000) throw new Error('Identity payload too large');
    const envelope = Envelope.parse(JSON.parse(value)),
      crypt = this.forKey(envelope.keyId);
    const aad =
      envelope.aadRevision === 2
        ? [this.secrets.environment, 'account-key.v2', owner, version, purpose, envelope.keyId]
        : [this.secrets.environment, 'account-key.v1', owner, version, purpose];
    const plain = z
      .strictObject({ key: z.string() })
      .parse(await crypt.open(value, aad, crypt.secrets.wrapKey));
    const key = decode(plain.key);
    if (key.length !== 32) throw new Error('Invalid account key');
    return key;
  }
  async rewrapAccountKeys(
    owner: string,
    version: number,
    previous: WrappedKeys,
  ): Promise<WrappedKeys> {
    if (
      [previous.wrappedKey, previous.wrappedIndexKey].some(
        (value) => this.envelopeKeyId(value) !== previous.wrapKeyId,
      )
    )
      throw new Error('Account wrap identity mismatch');
    const data = await this.unwrapAccountKey(owner, previous.wrappedKey, 'data', version),
      index = await this.unwrapAccountKey(owner, previous.wrappedIndexKey, 'index', version);
    const wrapped = {
      wrapKeyId: this.secrets.keyId,
      wrappedKey: await this.wrapAccountKey(owner, 'data', encode(data), version),
      wrappedIndexKey: await this.wrapAccountKey(owner, 'index', encode(index), version),
    };
    if (
      encode(await this.unwrapAccountKey(owner, wrapped.wrappedKey, 'data', version)) !==
        encode(data) ||
      encode(await this.unwrapAccountKey(owner, wrapped.wrappedIndexKey, 'index', version)) !==
        encode(index)
    )
      throw new Error('Account key rewrap verification failed');
    return wrapped;
  }
  async checkpointKey(snapshot: Checkpoint): Promise<string> {
    return `identity/v1/${await this.recoveryHash('identity-subject', snapshot.subjectId)}/${snapshot.epoch}-${snapshot.operationId}.enc`;
  }
  private async checkpointAAD(owner: string, epoch: number, operation: string) {
    return [
      this.secrets.environment,
      'identity-checkpoint',
      await this.recoveryHash('identity-subject', owner),
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
    const crypt = this.forKey(this.envelopeKeyId(value));
    const snapshot = IdentityCheckpoint.parse(
      await crypt.open(
        value,
        await crypt.checkpointAAD(owner, epoch, operation),
        crypt.secrets.recoveryKey,
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
