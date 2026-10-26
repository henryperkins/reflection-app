import { z } from 'zod';
import { apiSchemas, Reading, Id } from '../../contracts/index.ts';
import type { Session } from '../identity/types.ts';
import { assertion } from '../identity/checkpoint.ts';
import { statement as q, DB_NOW } from '../db/core.ts';
import { availableSession, iso, type RecordBase, RecordError, type SessionRow } from './base.ts';
export const Question = z.strictObject({ v: z.literal(1), text: z.string().max(10000) });
export class ReadingRecords {
  constructor(readonly base: RecordBase) {}
  async question(owner: string, row: SessionRow) {
    if (!row.question_enc) return null;
    const value = await this.base.opened<z.infer<typeof Question>>(
      owner,
      'reading_sessions',
      'question_enc',
      row.id,
      row.question_enc,
      Question,
    );
    return value.text;
  }
  async session(session: Session, id: string) {
    const account = await this.base.account(session),
      row = await this.base.ownedSession(session, id);
    const [editions, reflections, requests] = await this.base.db.batch<Record<string, unknown>>([
      q(
        this.base.db,
        'SELECT id FROM reading_editions WHERE owner_id=? AND session_id=? ORDER BY edition_number',
        session.subjectId,
        id,
      ),
      q(
        this.base.db,
        'SELECT id FROM reflections WHERE owner_id=? AND session_id=? AND deleted_at IS NULL ORDER BY id',
        session.subjectId,
        id,
      ),
      q(
        this.base.db,
        'SELECT id AS requestId,state FROM generation_requests WHERE owner_id=? AND session_id=? ORDER BY created_at,id LIMIT 51',
        session.subjectId,
        id,
      ),
    ]);
    const result = apiSchemas.SessionRecord.parse({
      id,
      revision: row.revision,
      status: row.status,
      question: await this.question(session.subjectId, row),
      editionIds: editions!.results.map((r) => r.id),
      reflectionIds: reflections!.results.map((r) => r.id),
      savedAt: row.saved_at === null ? null : iso(row.saved_at),
      createdAt: iso(row.created_at),
      requests: requests!.results,
    });
    await this.base.checkedSession(session, id, account.data_revision);
    return result;
  }
  async reading(session: Session, id: string) {
    const account = await this.base.account(session);
    const row = await q(
      this.base.db,
      'SELECT e.*,c.state AS content_state FROM reading_editions e LEFT JOIN content_editions c ON c.hash=e.content_hash WHERE e.owner_id=? AND e.id=?',
      session.subjectId,
      id,
    ).first<{
      id: string;
      session_id: string;
      edition_number: number;
      parent_edition_id: string | null;
      status: string;
      content_state: string | null;
      body_enc: string | null;
      key_version: number;
    }>();
    if (!row) throw new RecordError(404, 'NOT_FOUND');
    await this.base.ownedSession(session, row.session_id);
    if (
      !row.body_enc ||
      !['accepted', 'imported'].includes(row.status) ||
      row.content_state === 'withdrawn'
    )
      throw new RecordError(410, 'CONTENT_UNAVAILABLE');
    const result = await this.base.opened<z.infer<typeof Reading>>(
      session.subjectId,
      'reading_editions',
      'body_enc',
      id,
      row.body_enc,
      Reading,
      1,
      row.key_version,
    );
    if (
      result.editionId !== id ||
      result.sessionId !== row.session_id ||
      result.editionNumber !== row.edition_number ||
      (result.kind === 'tarot.accepted.v1' && result.parentEditionId !== row.parent_edition_id)
    )
      throw new RecordError(503, 'KEY_UNAVAILABLE');
    try {
      await this.base.checkedSession(session, row.session_id, account.data_revision, [
        assertion(
          this.base.db,
          "EXISTS(SELECT 1 FROM reading_editions e LEFT JOIN content_editions c ON c.hash=e.content_hash WHERE e.owner_id=? AND e.id=? AND e.status IN ('accepted','imported') AND (c.state IS NULL OR c.state!='withdrawn'))",
          session.subjectId,
          id,
        ),
      ]);
    } catch (error) {
      const current = await q(
        this.base.db,
        "SELECT 1 FROM reading_editions e LEFT JOIN content_editions c ON c.hash=e.content_hash WHERE e.owner_id=? AND e.id=? AND (e.status NOT IN ('accepted','imported') OR c.state='withdrawn')",
        session.subjectId,
        id,
      ).first();
      if (current) throw new RecordError(410, 'CONTENT_UNAVAILABLE');
      throw error;
    }
    return result;
  }
  async history(session: Session, status = 'saved', limit = 20, cursor: string | null = null) {
    if (!['open', 'saved'].includes(status) || !Number.isInteger(limit) || limit < 1 || limit > 50)
      throw new RecordError(400, 'BAD_INPUT');
    const account = await this.base.account(session),
      scope = ['history', status, limit];
    const point = cursor
      ? await this.base.parseCursor(
          session,
          scope,
          cursor,
          z.strictObject({ at: z.number().int(), id: Id }),
        )
      : null;
    const rows = await q(
      this.base.db,
      `SELECT s.*, (SELECT id FROM reading_editions WHERE owner_id=s.owner_id AND session_id=s.id ORDER BY edition_number DESC LIMIT 1) AS edition_id, (SELECT id FROM generation_requests WHERE owner_id=s.owner_id AND session_id=s.id ORDER BY created_at DESC,id DESC LIMIT 1) AS request_id FROM reading_sessions s WHERE s.owner_id=? AND s.status=? AND ${availableSession}${point ? ' AND (s.created_at<? OR (s.created_at=? AND s.id<?))' : ''} ORDER BY s.created_at DESC,s.id DESC LIMIT ?`,
      session.subjectId,
      status,
      ...(point ? [point.at, point.at, point.id] : []),
      limit + 1,
    ).all<SessionRow & { edition_id: string | null; request_id: string | null }>();
    const items = [];
    for (const row of rows.results.slice(0, limit)) {
      const question = await this.question(session.subjectId, row);
      let preview = '';
      for (const char of question ?? '') {
        if (preview.length + char.length > 500) break;
        preview += char;
      }
      items.push({
        id: row.id,
        revision: row.revision,
        questionPreview: question === null ? null : preview,
        questionTruncated: question !== null && question.length > preview.length,
        createdAt: iso(row.created_at),
        savedAt: row.saved_at === null ? null : iso(row.saved_at),
        latestEditionId: row.edition_id,
        requestId: row.request_id,
        imported: false,
      });
    }
    const last = rows.results[limit - 1];
    const nextCursor =
      rows.results.length > limit && last
        ? await this.base.cursor(session, scope, { at: last.created_at, id: last.id })
        : null;
    const ids = items.map((item) => item.id);
    await this.base.checked(
      session,
      account.data_revision,
      ids.length
        ? [
            assertion(
              this.base.db,
              `(SELECT count(*) FROM reading_sessions s WHERE s.owner_id=? AND s.id IN (${ids.map(() => '?').join(',')}) AND ${availableSession})=?`,
              session.subjectId,
              ...ids,
              ids.length,
            ),
          ]
        : [],
    );
    return apiSchemas.HistoryPage.parse({ items, nextCursor });
  }
  async save(session: Session, id: string, revision: number, key: string, saved: boolean) {
    const row = await this.base.ownedSession(session, id),
      account = await this.base.account(session);
    if (!account.recovery_ack_at) throw new RecordError(403, 'FORBIDDEN');
    const mutation = await this.base.mutation(session, key, 'reading.save', {
      id,
      revision,
      saved,
    });
    if (mutation.existing) return this.session(session, id);
    if (row.revision !== revision) throw new RecordError(409, 'CONFLICT', row.revision);
    await this.base.atomic(
      session,
      [
        this.base.sessionGuard(session, id, revision),
        assertion(
          this.base.db,
          'EXISTS(SELECT 1 FROM accounts WHERE id=? AND recovery_ack_at IS NOT NULL)',
          session.subjectId,
        ),
        q(
          this.base.db,
          `UPDATE reading_sessions SET status=?,saved_at=${saved ? DB_NOW : 'NULL'},retention_expires_at=${saved ? 'NULL' : `${DB_NOW}+86400000`},revision=revision+1 WHERE owner_id=? AND id=?`,
          saved ? 'saved' : 'open',
          session.subjectId,
          id,
        ),
        mutation.insert(id),
      ],
      true,
    );
    return this.session(session, id);
  }
  async permission(session: Session, allowed: boolean, revision: number, key: string) {
    const account = await this.base.account(session),
      mutation = await this.base.mutation(session, key, 'permission', { allowed, revision });
    if (mutation.existing) return (await this.base.identity.sessions.view(session)).permission;
    if (account.permission_revision !== revision)
      throw new RecordError(409, 'CONFLICT', account.permission_revision);
    await this.base.atomic(
      session,
      [
        assertion(
          this.base.db,
          'EXISTS(SELECT 1 FROM accounts WHERE id=? AND permission_revision=?)',
          session.subjectId,
          revision,
        ),
        q(
          this.base.db,
          `INSERT INTO permission_revisions VALUES (?,?,?,'egress.v1',${DB_NOW})`,
          session.subjectId,
          revision + 1,
          Number(allowed),
        ),
        q(
          this.base.db,
          'UPDATE accounts SET permission_revision=? WHERE id=?',
          revision + 1,
          session.subjectId,
        ),
        ...(!allowed ? this.base.stopStatements(session.subjectId) : []),
        mutation.insert(String(revision + 1)),
      ],
      !allowed,
    );
    return apiSchemas.Permission.parse({
      revision: revision + 1,
      modelAllowed: allowed,
      policyVersion: 'egress.v1',
    });
  }
}
