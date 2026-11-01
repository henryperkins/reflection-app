import { z } from 'zod';
import {
  AnyRevisit,
  apiSchemas,
  Ciphertext,
  Id,
  RevisitV2,
  type RevisitNote,
} from '../../contracts/index.ts';
import { REVISIT_LIMITS } from '../../contracts/revisit-policy.ts';
import { assertion } from '../identity/checkpoint.ts';
import type { Session } from '../identity/types.ts';
import { statement as q } from '../db/core.ts';
import { encryptedBytes } from './crypto.ts';
import { iso, type RecordBase, RecordError } from './base.ts';

type Input = z.infer<typeof apiSchemas.RevisitWrite>;
type Update = z.infer<typeof apiSchemas.RevisitUpdate>;
type Page = z.infer<typeof apiSchemas.RevisitPage>;
interface NoteRow {
  id: string;
  owner_id: string;
  edition_id: string;
  session_id: string;
  current_revision: number;
  note_enc: string | null;
  key_version: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}
const position = z.strictObject({ at: z.number().int().nonnegative(), id: Id });
const storageLimit = 20971520;

/** Authenticated authored annotations. No generation or provider dependencies. */
export class Revisits {
  constructor(readonly base: RecordBase) {}

  private field(ownerId: string, id: string, revision: number, historical = false) {
    return {
      ownerId,
      table: historical ? 'revisit_revisions' : 'revisits',
      column: historical ? 'body_enc' : 'note_enc',
      recordId: historical ? `${id}:${revision}` : id,
      aadRevision: revision,
    };
  }

  private async parent(session: Session, editionId: string, saved = false, creating = false) {
    const edition = await q(
      this.base.db,
      'SELECT e.session_id,e.status,e.body_enc,c.state AS content_state FROM reading_editions e LEFT JOIN content_editions c ON c.hash=e.content_hash WHERE e.owner_id=? AND e.id=?',
      session.subjectId,
      editionId,
    ).first<{
      session_id: string;
      status: string;
      body_enc: string | null;
      content_state: string | null;
    }>();
    if (!edition) throw new RecordError(404, 'NOT_FOUND');
    const parent = await this.base.ownedSession(session, edition.session_id);
    if (
      !['accepted', 'imported', 'withdrawn'].includes(edition.status) ||
      (creating &&
        (!['accepted', 'imported'].includes(edition.status) ||
          !edition.body_enc ||
          edition.content_state === 'withdrawn'))
    )
      throw new RecordError(410, 'CONTENT_UNAVAILABLE');
    if (saved && parent.status !== 'saved') throw new RecordError(403, 'FORBIDDEN');
    return parent;
  }

  private parentGuard(
    session: Session,
    sessionId: string,
    editionId: string,
    saved = false,
    creating = false,
  ) {
    return assertion(
      this.base.db,
      `EXISTS(SELECT 1 FROM reading_editions e JOIN reading_sessions s ON s.owner_id=e.owner_id AND s.id=e.session_id LEFT JOIN content_editions c ON c.hash=e.content_hash WHERE e.owner_id=? AND e.id=? AND s.id=? AND e.status IN (${creating ? "'accepted','imported'" : "'accepted','imported','withdrawn'"})${saved ? " AND s.status='saved'" : ''}${creating ? " AND e.body_enc IS NOT NULL AND (c.state IS NULL OR c.state!='withdrawn')" : ''})`,
      session.subjectId,
      editionId,
      sessionId,
    );
  }

  private async row(session: Session, id: string) {
    const row = await q(
      this.base.db,
      'SELECT * FROM revisits WHERE owner_id=? AND id=?',
      session.subjectId,
      id,
    ).first<NoteRow>();
    if (!row) throw new RecordError(404, 'NOT_FOUND');
    if (row.deleted_at !== null || row.note_enc === null)
      throw new RecordError(410, 'CONTENT_UNAVAILABLE');
    return row;
  }

  private async decode(
    session: Session,
    row: NoteRow,
    revision = row.current_revision,
  ): Promise<RevisitNote> {
    let body = row.note_enc,
      keyVersion = row.key_version,
      updatedAt = row.updated_at;
    const historical = revision !== row.current_revision;
    if (historical) {
      const archived = await q(
        this.base.db,
        'SELECT body_enc,key_version,created_at,erased_at FROM revisit_revisions WHERE owner_id=? AND revisit_id=? AND revision=?',
        session.subjectId,
        row.id,
        revision,
      ).first<{
        body_enc: string | null;
        key_version: number;
        created_at: number;
        erased_at: number | null;
      }>();
      if (!archived) throw new RecordError(404, 'NOT_FOUND');
      if (archived.erased_at !== null || !archived.body_enc)
        throw new RecordError(410, 'CONTENT_UNAVAILABLE');
      body = archived.body_enc;
      keyVersion = archived.key_version;
      updatedAt = archived.created_at;
    }
    try {
      const envelope = Ciphertext.parse(JSON.parse(body!));
      if (envelope.keyVersion !== keyVersion) throw new Error('Column/envelope key mismatch');
      const stored = await this.base.opened<z.infer<typeof AnyRevisit>>(
        this.field(session.subjectId, row.id, revision, historical),
        body!,
        AnyRevisit,
      );
      if (
        stored.id !== row.id ||
        stored.editionId !== row.edition_id ||
        Date.parse(stored.createdAt) !== row.created_at
      )
        throw new Error('Stored identity mismatch');
      if (!('kind' in stored)) {
        if (revision !== 1 || updatedAt !== row.created_at)
          throw new Error('Invalid legacy revision');
        return RevisitV2.parse({
          ...stored,
          kind: 'revisit.v2',
          sessionId: row.session_id,
          revision: 1,
          stance: 'unspecified',
          updatedAt: stored.createdAt,
        });
      }
      if (
        stored.sessionId !== row.session_id ||
        stored.revision !== revision ||
        Date.parse(stored.updatedAt) !== updatedAt
      )
        throw new Error('Stored revision mismatch');
      return stored;
    } catch {
      throw new RecordError(503, 'KEY_UNAVAILABLE');
    }
  }

  private async checked(
    session: Session,
    sessionId: string,
    dataRevision: number,
    guards: D1PreparedStatement[],
  ) {
    try {
      await this.base.checkedSession(session, sessionId, dataRevision, guards);
    } catch (error) {
      // Classify a recovery/logout-all race without releasing decrypted values.
      await this.base.account(session);
      throw error;
    }
  }

  async read(session: Session, id: string, revision?: number): Promise<RevisitNote> {
    if (
      revision !== undefined &&
      (!Number.isInteger(revision) || revision < 1 || revision > REVISIT_LIMITS.revisionsPerNote)
    )
      throw new RecordError(400, 'BAD_INPUT');
    const account = await this.base.account(session),
      row = await this.row(session, id);
    const parent = await this.parent(session, row.edition_id);
    if (parent.id !== row.session_id) throw new RecordError(503, 'KEY_UNAVAILABLE');
    const result = await this.decode(session, row, revision);
    await this.checked(session, row.session_id, account.data_revision, [
      this.parentGuard(session, row.session_id, row.edition_id),
      assertion(
        this.base.db,
        'EXISTS(SELECT 1 FROM revisits WHERE owner_id=? AND id=? AND deleted_at IS NULL AND current_revision=?)',
        session.subjectId,
        id,
        row.current_revision,
      ),
    ]);
    return result;
  }

  async list(
    session: Session,
    editionId: string,
    cursor: string | null,
    limit: number = REVISIT_LIMITS.pageDefault,
  ): Promise<Page> {
    if (!Number.isInteger(limit) || limit < 1 || limit > REVISIT_LIMITS.pageMax)
      throw new RecordError(400, 'BAD_INPUT');
    const account = await this.base.account(session),
      scope = ['revisits', session.epoch, editionId, 'asc'];
    const point = cursor ? await this.base.parseCursor(session, scope, cursor, position) : null;
    const parent = await this.parent(session, editionId);
    const rows = await q(
      this.base.db,
      `SELECT * FROM revisits WHERE owner_id=? AND edition_id=? AND session_id=? AND deleted_at IS NULL${point ? ' AND (created_at>? OR (created_at=? AND id>?))' : ''} ORDER BY created_at ASC,id ASC LIMIT ?`,
      session.subjectId,
      editionId,
      parent.id,
      ...(point ? [point.at, point.at, point.id] : []),
      limit + 1,
    ).all<NoteRow>();
    const selected = rows.results.slice(0, limit),
      items = [];
    for (const row of selected) {
      if (!row.note_enc) throw new RecordError(410, 'CONTENT_UNAVAILABLE');
      items.push(await this.decode(session, row));
    }
    const last = selected.at(-1);
    const nextCursor =
      rows.results.length > limit && last
        ? await this.base.cursor(session, scope, { at: last.created_at, id: last.id })
        : null;
    await this.checked(session, parent.id, account.data_revision, [
      this.parentGuard(session, parent.id, editionId),
    ]);
    return apiSchemas.RevisitPage.parse({ items, nextCursor });
  }

  private replay(session: Session, resource: string) {
    const [id, revision] = resource.split(':');
    return this.read(session, id!, Number(revision));
  }

  private async writeAccount(session: Session, expectedKey?: number) {
    const account = await this.base.account(session);
    if (!account.recovery_ack_at) throw new RecordError(403, 'FORBIDDEN');
    if (expectedKey !== undefined && account.key_version !== expectedKey)
      throw new RecordError(503, 'KEY_UNAVAILABLE');
    return account;
  }

  private async countGuard(session: Session, editionId: string) {
    const count = await q(
      this.base.db,
      'SELECT count(*) AS n FROM revisits WHERE owner_id=? AND edition_id=? AND deleted_at IS NULL',
      session.subjectId,
      editionId,
    ).first<number>('n');
    if (count! >= REVISIT_LIMITS.activePerEdition)
      throw new RecordError(409, 'NOTE_LIMIT_EXCEEDED');
  }

  private accountGuard(session: Session, keyVersion: number) {
    return assertion(
      this.base.db,
      'EXISTS(SELECT 1 FROM accounts WHERE id=? AND recovery_ack_at IS NOT NULL AND key_version=?)',
      session.subjectId,
      keyVersion,
    );
  }

  async create(session: Session, input: Input, key: string): Promise<RevisitNote> {
    const parsed = apiSchemas.RevisitWrite.safeParse(input);
    if (!parsed.success) throw new RecordError(400, 'BAD_INPUT');
    input = parsed.data;
    const account = await this.writeAccount(session);
    const mutation = await this.base.mutation(session, key, 'revisit.create', input);
    if (mutation.existing) return this.replay(session, mutation.existing);
    const parent = await this.parent(session, input.editionId, true, true);
    await this.countGuard(session, input.editionId);
    const now = Date.now(),
      id = crypto.randomUUID();
    const value = RevisitV2.parse({
      kind: 'revisit.v2',
      id,
      sessionId: parent.id,
      editionId: input.editionId,
      revision: 1,
      note: input.note,
      stance: input.stance,
      createdAt: iso(now),
      updatedAt: iso(now),
    });
    const body = await this.base.crypt.seal(
      this.field(session.subjectId, id, 1),
      value,
      account.key_version,
    );
    const additionalBytes = encryptedBytes(body) + 2048;
    try {
      await this.base.atomic(session, [
        this.base.sessionGuard(session, parent.id),
        this.parentGuard(session, parent.id, input.editionId, true, true),
        this.accountGuard(session, account.key_version),
        assertion(
          this.base.db,
          '(SELECT count(*) FROM revisits WHERE owner_id=? AND edition_id=? AND deleted_at IS NULL)<?',
          session.subjectId,
          input.editionId,
          REVISIT_LIMITS.activePerEdition,
        ),
        q(
          this.base.db,
          'INSERT INTO revisits(id,owner_id,session_id,edition_id,note_enc,key_version,created_at,updated_at,current_revision) VALUES(?,?,?,?,?,?,?,?,1)',
          id,
          session.subjectId,
          parent.id,
          input.editionId,
          body,
          account.key_version,
          now,
          now,
        ),
        mutation.insert(`${id}:1`),
      ]);
    } catch (error) {
      const retried = await this.base.mutation(session, key, 'revisit.create', input);
      if (retried.existing) return this.replay(session, retried.existing);
      const currentAccount = await this.writeAccount(session, account.key_version);
      await this.base.checked(session);
      await this.parent(session, input.editionId, true, true);
      await this.countGuard(session, input.editionId);
      if (currentAccount.storage_bytes + additionalBytes > storageLimit)
        throw new RecordError(409, 'STORAGE_LIMIT_EXCEEDED');
      throw error;
    }
    return this.read(session, id, 1);
  }

  async update(
    session: Session,
    id: string,
    revision: number,
    key: string,
    input: Update,
  ): Promise<RevisitNote> {
    const parsed = apiSchemas.RevisitUpdate.safeParse(input);
    if (!parsed.success || !Number.isInteger(revision) || revision < 1)
      throw new RecordError(400, 'BAD_INPUT');
    input = parsed.data;
    const account = await this.writeAccount(session),
      payload = { id, revision, input };
    const mutation = await this.base.mutation(session, key, 'revisit.update', payload);
    if (mutation.existing) return this.replay(session, mutation.existing);
    const row = await this.row(session, id),
      current = await this.read(session, id);
    await this.parent(session, current.editionId, true);
    if (current.revision !== revision) throw new RecordError(409, 'CONFLICT', current.revision);
    if (revision >= REVISIT_LIMITS.revisionsPerNote)
      throw new RecordError(409, 'REVISION_LIMIT_EXCEEDED', revision);
    const value = RevisitV2.parse({
      ...current,
      revision: revision + 1,
      note: input.note,
      stance: input.stance,
      updatedAt: iso(Date.now()),
    });
    const archive = await this.base.crypt.seal(
      this.field(session.subjectId, id, revision, true),
      current,
      account.key_version,
    );
    const body = await this.base.crypt.seal(
      this.field(session.subjectId, id, revision + 1),
      value,
      account.key_version,
    );
    const additionalBytes = encryptedBytes(archive, body) - encryptedBytes(row.note_enc) + 2048;
    try {
      await this.base.atomic(session, [
        this.base.sessionGuard(session, current.sessionId),
        this.parentGuard(session, current.sessionId, current.editionId, true),
        this.accountGuard(session, account.key_version),
        assertion(
          this.base.db,
          'EXISTS(SELECT 1 FROM revisits WHERE owner_id=? AND id=? AND session_id=? AND edition_id=? AND current_revision=? AND current_revision<? AND deleted_at IS NULL AND note_enc=? AND key_version=?)',
          session.subjectId,
          id,
          current.sessionId,
          current.editionId,
          revision,
          REVISIT_LIMITS.revisionsPerNote,
          row.note_enc,
          row.key_version,
        ),
        q(
          this.base.db,
          'INSERT INTO revisit_revisions(revisit_id,owner_id,revision,body_enc,key_version,created_at) VALUES(?,?,?,?,?,?)',
          id,
          session.subjectId,
          revision,
          archive,
          account.key_version,
          Date.parse(current.updatedAt),
        ),
        q(
          this.base.db,
          'UPDATE revisits SET current_revision=?,note_enc=?,key_version=?,updated_at=? WHERE owner_id=? AND id=? AND current_revision=? AND deleted_at IS NULL',
          revision + 1,
          body,
          account.key_version,
          Date.parse(value.updatedAt),
          session.subjectId,
          id,
          revision,
        ),
        assertion(this.base.db, 'changes()=1'),
        mutation.insert(`${id}:${revision + 1}`),
      ]);
    } catch (error) {
      const retried = await this.base.mutation(session, key, 'revisit.update', payload);
      if (retried.existing) return this.replay(session, retried.existing);
      const currentAccount = await this.writeAccount(session, account.key_version);
      await this.base.checked(session);
      const latest = await this.read(session, id);
      await this.parent(session, latest.editionId, true);
      if (latest.revision !== revision) throw new RecordError(409, 'CONFLICT', latest.revision);
      if (latest.revision >= REVISIT_LIMITS.revisionsPerNote)
        throw new RecordError(409, 'REVISION_LIMIT_EXCEEDED', latest.revision);
      if (currentAccount.storage_bytes + additionalBytes > storageLimit)
        throw new RecordError(409, 'STORAGE_LIMIT_EXCEEDED');
      throw error;
    }
    return this.read(session, id, revision + 1);
  }
}
