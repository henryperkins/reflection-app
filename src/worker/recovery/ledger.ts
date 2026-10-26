import type { z } from 'zod';
import {
  Id,
  ErasureIntent,
  ErasureTarget,
  ErasurePass,
  ErasureCompletion,
  RecoveryCiphertext,
} from '../../contracts/index.ts';
import { canonicalJson, sha256Json } from '../../domain/json.ts';
import type { IdentityCrypto } from '../identity/crypto.ts';

export type Target = z.infer<typeof ErasureTarget>;
export type Intent = z.infer<typeof ErasureIntent>;
export type Pass = z.infer<typeof ErasurePass>;
export type Completion = z.infer<typeof ErasureCompletion>;
export interface Chain {
  intent: Intent;
  target: Target;
  passes: Array<{ start: Pass; complete: Completion | null }>;
  completion: Completion | null;
  pending: Pass | null;
}
export const DAY = 86_400_000;
const iso = (time: number) => new Date(time).toISOString();
/** Complete, bounded-page inventory. A repeated/missing cursor must never truncate recovery. */
export async function objects(bucket: R2Bucket, prefix: string) {
  const entries: R2Object[] = [],
    cursors = new Set<string>(),
    names = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, limit: 100, ...(cursor ? { cursor } : {}) });
    for (const item of page.objects) {
      if (!item.key.startsWith(prefix) || names.has(item.key))
        throw new Error('Invalid ledger inventory');
      names.add(item.key);
      entries.push(item);
    }
    if (!page.truncated) break;
    if (!page.cursor || cursors.has(page.cursor)) throw new Error('Incomplete ledger inventory');
    cursor = page.cursor;
    cursors.add(cursor);
  } while (cursor !== undefined);
  return entries;
}

/** Preserve exact signed UUID case for legacy receipts; new admission is lowercase. */
export function erasureJobIds(entries: Array<{ key: string }>) {
  return [
    ...new Set(
      entries.map((item) => {
        const match =
          /^erasures\/v1\/([^/]+)\/(intent\.json|passes\/[1-9][0-9]*\/(start|complete)\.json)$/.exec(
            item.key,
          );
        if (!match || !Id.safeParse(match[1]).success) throw new Error('Unexpected erasure object');
        return match[1]!;
      }),
    ),
  ];
}

/** Existing local ledger encoding, authenticated independently of account DEKs. */
export class ErasureLedger {
  readonly keys: ReadonlyMap<string, IdentityCrypto>;
  constructor(
    readonly bucket: R2Bucket,
    readonly crypt: IdentityCrypto,
    retained: IdentityCrypto[] = [],
  ) {
    const keys = new Map<string, IdentityCrypto>();
    for (const value of [crypt, ...retained]) {
      if (value.secrets.environment !== crypt.secrets.environment || keys.has(value.secrets.keyId))
        throw new Error('Invalid recovery key ring');
      keys.set(value.secrets.keyId, value);
    }
    this.keys = keys;
  }
  key(id: string) {
    const key = this.keys.get(id);
    if (!key) throw new Error('Recovery key unavailable');
    return key;
  }
  subject(owner: string, key = this.crypt) {
    return key.hash('erasure-subject.v1', owner);
  }
  targetHash(target: Target, key = this.crypt) {
    return key.hash('erasure-target.v1', target);
  }
  token(id: string, token: string, key = this.crypt) {
    return key.hash('erasure-receipt.v1', [id, token]);
  }
  private aad(
    intent: Pick<
      Intent,
      'jobId' | 'scope' | 'subjectHmac' | 'targetHmac' | 'hmacKeyId' | 'requestedAt'
    >,
    keyId: string,
  ) {
    return [
      this.crypt.secrets.environment,
      'erasure-target.v1',
      intent.jobId,
      intent.scope,
      intent.subjectHmac,
      intent.targetHmac,
      intent.hmacKeyId,
      intent.requestedAt,
      keyId,
    ];
  }
  private async signed<T extends object>(kind: string, value: T, key = this.crypt) {
    return { ...value, operationMac: await key.hash(kind, [key.secrets.environment, value]) };
  }
  async verify<T extends { hmacKeyId: string; operationMac: string }>(
    kind: string,
    schema: z.ZodType<T>,
    raw: string,
  ) {
    if (raw.length > 16384) throw new Error('Oversized ledger object');
    const value = schema.parse(JSON.parse(raw)),
      { operationMac, ...rest } = value;
    const key = this.key(value.hmacKeyId);
    if (
      canonicalJson(value) !== raw ||
      operationMac !== (await key.hash(kind, [key.secrets.environment, rest]))
    )
      throw new Error('Invalid ledger authentication');
    return value;
  }
  async create(
    target: Target,
    id: string,
    receiptHash: string | null,
    createdAt: number,
  ): Promise<Intent> {
    const fields = {
      v: 1 as const,
      jobId: id,
      scope: target.scope,
      subjectHmac: await this.subject(target.subjectId),
      targetHmac: await this.targetHash(target),
      hmacKeyId: this.crypt.secrets.keyId,
      requestedAt: iso(createdAt),
    };
    const targetEnc = RecoveryCiphertext.parse(
      JSON.parse(
        await this.crypt.seal(
          target,
          this.aad(fields, this.crypt.secrets.keyId),
          this.crypt.secrets.recoveryKey,
        ),
      ),
    );
    return ErasureIntent.parse(
      await this.signed('erasure-intent.v1', {
        ...fields,
        target: targetEnc,
        receiptTokenHmac: receiptHash,
      }),
    );
  }
  async fromPending(job: {
    id: string;
    owner_id: string | null;
    scope: string;
    target_hmac: string;
    target_enc: string | null;
    receipt_token_hash: string | null;
    created_at: number;
  }) {
    if (!job.owner_id || !job.target_enc) throw new Error('Missing erasure target');
    const target = RecoveryCiphertext.parse(JSON.parse(job.target_enc)),
      key = this.key(target.keyId);
    return ErasureIntent.parse(
      await this.signed(
        'erasure-intent.v1',
        {
          v: 1,
          jobId: job.id,
          scope: job.scope,
          subjectHmac: await this.subject(job.owner_id, key),
          targetHmac: job.target_hmac,
          hmacKeyId: key.secrets.keyId,
          requestedAt: iso(job.created_at),
          target,
          receiptTokenHmac: job.receipt_token_hash,
        },
        key,
      ),
    );
  }
  async target(intent: Intent): Promise<Target> {
    const key = this.key(intent.target.keyId),
      signer = this.key(intent.hmacKeyId);
    const target = ErasureTarget.parse(
      await key.open(
        canonicalJson(intent.target),
        this.aad(intent, intent.target.keyId),
        key.secrets.recoveryKey,
      ),
    );
    if (
      target.scope !== intent.scope ||
      (await this.subject(target.subjectId, signer)) !== intent.subjectHmac ||
      (await this.targetHash(target, signer)) !== intent.targetHmac
    )
      throw new Error('Erasure target mismatch');
    return target;
  }
  async immutable(key: string, raw: string) {
    const existing = await this.bucket.get(key);
    if (existing) return existing.text();
    if (await this.bucket.put(key, raw, { onlyIf: { etagDoesNotMatch: '*' } })) return raw;
    const raced = await this.bucket.get(key);
    if (!raced) throw new Error('Ledger unavailable');
    return raced.text();
  }
  async putIntent(intent: Intent) {
    const raw = canonicalJson(intent);
    if ((await this.immutable(`erasures/v1/${intent.jobId}/intent.json`, raw)) !== raw)
      throw new Error('Immutable intent mismatch');
  }
  async load(id: string): Promise<Chain> {
    const prefix = `erasures/v1/${id}/`,
      listed = await objects(this.bucket, prefix);
    const rows = new Map<string, string>();
    for (const item of listed) {
      if (item.size > 16384) throw new Error('Oversized ledger object');
      const found = await this.bucket.get(item.key);
      if (!found || found.etag !== item.etag) throw new Error('Ledger changed during inventory');
      rows.set(item.key.slice(prefix.length), await found.text());
    }
    const raw = rows.get('intent.json');
    if (!raw) throw new Error('Missing independent erasure intent');
    const intent = await this.verify('erasure-intent.v1', ErasureIntent, raw);
    if (intent.jobId !== id) throw new Error('Erasure identity mismatch');
    rows.delete('intent.json');
    const numbers = new Set<number>();
    for (const name of rows.keys()) {
      const match = /^passes\/([1-9][0-9]*)\/(start|complete)\.json$/.exec(name);
      if (!match || !Number.isSafeInteger(Number(match[1])))
        throw new Error('Unexpected ledger object');
      numbers.add(Number(match[1]));
    }
    const passes: Chain['passes'] = [],
      hash = await sha256Json(intent);
    let completion: Completion | null = null,
      pending: Pass | null = null;
    for (const revision of [...numbers].sort((a, b) => a - b)) {
      if (revision !== passes.length + 1 || pending) throw new Error('Noncontiguous erasure chain');
      const startRaw = rows.get(`passes/${revision}/start.json`);
      if (!startRaw) throw new Error('Missing erasure pass');
      const start = await this.verify('erasure-pass.v1', ErasurePass, startRaw);
      if (
        start.jobId !== id ||
        start.revision !== revision ||
        start.intentSha256 !== hash ||
        start.previousCompletionSha256 !== (completion ? await sha256Json(completion) : null)
      )
        throw new Error('Invalid erasure pass chain');
      const completeRaw = rows.get(`passes/${revision}/complete.json`);
      let complete: Completion | null = null;
      if (completeRaw) {
        complete = await this.verify('erasure-completion.v1', ErasureCompletion, completeRaw);
        const erased = Date.parse(complete.erasedAt),
          backup = Date.parse(complete.backupExpiresBy),
          purge = Date.parse(complete.purgeAfter);
        if (
          complete.jobId !== id ||
          complete.revision !== revision ||
          complete.intentSha256 !== hash ||
          complete.passSha256 !== (await sha256Json(start)) ||
          erased < Date.parse(start.startedAt) ||
          backup < erased + 30 * DAY ||
          purge < Math.max(erased + 45 * DAY, backup + 15 * DAY) ||
          (completion &&
            (backup < Date.parse(completion.backupExpiresBy) ||
              purge < Date.parse(completion.purgeAfter)))
        )
          throw new Error('Invalid erasure completion chain');
        completion = complete;
      } else pending = start;
      passes.push({ start, complete });
    }
    return { intent, target: await this.target(intent), passes, completion, pending };
  }
  async begin(chain: Chain, now = Date.now()): Promise<Pass> {
    if (chain.pending) return chain.pending;
    const pass = ErasurePass.parse(
      await this.signed('erasure-pass.v1', {
        v: 1,
        jobId: chain.intent.jobId,
        revision: chain.passes.length + 1,
        intentSha256: await sha256Json(chain.intent),
        previousCompletionSha256: chain.completion ? await sha256Json(chain.completion) : null,
        startedAt: iso(now),
        hmacKeyId: this.crypt.secrets.keyId,
      }),
    );
    const stored = await this.verify(
      'erasure-pass.v1',
      ErasurePass,
      await this.immutable(
        `erasures/v1/${pass.jobId}/passes/${pass.revision}/start.json`,
        canonicalJson(pass),
      ),
    );
    if (
      stored.jobId !== pass.jobId ||
      stored.revision !== pass.revision ||
      stored.intentSha256 !== pass.intentSha256 ||
      stored.previousCompletionSha256 !== pass.previousCompletionSha256
    )
      throw new Error('Concurrent erasure mismatch');
    return stored;
  }
  async finish(chain: Chain, pass: Pass, now = Date.now()): Promise<Completion> {
    const erased = Math.max(now, Date.parse(pass.startedAt)),
      backup = Math.max(
        erased + 30 * DAY,
        chain.completion ? Date.parse(chain.completion.backupExpiresBy) : 0,
      );
    const value = await this.signed('erasure-completion.v1', {
      v: 1,
      jobId: pass.jobId,
      revision: pass.revision,
      intentSha256: await sha256Json(chain.intent),
      passSha256: await sha256Json(pass),
      erasedAt: iso(erased),
      backupExpiresBy: iso(backup),
      purgeAfter: iso(
        Math.max(
          erased + 45 * DAY,
          backup + 15 * DAY,
          chain.completion ? Date.parse(chain.completion.purgeAfter) : 0,
        ),
      ),
      hmacKeyId: this.crypt.secrets.keyId,
    });
    await this.immutable(
      `erasures/v1/${pass.jobId}/passes/${pass.revision}/complete.json`,
      canonicalJson(value),
    );
    const verified = await this.load(pass.jobId);
    if (verified.pending || verified.completion?.revision !== pass.revision)
      throw new Error('Erasure completion unavailable');
    return verified.completion;
  }
}
