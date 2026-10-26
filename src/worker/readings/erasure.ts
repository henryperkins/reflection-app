import type { z } from 'zod';
import { apiSchemas } from '../../contracts/index.ts';
import { canonicalJson } from '../../domain/json.ts';
import { statement as q, DB_NOW } from '../db/core.ts';
import { assertion } from '../identity/checkpoint.ts';
import type { IdentityCrypto } from '../identity/crypto.ts';
import type { Session } from '../identity/types.ts';
import {
  ErasureLedger,
  objects,
  type Intent,
  type Target,
  type Completion,
} from '../recovery/ledger.ts';
import { iso, type RecordBase, RecordError } from './base.ts';
import { encryptedBytes } from './crypto.ts';
import { EraseData } from './erase-data.ts';

interface Job {
  id: string;
  owner_id: string | null;
  scope: string;
  target_hmac: string;
  target_enc: string | null;
  receipt_token_hash: string | null;
  state: string;
  ledger_key: string;
  created_at: number;
  completed_at: number | null;
  backup_expires_by: number | null;
}
type Receipt = z.infer<typeof apiSchemas.DeleteRequest>;
export class SessionErasure {
  readonly ledger: ErasureLedger;
  constructor(
    readonly base: RecordBase,
    readonly bucket: R2Bucket,
    retained: IdentityCrypto[] = [],
  ) {
    this.ledger = new ErasureLedger(bucket, base.identity.crypt, retained);
  }
  private job(id: string) {
    return q(this.base.db, 'SELECT * FROM deletion_jobs WHERE id=?', id).first<Job>();
  }
  private async matches(job: Job, target: Target, receipt: Receipt) {
    return (
      job.receipt_token_hash === (await this.ledger.token(job.id, receipt.receiptToken)) &&
      job.target_hmac === (await this.ledger.targetHash(target))
    );
  }
  async remove(session: Session, id: string, revision: number, key: string, receipt: Receipt) {
    return this.removeTarget(
      session,
      { scope: 'session', subjectId: session.subjectId, sessionId: id },
      key,
      receipt,
      revision,
    );
  }
  async removeReflection(
    session: Session,
    id: string,
    targetRevision: number,
    currentRevision: number,
    key: string,
    receipt: Receipt,
  ) {
    return this.removeTarget(
      session,
      {
        scope: 'reflection_revision',
        subjectId: session.subjectId,
        reflectionId: id,
        revision: targetRevision,
      },
      key,
      receipt,
      currentRevision,
    );
  }
  async removeAccount(session: Session, key: string, receipt: Receipt) {
    if (session.authenticatedAt <= Date.now() - 300_000)
      throw new RecordError(401, 'UNAUTHENTICATED');
    return this.removeTarget(
      session,
      { scope: 'account', subjectId: session.subjectId },
      key,
      receipt,
    );
  }
  private async removeTarget(
    session: Session,
    target: Target,
    key: string,
    receipt: Receipt,
    revision?: number,
  ) {
    const existing = await this.job(receipt.receiptId);
    if (existing) {
      if (!(await this.matches(existing, target, receipt))) throw new RecordError(404, 'NOT_FOUND');
    } else {
      try {
        if (target.scope === 'session') {
          const row = await this.base.ownedSession(session, target.sessionId);
          if (row.revision !== revision) throw new RecordError(409, 'CONFLICT', row.revision);
        } else if (target.scope === 'reflection_revision') {
          const row = await q(
            this.base.db,
            'SELECT f.current_revision,f.session_id FROM reflections f JOIN reflection_revisions r ON r.owner_id=f.owner_id AND r.reflection_id=f.id AND r.revision=? WHERE f.owner_id=? AND f.id=?',
            target.revision,
            target.subjectId,
            target.reflectionId,
          ).first<{ current_revision: number; session_id: string }>();
          if (!row) throw new RecordError(404, 'NOT_FOUND');
          await this.base.ownedSession(session, row.session_id);
          if (row.current_revision !== revision)
            throw new RecordError(409, 'CONFLICT', row.current_revision);
        }
        const mutation = await this.base.mutation(session, key, `${target.scope}.delete`, {
          target,
          revision: revision ?? null,
          receipt,
        });
        if (mutation.existing && mutation.existing !== receipt.receiptId)
          throw new RecordError(409, 'IDEMPOTENCY_MISMATCH');
        await this.queue(
          target,
          receipt.receiptId,
          await this.ledger.token(receipt.receiptId, receipt.receiptToken),
          session,
          revision,
          mutation.insert(receipt.receiptId),
        );
      } catch (error) {
        const raced = await this.job(receipt.receiptId);
        if (!raced || !(await this.matches(raced, target, receipt))) throw error;
      }
    }
    await this.resume(receipt.receiptId);
    if (target.scope !== 'account') await this.base.checked(session);
    const current = (await this.job(receipt.receiptId))!;
    return apiSchemas.DeletionReceipt.parse({
      receiptId: receipt.receiptId,
      receiptToken: receipt.receiptToken,
      state: current.state,
      backupExpiresBy: current.backup_expires_by === null ? null : iso(current.backup_expires_by),
    });
  }
  private async queue(
    target: Target,
    id: string,
    hash: string | null,
    session?: Session,
    revision?: number,
    mutation?: D1PreparedStatement,
  ) {
    const intent = await this.ledger.create(target, id, hash, Date.now());
    const statements: D1PreparedStatement[] = [];
    if (session)
      statements.push(this.base.identity.sessions.guard(session, target.scope === 'account'));
    if (target.scope === 'session') {
      statements.push(
        session
          ? this.base.sessionGuard(session, target.sessionId, revision)
          : assertion(
              this.base.db,
              `EXISTS(SELECT 1 FROM reading_sessions WHERE owner_id=? AND id=? AND status='open' AND retention_expires_at<=${DB_NOW})`,
              target.subjectId,
              target.sessionId,
            ),
      );
    } else if (target.scope === 'reflection_revision') {
      statements.push(
        assertion(
          this.base.db,
          `EXISTS(SELECT 1 FROM reflections f JOIN reading_sessions s ON s.owner_id=f.owner_id AND s.id=f.session_id WHERE f.owner_id=? AND f.id=? AND f.current_revision=? AND (s.status='saved' OR (s.status='open' AND s.retention_expires_at>${DB_NOW})))`,
          target.subjectId,
          target.reflectionId,
          revision ?? null,
        ),
      );
    }
    statements.push(...this.fence(target));
    statements.push(
      q(
        this.base.db,
        `INSERT INTO deletion_jobs(id,owner_id,scope,target_hmac,target_enc,receipt_token_hash,state,ledger_key,next_run_at,created_at) VALUES (?,?,?,?,?,?,'ledger_pending',?,${DB_NOW},?)`,
        id,
        target.subjectId,
        target.scope,
        intent.targetHmac,
        canonicalJson(intent.target),
        hash,
        `erasures/v1/${id}/intent.json`,
        Date.parse(intent.requestedAt),
      ),
    );
    if (mutation) statements.push(mutation);
    statements.push(
      q(
        this.base.db,
        `UPDATE accounts SET data_revision=data_revision+1,storage_bytes=storage_bytes+?,updated_at=${DB_NOW} WHERE id=?`,
        encryptedBytes(canonicalJson(intent.target)) + (mutation ? 2048 : 1024),
        target.subjectId,
      ),
    );
    await this.base.db.batch(statements);
  }
  /** Idempotent privacy fence used both at live admission and offline replay. */
  fence(target: Target): D1PreparedStatement[] {
    const owner = target.subjectId;
    if (target.scope === 'account')
      return [
        ...this.base.stopStatements(owner),
        q(
          this.base.db,
          `UPDATE accounts SET status='deleting',write_fence='erasure',auth_epoch=auth_epoch+1,data_revision=data_revision+1 WHERE id=? AND status!='deleting'`,
          owner,
        ),
        q(this.base.db, 'DELETE FROM auth_sessions WHERE owner_id=?', owner),
        q(this.base.db, 'DELETE FROM auth_challenges WHERE owner_id=?', owner),
      ];
    if (target.scope === 'session')
      return [
        ...this.base.stopStatements(owner, target.sessionId),
        q(
          this.base.db,
          `UPDATE reading_sessions SET status='deleted',saved_at=NULL,deleted_at=coalesce(deleted_at,${DB_NOW}),retention_expires_at=NULL,revision=revision+1 WHERE owner_id=? AND id=? AND status!='deleted'`,
          owner,
          target.sessionId,
        ),
      ];
    if (target.scope === 'reflection_revision')
      return [
        ...this.base.stopStatements(owner),
        q(
          this.base.db,
          `UPDATE reflection_revisions SET erased_at=coalesce(erased_at,${DB_NOW}) WHERE owner_id=? AND reflection_id=? AND revision=?`,
          owner,
          target.reflectionId,
          target.revision,
        ),
        q(
          this.base.db,
          `UPDATE reflections SET deleted_at=coalesce(deleted_at,${DB_NOW}) WHERE owner_id=? AND id=? AND current_revision=?`,
          owner,
          target.reflectionId,
          target.revision,
        ),
      ];
    throw new Error('Unsupported erasure family');
  }
  async eraseTarget(id: string, target: Target) {
    const data = new EraseData(this.base);
    if (target.scope === 'session') await data.session({ id }, target);
    else if (target.scope === 'reflection_revision') await data.reflection({ id }, target);
    else if (target.scope === 'account') {
      await this.retireCheckpoints(target.subjectId);
      await data.account(target);
    } else throw new Error('Unsupported erasure family');
  }
  private async retireCheckpoints(owner: string) {
    const prefixes = await Promise.all(
      [...this.ledger.keys.values()].map(
        async (key) => `identity/v1/${await key.hash('identity-subject', owner)}/`,
      ),
    );
    const retire = async (key: string) => {
      if (!prefixes.some((prefix) => key.startsWith(prefix)))
        throw new Error('Checkpoint ownership/key unavailable');
      if ((await this.bucket.head(key))?.size === 0) return;
      // Empty terminal markers erase the checkpoint body without reopening its immutable key.
      // A delayed apply() uses create-only put, so it cannot restore credential/verifier bytes.
      const marker = await this.bucket.put(key, '');
      if (!marker || marker.size !== 0) throw new Error('Checkpoint retirement unavailable');
    };
    // Account fencing forbids new operations. Preserve every known writer's key before the
    // cascade removes this inventory, including a writer whose object is not visible yet.
    let cursor = '';
    for (;;) {
      const page = await q(
        this.base.db,
        'SELECT ledger_key FROM security_operations WHERE owner_id=? AND ledger_key>? ORDER BY ledger_key LIMIT 100',
        owner,
        cursor,
      ).all<{ ledger_key: string }>();
      if (!page.results.length) break;
      for (const row of page.results) await retire(row.ledger_key);
      cursor = page.results.at(-1)!.ledger_key;
    }
    for (const prefix of prefixes)
      for (const object of await objects(this.bucket, prefix)) await retire(object.key);
    // Markers must remain while delayed writers or supported backups can reference their keys.
    // General ledger/marker purge is a separate, currently disabled qualification gate.
  }
  async project(intent: Intent, target: Target, completion: Completion | null) {
    const owner = await q(
      this.base.db,
      'SELECT id FROM accounts WHERE id=?',
      target.subjectId,
    ).first<string>('id');
    await q(
      this.base.db,
      `INSERT INTO deletion_jobs(id,owner_id,scope,target_hmac,target_enc,receipt_token_hash,state,ledger_key,next_run_at,created_at,completed_at,backup_expires_by) VALUES (?,?,?,?,?,?,?,?,${DB_NOW},?,?,?) ON CONFLICT(id) DO UPDATE SET owner_id=excluded.owner_id,target_enc=excluded.target_enc,state=excluded.state,completed_at=excluded.completed_at,backup_expires_by=excluded.backup_expires_by`,
      intent.jobId,
      owner,
      intent.scope,
      intent.targetHmac,
      completion ? null : canonicalJson(intent.target),
      intent.receiptTokenHmac,
      completion ? 'complete' : 'erasing',
      `erasures/v1/${intent.jobId}/intent.json`,
      Date.parse(intent.requestedAt),
      completion ? Date.parse(completion.erasedAt) : null,
      completion ? Date.parse(completion.backupExpiresBy) : null,
    ).run();
  }
  async resume(id: string) {
    const job = await this.job(id);
    if (!job || job.state === 'complete') return;
    try {
      const existing = await this.bucket.get(job.ledger_key);
      if (!existing) await this.ledger.putIntent(await this.ledger.fromPending(job));
      const chain = await this.ledger.load(id);
      if (chain.completion && !chain.pending) {
        await this.project(chain.intent, chain.target, chain.completion);
        return;
      }
      const pass = await this.ledger.begin(chain);
      if (chain.target.scope === 'account') {
        const children = await q(
          this.base.db,
          "SELECT id FROM deletion_jobs WHERE owner_id=? AND id!=? AND state!='complete'",
          chain.target.subjectId,
          id,
        ).all<{ id: string }>();
        for (const child of children.results) await this.resume(child.id);
      }
      await this.eraseTarget(id, chain.target);
      const erased = (await this.job(id))!;
      const completion = await this.ledger.finish(chain, pass, erased.completed_at ?? Date.now());
      await this.base.db.batch([
        q(
          this.base.db,
          'UPDATE accounts SET storage_bytes=max(0,storage_bytes-CASE WHEN (SELECT target_enc FROM deletion_jobs WHERE id=?) IS NOT NULL THEN ? ELSE 0 END) WHERE id=?',
          id,
          encryptedBytes(job.target_enc),
          chain.target.subjectId,
        ),
        q(
          this.base.db,
          "UPDATE deletion_jobs SET state='complete',target_enc=NULL,completed_at=?,backup_expires_by=? WHERE id=?",
          Date.parse(completion.erasedAt),
          Date.parse(completion.backupExpiresBy),
          id,
        ),
      ]);
    } catch (error) {
      if ((await this.job(id))?.state === 'complete') return;
      await q(
        this.base.db,
        `UPDATE deletion_jobs SET attempts=attempts+1,next_run_at=${DB_NOW}+60000 WHERE id=? AND state!='complete'`,
        id,
      ).run();
      throw error;
    }
  }
  async status(id: string, token: string | null) {
    const job = await this.job(id);
    if (token?.length !== 43) throw new RecordError(404, 'NOT_FOUND');
    if (job && job.receipt_token_hash !== (await this.ledger.token(id, token)))
      throw new RecordError(404, 'NOT_FOUND');
    if (!(await this.bucket.head(`erasures/v1/${id}/intent.json`)))
      throw new RecordError(job ? 503 : 404, job ? 'DEPENDENCY_UNAVAILABLE' : 'NOT_FOUND');
    const chain = await this.ledger.load(id);
    if (
      chain.intent.receiptTokenHmac !==
      (await this.ledger.token(id, token, this.ledger.key(chain.intent.hmacKeyId)))
    )
      throw new RecordError(404, 'NOT_FOUND');
    return apiSchemas.DeletionStatus.parse({
      state: chain.pending ? 'erasing' : chain.completion ? 'complete' : 'ledger_pending',
      backupExpiresBy: chain.pending ? null : (chain.completion?.backupExpiresBy ?? null),
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
        /* Concurrent maintenance may already have fenced it. */
      }
    }
    const jobs = await q(
      this.base.db,
      `SELECT id FROM deletion_jobs WHERE state!='complete' AND next_run_at<=${DB_NOW} ORDER BY next_run_at LIMIT 20`,
    ).all<{ id: string }>();
    for (const row of jobs.results) {
      try {
        await this.resume(row.id);
      } catch {
        /* Remains fenced for retry; no private error logging. */
      }
    }
  }
}
