import type { z } from 'zod';
import { type apiSchemas, Reflection } from '../../contracts/index.ts';
import { assertion } from '../identity/checkpoint.ts';
import type { Session } from '../identity/types.ts';
import { statement as q, DB_NOW } from '../db/core.ts';
import { iso, type RecordBase, RecordError } from './base.ts';
import { encryptedBytes } from './crypto.ts';
type Input = z.infer<typeof apiSchemas.ReflectionWrite>;
export class Reflections {
  constructor(readonly base: RecordBase) {}
  async read(session: Session, id: string, revision?: number) {
    const account = await this.base.account(session);
    const row = await q(
      this.base.db,
      `SELECT f.session_id,f.edition_id,f.current_revision,f.deleted_at,r.erased_at,r.revision,r.body_enc,r.key_version FROM reflections f JOIN reflection_revisions r ON r.reflection_id=f.id AND r.owner_id=f.owner_id AND r.revision=${revision === undefined ? 'f.current_revision' : '?'} WHERE f.owner_id=? AND f.id=?`,
      ...(revision === undefined ? [] : [revision]),
      session.subjectId,
      id,
    ).first<{
      session_id: string;
      edition_id: string;
      revision: number;
      deleted_at: number | null;
      erased_at: number | null;
      body_enc: string | null;
      key_version: number;
    }>();
    if (!row) throw new RecordError(404, 'NOT_FOUND');
    await this.base.ownedSession(session, row.session_id);
    if ((revision === undefined && row.deleted_at) || row.erased_at || !row.body_enc)
      throw new RecordError(410, 'CONTENT_UNAVAILABLE');
    const value = await this.base.opened<z.infer<typeof Reflection>>(
      session.subjectId,
      'reflection_revisions',
      'body_enc',
      `${id}:${row.revision}`,
      row.body_enc,
      Reflection,
      row.revision,
      row.key_version,
    );
    if (
      value.id !== id ||
      value.revision !== row.revision ||
      value.editionId !== row.edition_id ||
      value.sessionId !== row.session_id
    )
      throw new RecordError(503, 'KEY_UNAVAILABLE');
    await this.base.checkedSession(session, row.session_id, account.data_revision);
    return value;
  }
  async write(
    session: Session,
    sessionId: string,
    input: Input,
    key: string,
    edit?: { id: string; revision: number },
  ) {
    await this.base.ownedSession(session, sessionId);
    const edition = await q(
      this.base.db,
      "SELECT id FROM reading_editions WHERE owner_id=? AND session_id=? AND id=? AND status IN ('accepted','imported')",
      session.subjectId,
      sessionId,
      input.editionId,
    ).first();
    if (!edition) throw new RecordError(404, 'NOT_FOUND');
    const payload = { sessionId, input, edit: edit ?? null };
    const mutation = await this.base.mutation(session, key, 'reflection.write', payload);
    const replay = (resource: string) => {
      const [id, revision] = resource.split(':');
      return this.read(session, id!, Number(revision));
    };
    if (mutation.existing) return replay(mutation.existing);
    if (edit) {
      const current = await this.read(session, edit.id);
      if (current.sessionId !== sessionId || current.editionId !== input.editionId)
        throw new RecordError(404, 'NOT_FOUND');
      if (current.revision !== edit.revision)
        throw new RecordError(409, 'CONFLICT', current.revision);
      if (current.revision >= 100) throw new RecordError(409, 'CONFLICT', current.revision);
    }
    const id = edit?.id ?? crypto.randomUUID(),
      revision = (edit?.revision ?? 0) + 1;
    const value = Reflection.parse({
      id,
      sessionId,
      editionId: input.editionId,
      revision,
      text: input.text,
      stance: input.stance,
      updatedAt: iso(Date.now()),
    });
    const encrypted = await this.base.crypt.seal(
      session.subjectId,
      'reflection_revisions',
      'body_enc',
      `${id}:${revision}`,
      value,
      revision,
    );
    try {
      await this.base.atomic(
        session,
        [
          this.base.sessionGuard(session, sessionId),
          assertion(
            this.base.db,
            'EXISTS(SELECT 1 FROM accounts WHERE id=? AND recovery_ack_at IS NOT NULL AND key_version=1)',
            session.subjectId,
          ),
          assertion(
            this.base.db,
            "EXISTS(SELECT 1 FROM reading_editions WHERE owner_id=? AND session_id=? AND id=? AND status IN ('accepted','imported'))",
            session.subjectId,
            sessionId,
            input.editionId,
          ),
          ...(edit
            ? [
                assertion(
                  this.base.db,
                  'EXISTS(SELECT 1 FROM reflections WHERE owner_id=? AND id=? AND session_id=? AND edition_id=? AND current_revision=? AND deleted_at IS NULL)',
                  session.subjectId,
                  id,
                  sessionId,
                  input.editionId,
                  edit.revision,
                ),
                // No context APIs are exposed in this slice. Still refuse an edit that would leave an active dependent request unfenced.
                assertion(
                  this.base.db,
                  "NOT EXISTS(SELECT 1 FROM context_grants g JOIN generation_context gc ON gc.grant_id=g.id AND gc.owner_id=g.owner_id JOIN generation_requests r ON r.id=gc.request_id AND r.owner_id=gc.owner_id WHERE g.owner_id=? AND g.reflection_id=? AND r.state NOT IN ('published','blocked','failed','expired','cancelled'))",
                  session.subjectId,
                  id,
                ),
                q(
                  this.base.db,
                  `UPDATE context_grants SET state='revoked',revision=revision+1,updated_at=${DB_NOW} WHERE owner_id=? AND reflection_id=? AND state='allowed'`,
                  session.subjectId,
                  id,
                ),
                q(
                  this.base.db,
                  'UPDATE reflections SET current_revision=? WHERE owner_id=? AND id=?',
                  revision,
                  session.subjectId,
                  id,
                ),
              ]
            : [
                assertion(
                  this.base.db,
                  '(SELECT count(*) FROM reflections WHERE owner_id=? AND edition_id=? AND deleted_at IS NULL)<10',
                  session.subjectId,
                  input.editionId,
                ),
                q(
                  this.base.db,
                  'INSERT INTO reflections(id,owner_id,session_id,edition_id) VALUES (?,?,?,?)',
                  id,
                  session.subjectId,
                  sessionId,
                  input.editionId,
                ),
              ]),
          q(
            this.base.db,
            'INSERT INTO reflection_revisions(reflection_id,owner_id,revision,body_enc,key_version,created_at) VALUES (?,?,?,?,1,?)',
            id,
            session.subjectId,
            revision,
            encrypted,
            Date.parse(value.updatedAt),
          ),
          q(
            this.base.db,
            `UPDATE reading_sessions SET status='saved',saved_at=coalesce(saved_at,${DB_NOW}),retention_expires_at=NULL,revision=revision+1 WHERE owner_id=? AND id=?`,
            session.subjectId,
            sessionId,
          ),
          mutation.insert(`${id}:${revision}`),
        ],
        encryptedBytes(encrypted) + (edit ? 2048 : 3072),
      );
    } catch (error) {
      const retried = await this.base.mutation(session, key, 'reflection.write', payload);
      if (retried.existing) return replay(retried.existing);
      throw error;
    }
    return value;
  }
  async update(session: Session, id: string, revision: number, key: string, input: Input) {
    const current = await this.read(session, id);
    return this.write(session, current.sessionId, input, key, { id, revision });
  }
}
