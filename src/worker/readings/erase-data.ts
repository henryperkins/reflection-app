import type { Target } from '../recovery/ledger.ts';
import { statement as q, DB_NOW } from '../db/core.ts';
import { assertion } from '../identity/checkpoint.ts';
import type { RecordBase } from './base.ts';

export class EraseData {
  constructor(readonly base: RecordBase) {}
  async account(target: Extract<Target, { scope: 'account' }>) {
    // Defer cyclic owned references; detached cost aggregates retain no account/dispatch association.
    await this.base.db.batch([
      q(this.base.db, 'PRAGMA defer_foreign_keys=ON'),
      q(
        this.base.db,
        'UPDATE cost_reservations SET owner_id=NULL,dispatch_id=NULL WHERE owner_id=?',
        target.subjectId,
      ),
      q(this.base.db, 'DELETE FROM accounts WHERE id=?', target.subjectId),
    ]);
  }
  async reflection(job: { id: string }, target: Extract<Target, { scope: 'reflection_revision' }>) {
    const owner = target.subjectId,
      id = target.reflectionId,
      revision = target.revision;
    await this.base.db.batch([
      assertion(
        this.base.db,
        "EXISTS(SELECT 1 FROM deletion_jobs WHERE id=? AND state!='complete' AND target_enc IS NOT NULL)",
        job.id,
      ),
      assertion(
        this.base.db,
        'NOT EXISTS(SELECT 1 FROM import_items WHERE owner_id=?) AND NOT EXISTS(SELECT 1 FROM import_identities WHERE owner_id=?) AND NOT EXISTS(SELECT 1 FROM context_grants WHERE owner_id=? AND reflection_id=? AND reflection_revision=?)',
        owner,
        owner,
        owner,
        id,
        revision,
      ),
      q(this.base.db, `UPDATE accounts SET data_revision=data_revision+1 WHERE id=?`, owner),
      q(
        this.base.db,
        `UPDATE reflection_revisions SET body_enc=NULL,erased_at=coalesce(erased_at,${DB_NOW}) WHERE owner_id=? AND reflection_id=? AND revision=?`,
        owner,
        id,
        revision,
      ),
      q(
        this.base.db,
        `UPDATE reflections SET deleted_at=coalesce(deleted_at,${DB_NOW}) WHERE owner_id=? AND id=? AND current_revision=?`,
        owner,
        id,
        revision,
      ),
      q(
        this.base.db,
        `UPDATE deletion_jobs SET state='erasing',completed_at=coalesce(completed_at,${DB_NOW}) WHERE id=?`,
        job.id,
      ),
    ]);
  }
  async session(job: { id: string }, target: Extract<Target, { scope: 'session' }>) {
    const owner = target.subjectId,
      id = target.sessionId;
    const requests = 'SELECT id FROM generation_requests WHERE owner_id=? AND session_id=?';
    const reflections = 'SELECT id FROM reflections WHERE owner_id=? AND session_id=?';
    const editions = 'SELECT id FROM reading_editions WHERE owner_id=? AND session_id=?';
    // This integration creates no selected context/imports. Refuse completion if future unsupported copies exist.
    const unsupported = `NOT EXISTS(SELECT 1 FROM generation_context gc JOIN context_grants g ON g.id=gc.grant_id AND g.owner_id=gc.owner_id JOIN generation_requests r ON r.id=gc.request_id AND r.owner_id=gc.owner_id WHERE g.owner_id=? AND (g.edition_id IN (${editions}) OR g.reflection_id IN (${reflections})) AND r.session_id!=?) AND NOT EXISTS(SELECT 1 FROM import_identities WHERE owner_id=?) AND NOT EXISTS(SELECT 1 FROM import_items WHERE owner_id=?)`;
    await this.base.db.batch([
      // Completion is terminal. Check inside the atomic batch, not only at resume entry.
      assertion(
        this.base.db,
        "EXISTS(SELECT 1 FROM deletion_jobs WHERE id=? AND state!='complete' AND target_enc IS NOT NULL)",
        job.id,
      ),
      assertion(
        this.base.db,
        "NOT EXISTS(SELECT 1 FROM reading_sessions WHERE owner_id=? AND id=? AND status!='deleted')",
        owner,
        id,
      ),
      assertion(this.base.db, unsupported, owner, owner, id, owner, id, id, owner, owner),
      // Trigger accounting releases only ciphertext that this transaction actually nulls.
      q(this.base.db, `UPDATE accounts SET data_revision=data_revision+1 WHERE id=?`, owner),
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
        `UPDATE cost_reservations SET owner_id=NULL,dispatch_id=NULL WHERE owner_id=? AND dispatch_id IN (SELECT id FROM provider_dispatches WHERE owner_id=? AND request_id IN (${requests}) UNION SELECT spread_dispatch_id FROM generation_requests WHERE owner_id=? AND session_id=?)`,
        owner,
        owner,
        owner,
        id,
        owner,
        id,
      ),
    ]);
  }
}
