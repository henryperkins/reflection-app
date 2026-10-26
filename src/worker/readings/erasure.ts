import type { z } from 'zod';
import {
  apiSchemas,
  ErasureTarget,
  ErasureIntent,
  ErasurePass,
  ErasureCompletion,
  RecoveryCiphertext,
} from '../../contracts/index.ts';
import { canonicalJson, sha256Json } from '../../domain/json.ts';
import { statement as q, DB_NOW } from '../db/statements.ts';
import { assertion } from '../identity/checkpoint.ts';
import type { Session } from '../identity/types.ts';
import { iso, type RecordBase, RecordError } from './base.ts';
import { encryptedBytes } from './crypto.ts';

interface Job {
  id: string;
  owner_id: string;
  target_hmac: string;
  target_enc: string | null;
  receipt_token_hash: string | null;
  state: string;
  ledger_key: string;
  created_at: number;
  completed_at: number | null;
  backup_expires_by: number | null;
}
type Target = Extract<z.infer<typeof ErasureTarget>, { scope: 'session' }>;
const DAY = 86400000;
export class SessionErasure {
  constructor(
    readonly base: RecordBase,
    readonly bucket: R2Bucket,
  ) {}
  private token(id: string, value: string) {
    return this.base.identity.crypt.hash('erasure-receipt.v1', [id, value]);
  }
  private async targetHash(target: Target) {
    return this.base.identity.crypt.hash('erasure-target.v1', target);
  }
  private async subjectHash(owner: string) {
    return this.base.identity.crypt.hash('erasure-subject.v1', owner);
  }
  private async mac(kind: string, value: unknown) {
    return this.base.identity.crypt.hash(kind, [
      this.base.identity.crypt.secrets.environment,
      value,
    ]);
  }
  private async signed<T extends object>(kind: string, value: T) {
    return { ...value, operationMac: await this.mac(kind, value) };
  }
  private async verified<T extends { operationMac: string }>(
    kind: string,
    schema: z.ZodType<T>,
    raw: string,
  ) {
    const result = schema.parse(JSON.parse(raw));
    const { operationMac, ...rest } = result;
    if (
      raw.length > 16384 ||
      operationMac !== (await this.mac(kind, rest)) ||
      canonicalJson(result) !== raw
    )
      throw new Error('Invalid erasure ledger');
    return result;
  }
  private aad(job: Pick<Job, 'id' | 'target_hmac' | 'created_at'>, subjectHmac: string) {
    const secrets = this.base.identity.crypt.secrets;
    return [
      secrets.environment,
      'erasure-target.v1',
      job.id,
      'session',
      subjectHmac,
      job.target_hmac,
      secrets.keyId,
      iso(job.created_at),
      secrets.keyId,
    ];
  }
  private async putExact(key: string, raw: string) {
    const result = await this.bucket.put(key, raw, { onlyIf: { etagDoesNotMatch: '*' } });
    if (!result && (await (await this.bucket.get(key))?.text()) !== raw)
      throw new Error('Erasure ledger conflict');
  }
  private async immutable(key: string, proposed: string) {
    const existing = await this.bucket.get(key);
    if (existing) return existing.text();
    const written = await this.bucket.put(key, proposed, { onlyIf: { etagDoesNotMatch: '*' } });
    if (written) return proposed;
    const raced = await this.bucket.get(key);
    if (!raced) throw new Error('Erasure ledger unavailable');
    return raced.text();
  }
  private async job(id: string) {
    return q(this.base.db, 'SELECT * FROM deletion_jobs WHERE id=?', id).first<Job>();
  }
  async remove(
    session: Session,
    id: string,
    revision: number,
    key: string,
    receipt: z.infer<typeof apiSchemas.DeleteRequest>,
  ) {
    const target: Target = { scope: 'session', subjectId: session.subjectId, sessionId: id };
    const existing = await this.job(receipt.receiptId),
      hash = await this.token(receipt.receiptId, receipt.receiptToken);
    if (existing) {
      if (
        existing.owner_id !== session.subjectId ||
        existing.receipt_token_hash !== hash ||
        existing.target_hmac !== (await this.targetHash(target))
      )
        throw new RecordError(404, 'NOT_FOUND');
      await this.resume(existing.id);
    } else {
      const row = await this.base.ownedSession(session, id);
      if (row.revision !== revision) throw new RecordError(409, 'CONFLICT', row.revision);
      const mutation = await this.base.mutation(session, key, 'session.delete', {
        id,
        revision,
        receipt,
      });
      if (mutation.existing && mutation.existing !== receipt.receiptId)
        throw new RecordError(409, 'IDEMPOTENCY_MISMATCH');
      await this.queue(
        target,
        receipt.receiptId,
        hash,
        session,
        revision,
        mutation.insert(receipt.receiptId),
      );
      await this.resume(receipt.receiptId);
    }
    const current = (await this.job(receipt.receiptId))!;
    await this.base.checked(session);
    return apiSchemas.DeletionReceipt.parse({
      receiptId: current.id,
      receiptToken: receipt.receiptToken,
      state: current.state,
      backupExpiresBy: current.backup_expires_by === null ? null : iso(current.backup_expires_by),
    });
  }
  private async queue(
    target: Target,
    id: string,
    receiptHash: string | null,
    session?: Session,
    revision?: number,
    mutation?: D1PreparedStatement,
  ) {
    const now = Date.now(),
      subjectHmac = await this.subjectHash(target.subjectId),
      targetHmac = await this.targetHash(target);
    const encrypted = await this.base.identity.crypt.seal(
      target,
      this.aad({ id, target_hmac: targetHmac, created_at: now }, subjectHmac),
      this.base.identity.crypt.secrets.recoveryKey,
    );
    const statements = [
      ...(session
        ? [
            this.base.identity.sessions.guard(session),
            this.base.sessionGuard(session, target.sessionId, revision),
          ]
        : [
            assertion(
              this.base.db,
              `EXISTS(SELECT 1 FROM reading_sessions WHERE owner_id=? AND id=? AND status='open' AND retention_expires_at<=${DB_NOW})`,
              target.subjectId,
              target.sessionId,
            ),
          ]),
      ...this.base.stopStatements(target.subjectId, target.sessionId),
      q(
        this.base.db,
        `UPDATE reading_sessions SET status='deleted',saved_at=NULL,deleted_at=${DB_NOW},retention_expires_at=NULL,revision=revision+1 WHERE owner_id=? AND id=?`,
        target.subjectId,
        target.sessionId,
      ),
      q(
        this.base.db,
        `INSERT INTO deletion_jobs(id,owner_id,scope,target_hmac,target_enc,receipt_token_hash,state,ledger_key,next_run_at,created_at) VALUES (?,?,'session',?,?,?,'ledger_pending',?,${DB_NOW},?)`,
        id,
        target.subjectId,
        targetHmac,
        encrypted,
        receiptHash,
        `erasures/v1/${id}/intent.json`,
        now,
      ),
      ...(mutation ? [mutation] : []),
      q(
        this.base.db,
        `UPDATE accounts SET data_revision=data_revision+1,storage_bytes=storage_bytes+?,updated_at=${DB_NOW} WHERE id=?`,
        encryptedBytes(encrypted) + (mutation ? 2048 : 1024),
        target.subjectId,
      ),
    ];
    await this.base.db.batch(statements);
  }
  async resume(id: string) {
    const job = await this.job(id);
    if (!job || job.state === 'complete') return;
    try {
      if (!job.target_enc) throw new Error('Missing erasure target');
      const subjectHmac = await this.subjectHash(job.owner_id);
      const target = ErasureTarget.parse(
        await this.base.identity.crypt.open(
          job.target_enc,
          this.aad(job, subjectHmac),
          this.base.identity.crypt.secrets.recoveryKey,
        ),
      );
      if (
        target.scope !== 'session' ||
        target.subjectId !== job.owner_id ||
        (await this.targetHash(target)) !== job.target_hmac
      )
        throw new Error('Erasure identity mismatch');
      const intent = ErasureIntent.parse(
        await this.signed('erasure-intent.v1', {
          v: 1 as const,
          jobId: job.id,
          scope: 'session' as const,
          subjectHmac,
          targetHmac: job.target_hmac,
          hmacKeyId: this.base.identity.crypt.secrets.keyId,
          target: RecoveryCiphertext.parse(JSON.parse(job.target_enc)),
          receiptTokenHmac: job.receipt_token_hash,
          requestedAt: iso(job.created_at),
        }),
      );
      await this.putExact(job.ledger_key, canonicalJson(intent));
      const intentSha256 = await sha256Json(intent),
        prefix = `erasures/v1/${job.id}/passes/1`;
      const pass = await this.verified(
        'erasure-pass.v1',
        ErasurePass,
        await this.immutable(
          `${prefix}/start.json`,
          canonicalJson(
            await this.signed('erasure-pass.v1', {
              v: 1,
              jobId: job.id,
              revision: 1,
              intentSha256,
              previousCompletionSha256: null,
              startedAt: iso(Date.now()),
              hmacKeyId: this.base.identity.crypt.secrets.keyId,
            }),
          ),
        ),
      );
      if (
        pass.jobId !== job.id ||
        pass.revision !== 1 ||
        pass.intentSha256 !== intentSha256 ||
        pass.previousCompletionSha256 !== null
      )
        throw new Error('Invalid erasure pass');
      await this.erase(job, target);
      const erased = (await this.job(job.id))!,
        erasedAt = erased.completed_at!;
      const completion = await this.verified(
        'erasure-completion.v1',
        ErasureCompletion,
        await this.immutable(
          `${prefix}/complete.json`,
          canonicalJson(
            await this.signed('erasure-completion.v1', {
              v: 1,
              jobId: job.id,
              revision: 1,
              passSha256: await sha256Json(pass),
              erasedAt: iso(erasedAt),
              backupExpiresBy: iso(erasedAt + 30 * DAY),
              purgeAfter: iso(erasedAt + 45 * DAY),
              intentSha256,
              hmacKeyId: this.base.identity.crypt.secrets.keyId,
            }),
          ),
        ),
      );
      if (
        completion.jobId !== job.id ||
        completion.intentSha256 !== intentSha256 ||
        completion.passSha256 !== (await sha256Json(pass)) ||
        completion.revision !== 1 ||
        Date.parse(completion.backupExpiresBy) < erasedAt + 30 * DAY ||
        Date.parse(completion.purgeAfter) < erasedAt + 45 * DAY
      )
        throw new Error('Invalid erasure completion');
      await this.base.db.batch([
        q(
          this.base.db,
          'UPDATE accounts SET storage_bytes=max(0,storage_bytes-CASE WHEN (SELECT target_enc FROM deletion_jobs WHERE id=?) IS NOT NULL THEN ? ELSE 0 END) WHERE id=?',
          job.id,
          encryptedBytes(job.target_enc),
          job.owner_id,
        ),
        q(
          this.base.db,
          "UPDATE deletion_jobs SET state='complete',target_enc=NULL,backup_expires_by=? WHERE id=?",
          Date.parse(completion.backupExpiresBy),
          job.id,
        ),
      ]);
    } catch (error) {
      await q(
        this.base.db,
        `UPDATE deletion_jobs SET attempts=attempts+1,next_run_at=${DB_NOW}+60000 WHERE id=? AND state!='complete'`,
        job.id,
      ).run();
      throw error;
    }
  }
  private async erase(job: Job, target: Target) {
    const owner = target.subjectId,
      id = target.sessionId;
    const requests = 'SELECT id FROM generation_requests WHERE owner_id=? AND session_id=?';
    const reflections = 'SELECT id FROM reflections WHERE owner_id=? AND session_id=?';
    const editions = 'SELECT id FROM reading_editions WHERE owner_id=? AND session_id=?';
    // This integration creates no selected context/imports. Refuse completion if future unsupported copies exist.
    const unsupported = `NOT EXISTS(SELECT 1 FROM generation_context gc JOIN context_grants g ON g.id=gc.grant_id AND g.owner_id=gc.owner_id JOIN generation_requests r ON r.id=gc.request_id AND r.owner_id=gc.owner_id WHERE g.owner_id=? AND (g.edition_id IN (${editions}) OR g.reflection_id IN (${reflections})) AND r.session_id!=?) AND NOT EXISTS(SELECT 1 FROM import_identities WHERE owner_id=?) AND NOT EXISTS(SELECT 1 FROM import_items WHERE owner_id=?)`;
    const fields: Array<[string, string[], string]> = [
      ['reading_sessions', ['question_enc'], 'id=?'],
      ['basis_snapshots', ['body_enc'], 'session_id=?'],
      ['reading_editions', ['body_enc'], 'session_id=?'],
      ['generation_requests', ['input_enc', 'plan_enc'], 'session_id=?'],
      [
        'provider_dispatches',
        ['transmission_enc', 'candidate_enc', 'provider_response_id_enc'],
        `request_id IN (${requests})`,
      ],
      ['reflection_revisions', ['body_enc'], `reflection_id IN (${reflections})`],
      ['generation_context', ['fragment_enc'], `request_id IN (${requests})`],
      ['revisits', ['note_enc'], `edition_id IN (${editions})`],
    ];
    const totals = await this.base.db.batch<{ bytes: number }>(
      fields.map(([table, columns, filter]) =>
        q(
          this.base.db,
          `SELECT coalesce(sum(${columns.map((column) => `coalesce(length(CAST(${column} AS BLOB)),0)`).join('+')}),0) AS bytes FROM ${table} WHERE owner_id=? AND ${filter}`,
          owner,
          ...(filter.includes('SELECT') ? [owner, id] : [id]),
        ),
      ),
    );
    const bytes = totals.reduce((sum, result) => sum + (result.results[0]?.bytes ?? 0), 0);
    await this.base.db.batch([
      assertion(
        this.base.db,
        "EXISTS(SELECT 1 FROM reading_sessions WHERE owner_id=? AND id=? AND status='deleted')",
        owner,
        id,
      ),
      assertion(this.base.db, unsupported, owner, owner, id, owner, id, id, owner, owner),
      // Serialize concurrent resume calls: only the first erasure decrements private-byte accounting.
      q(
        this.base.db,
        `UPDATE accounts SET storage_bytes=max(0,storage_bytes-CASE WHEN (SELECT completed_at FROM deletion_jobs WHERE id=?) IS NULL THEN ? ELSE 0 END),data_revision=data_revision+1 WHERE id=?`,
        job.id,
        bytes,
        owner,
      ),
      q(
        this.base.db,
        `UPDATE deletion_jobs SET state='erasing',completed_at=coalesce(completed_at,${DB_NOW}) WHERE id=?`,
        job.id,
      ),
      q(
        this.base.db,
        'UPDATE reading_sessions SET question_enc=NULL WHERE owner_id=? AND id=?',
        owner,
        id,
      ),
      q(
        this.base.db,
        'UPDATE basis_snapshots SET body_enc=NULL WHERE owner_id=? AND session_id=?',
        owner,
        id,
      ),
      q(
        this.base.db,
        `UPDATE reading_editions SET body_enc=NULL,status='deleted',invalidated_at=coalesce(invalidated_at,${DB_NOW}) WHERE owner_id=? AND session_id=?`,
        owner,
        id,
      ),
      q(
        this.base.db,
        'UPDATE generation_requests SET input_enc=NULL,plan_enc=NULL WHERE owner_id=? AND session_id=?',
        owner,
        id,
      ),
      q(
        this.base.db,
        `UPDATE provider_dispatches SET transmission_enc=NULL,candidate_enc=NULL,provider_response_id_enc=NULL WHERE owner_id=? AND request_id IN (${requests})`,
        owner,
        owner,
        id,
      ),
      q(
        this.base.db,
        `UPDATE generation_context SET fragment_enc=NULL WHERE owner_id=? AND request_id IN (${requests})`,
        owner,
        owner,
        id,
      ),
      q(
        this.base.db,
        `UPDATE reflection_revisions SET body_enc=NULL,erased_at=coalesce(erased_at,${DB_NOW}) WHERE owner_id=? AND reflection_id IN (${reflections})`,
        owner,
        owner,
        id,
      ),
      q(
        this.base.db,
        `UPDATE reflections SET deleted_at=coalesce(deleted_at,${DB_NOW}) WHERE owner_id=? AND session_id=?`,
        owner,
        id,
      ),
      q(
        this.base.db,
        `UPDATE context_grants SET state='revoked',revision=revision+1,updated_at=${DB_NOW} WHERE owner_id=? AND (edition_id IN (${editions}) OR reflection_id IN (${reflections})) AND state='allowed'`,
        owner,
        owner,
        id,
        owner,
        id,
      ),
      q(
        this.base.db,
        `DELETE FROM revisits WHERE owner_id=? AND edition_id IN (${editions})`,
        owner,
        owner,
        id,
      ),
      q(
        this.base.db,
        `UPDATE cost_reservations SET owner_id=NULL,dispatch_id=NULL WHERE owner_id=? AND dispatch_id IN (SELECT id FROM provider_dispatches WHERE owner_id=? AND request_id IN (${requests}))`,
        owner,
        owner,
        owner,
        id,
      ),
    ]);
  }
  async status(id: string, token: string | null) {
    const job = await this.job(id);
    if (
      !job ||
      !token ||
      token.length !== 43 ||
      job.receipt_token_hash !== (await this.token(id, token))
    )
      throw new RecordError(404, 'NOT_FOUND');
    if (!(await this.bucket.head(job.ledger_key)))
      throw new RecordError(503, 'DEPENDENCY_UNAVAILABLE');
    return apiSchemas.DeletionStatus.parse({
      state: job.state,
      backupExpiresBy: job.backup_expires_by === null ? null : iso(job.backup_expires_by),
    });
  }
  async maintenance() {
    const expired = await q(
      this.base.db,
      `SELECT id,owner_id FROM reading_sessions WHERE status='open' AND retention_expires_at<=${DB_NOW} ORDER BY retention_expires_at LIMIT 20`,
    ).all<{ id: string; owner_id: string }>();
    for (const row of expired.results) {
      try {
        await this.queue(
          { scope: 'session', subjectId: row.owner_id, sessionId: row.id },
          crypto.randomUUID(),
          null,
        );
      } catch {
        /* Another maintenance pass may have already fenced this row. */
      }
    }
    const jobs = await q(
      this.base.db,
      `SELECT id FROM deletion_jobs WHERE scope='session' AND state!='complete' AND next_run_at<=${DB_NOW} ORDER BY next_run_at LIMIT 20`,
    ).all<{ id: string }>();
    for (const row of jobs.results) {
      try {
        await this.resume(row.id);
      } catch {
        /* Pending remains fenced; no private error is logged. */
      }
    }
  }
}
