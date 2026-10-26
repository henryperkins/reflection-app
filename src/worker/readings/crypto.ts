import type { z } from 'zod';
import { Ciphertext } from '../../contracts/index.ts';
import { canonicalJson } from '../../domain/json.ts';
import { decode, encode, type IdentityCrypto } from '../identity/crypto.ts';
import { statement as q } from '../db/core.ts';

const utf8 = new TextEncoder();
/** One request-scoped key cache. No plaintext keys or records survive the request. */
export class RecordCrypto {
  private keys = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();
  constructor(
    private db: D1Database,
    readonly identity: IdentityCrypto,
  ) {}
  private key(owner: string, purpose: 'data' | 'index', version: number) {
    const cacheKey = `${owner}:${version}:${purpose}`;
    let key = this.keys.get(cacheKey);
    if (!key) {
      key = (async () => {
        if (!Number.isSafeInteger(version) || version < 1)
          throw new Error('Unavailable key version');
        const row = await q(
          this.db,
          'SELECT wrap_key_id,wrapped_key_enc,wrapped_index_key_enc FROM account_keys WHERE owner_id=? AND version=?',
          owner,
          version,
        ).first<{ wrap_key_id: string; wrapped_key_enc: string; wrapped_index_key_enc: string }>();
        if (!row) throw new Error('Unavailable key');
        const encrypted = purpose === 'data' ? row.wrapped_key_enc : row.wrapped_index_key_enc;
        if (this.identity.envelopeKeyId(encrypted) !== row.wrap_key_id)
          throw new Error('Account wrap identity mismatch');
        return this.identity.unwrapAccountKey(owner, encrypted, purpose, version);
      })();
      this.keys.set(cacheKey, key);
    }
    return key;
  }
  private aad(
    owner: string,
    table: string,
    column: string,
    id: string,
    revision: number,
    version: number,
  ) {
    return utf8.encode(
      canonicalJson([
        this.identity.secrets.environment,
        table,
        column,
        owner,
        id,
        revision,
        1,
        version,
      ]),
    );
  }
  async seal(
    owner: string,
    table: string,
    column: string,
    id: string,
    value: unknown,
    revision = 1,
    version = 1,
  ) {
    const bytes = utf8.encode(canonicalJson(value));
    if (bytes.length > 1_000_000) throw new Error('Record too large');
    const key = await crypto.subtle.importKey(
      'raw',
      await this.key(owner, 'data', version),
      'AES-GCM',
      false,
      ['encrypt'],
    );
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: nonce,
        additionalData: this.aad(owner, table, column, id, revision, version),
        tagLength: 128,
      },
      key,
      bytes,
    );
    return canonicalJson(
      Ciphertext.parse({
        v: 1,
        alg: 'A256GCM',
        keyVersion: version,
        aadRevision: revision,
        nonce: encode(nonce),
        data: encode(new Uint8Array(data)),
      }),
    );
  }
  async open<T>(
    owner: string,
    table: string,
    column: string,
    id: string,
    value: string,
    schema: z.ZodType<T>,
    revision = 1,
    version = 1,
  ): Promise<T> {
    if (value.length > 1_500_000) throw new Error('Record too large');
    const envelope = Ciphertext.parse(JSON.parse(value));
    if (envelope.aadRevision !== revision || envelope.keyVersion !== version)
      throw new Error('Record identity mismatch');
    const nonce = decode(envelope.nonce),
      data = decode(envelope.data);
    if (nonce.length !== 12 || data.length < 16 || data.length > 1_000_016)
      throw new Error('Invalid envelope');
    const key = await crypto.subtle.importKey(
      'raw',
      await this.key(owner, 'data', version),
      'AES-GCM',
      false,
      ['decrypt'],
    );
    const bytes = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: nonce,
        additionalData: this.aad(owner, table, column, id, revision, version),
        tagLength: 128,
      },
      key,
      data,
    );
    return schema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  }
  async hash(owner: string, purpose: string, value: unknown) {
    const current = await q(
      this.db,
      'SELECT key_version FROM accounts WHERE id=?',
      owner,
    ).first<number>('key_version');
    if (current === null) throw new Error('Unavailable account key');
    const base = await crypto.subtle.importKey(
      'raw',
      await this.key(owner, 'index', current),
      'HKDF',
      false,
      ['deriveKey'],
    );
    const key = await crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: utf8.encode(this.identity.secrets.environment),
        info: utf8.encode(`reflection.index.v1:${purpose}`),
      },
      base,
      { name: 'HMAC', hash: 'SHA-256', length: 256 },
      false,
      ['sign'],
    );
    return Array.from(
      new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8.encode(canonicalJson(value)))),
      (b) => b.toString(16).padStart(2, '0'),
    ).join('');
  }
}
export const encryptedBytes = (...values: Array<string | null>) =>
  values.reduce((sum, value) => sum + (value === null ? 0 : utf8.encode(value).length), 0);
