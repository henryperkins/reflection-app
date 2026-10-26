import { z } from 'zod';
import { apiSchemas, Reading, Reflection, Id, type PortableRecord } from '../../contracts/index.ts';
import { statement as q, DB_NOW } from '../db/core.ts';
import { assertion } from '../identity/checkpoint.ts';
import type { Session } from '../identity/types.ts';
import { iso, availableSession, type RecordBase, RecordError } from './base.ts';
import { Question } from './records.ts';

const Point = z.strictObject({
  kind: z.enum(['session', 'reading', 'reflection', 'generation_receipt', 'permission']),
  id: Id,
  revision: z.number().int().positive(),
});
type Row = z.infer<typeof Point> & {
  session_id: string | null;
  value_enc: string | null;
  key_version: number;
  metadata: string;
};
type Ticket = { id: string; snapshot_revision: number; created_at: number; expires_at: number };
const utf8 = new TextEncoder();

/** Export only persisted families this local slice can create; unsupported families fail closed. */
export class ReadingExports {
  constructor(readonly base: RecordBase) {}
  async create(session: Session, key: string) {
    if (session.authenticatedAt <= Date.now() - 300_000)
      throw new RecordError(401, 'UNAUTHENTICATED');
    const mutation = await this.base.mutation(session, key, 'export.create', {});
    const id = mutation.existing ?? crypto.randomUUID();
    if (!mutation.existing) {
      await this.base.identity.rate('export', session.subjectId, 2, 3_600_000);
      await this.base.db.batch([
        this.base.identity.sessions.guard(session, true),
        q(
          this.base.db,
          // Time alone can remove an unsaved record without advancing data_revision. Bind every
          // page to the earliest retention boundary in the entire snapshot, including later pages.
          `INSERT INTO export_tickets SELECT ?,id,data_revision,${DB_NOW},min(${DB_NOW}+3600000,
            coalesce((SELECT min(retention_expires_at) FROM reading_sessions WHERE owner_id=accounts.id
              AND status='open' AND retention_expires_at>${DB_NOW}),${DB_NOW}+3600000)) FROM accounts WHERE id=?`,
          id,
          session.subjectId,
        ),
        mutation.insert(id),
      ]);
    }
    const ticket = await this.ticket(session, id);
    return apiSchemas.ExportTicket.parse({
      id,
      snapshotRevision: ticket.snapshot_revision,
      expiresAt: iso(ticket.expires_at),
    });
  }
  private async ticket(session: Session, id: string): Promise<Ticket> {
    const row = await q(
      this.base.db,
      `SELECT t.*,a.data_revision,(${DB_NOW}<t.expires_at) AS valid FROM export_tickets t JOIN accounts a ON a.id=t.owner_id WHERE t.owner_id=? AND t.id=?`,
      session.subjectId,
      id,
    ).first<Ticket & { data_revision: number; valid: number }>();
    if (!row) throw new RecordError(404, 'NOT_FOUND');
    if (!row.valid) {
      if (row.expires_at < row.created_at + 3_600_000) throw new RecordError(409, 'EXPORT_CHANGED');
      throw new RecordError(410, 'EXPIRED');
    }
    if (row.snapshot_revision !== row.data_revision) throw new RecordError(409, 'EXPORT_CHANGED');
    return row;
  }
  private guard(session: Session, ticket: Ticket) {
    return assertion(
      this.base.db,
      `EXISTS(SELECT 1 FROM export_tickets t JOIN accounts a ON a.id=t.owner_id WHERE t.owner_id=? AND t.id=? AND a.data_revision=t.snapshot_revision AND t.snapshot_revision=? AND t.expires_at>${DB_NOW})`,
      session.subjectId,
      ticket.id,
      ticket.snapshot_revision,
    );
  }
  private async guardedBatch<T>(
    session: Session,
    ticket: Ticket,
    statements: D1PreparedStatement[],
  ) {
    try {
      return await this.base.db.batch<T>(statements);
    } catch (error) {
      // Classify a snapshot race using current authoritative state, without releasing any page.
      if (!(error instanceof Error) || !/CHECK constraint/.test(error.message)) throw error;
      try {
        await this.base.checked(session);
      } catch {
        throw new RecordError(401, 'UNAUTHENTICATED');
      }
      await this.ticket(session, ticket.id);
      throw new RecordError(409, 'EXPORT_CHANGED');
    }
  }
  async page(session: Session, id: string, cursor: string | null) {
    const ticket = await this.ticket(session, id),
      scope = ['export', id, ticket.snapshot_revision];
    const point = cursor ? await this.base.parseCursor(session, scope, cursor, Point) : null;
    // Avoid silently omitting later feature families if someone bypasses the disabled import/context routes.
    const unsupported = await q(
      this.base.db,
      'SELECT 1 WHERE EXISTS(SELECT 1 FROM revisits WHERE owner_id=?) OR EXISTS(SELECT 1 FROM context_grants WHERE owner_id=?) OR EXISTS(SELECT 1 FROM import_identities WHERE owner_id=?)',
      session.subjectId,
      session.subjectId,
      session.subjectId,
    ).first();
    if (unsupported) throw new RecordError(503, 'DEPENDENCY_UNAVAILABLE');
    const sql = `SELECT * FROM (
      SELECT 'session' AS kind,s.id,s.revision,s.id AS session_id,s.question_enc AS value_enc,1 AS key_version,
        json_object('status',s.status,'savedAt',s.saved_at,'createdAt',s.created_at,
          'editionIds',(SELECT json_group_array(id) FROM reading_editions WHERE owner_id=s.owner_id AND session_id=s.id),
          'reflectionIds',(SELECT json_group_array(id) FROM reflections WHERE owner_id=s.owner_id AND session_id=s.id AND deleted_at IS NULL),
          'requests',(SELECT json_group_array(json_object('requestId',id,'state',state)) FROM generation_requests WHERE owner_id=s.owner_id AND session_id=s.id)) AS metadata
      FROM reading_sessions s WHERE s.owner_id=? AND ${availableSession}
      UNION ALL
      SELECT 'reading',e.id,e.edition_number,e.session_id,e.body_enc,e.key_version,
        json_object('status',e.status,'contentState',c.state,'parentEditionId',e.parent_edition_id,'unavailableAt',coalesce(e.invalidated_at,c.withdrawn_at,e.accepted_at))
      FROM reading_editions e JOIN reading_sessions s ON s.id=e.session_id AND s.owner_id=e.owner_id LEFT JOIN content_editions c ON c.hash=e.content_hash WHERE e.owner_id=? AND ${availableSession}
      UNION ALL
      SELECT 'reflection',f.id,r.revision,f.session_id,r.body_enc,r.key_version,json_object('editionId',f.edition_id)
      FROM reflection_revisions r JOIN reflections f ON f.id=r.reflection_id AND f.owner_id=r.owner_id JOIN reading_sessions s ON s.id=f.session_id AND s.owner_id=f.owner_id WHERE f.owner_id=? AND r.erased_at IS NULL AND ${availableSession}
      UNION ALL
      SELECT 'generation_receipt',r.id,r.revision,r.session_id,d.transmission_enc,r.key_version,
        json_object('state',r.state,'createdAt',r.created_at,'dispatchId',d.id,'inputTokens',d.input_tokens,'outputTokens',d.output_tokens)
      FROM generation_requests r JOIN reading_sessions s ON s.id=r.session_id AND s.owner_id=r.owner_id LEFT JOIN provider_dispatches d ON d.request_id=r.id AND d.owner_id=r.owner_id WHERE r.owner_id=? AND ${availableSession}
      UNION ALL
      SELECT 'permission',p.owner_id,p.revision,NULL,NULL,1,json_object('allowed',p.model_allowed)
      FROM permission_revisions p WHERE p.owner_id=?
    ) WHERE ${point ? '(kind,id,revision)>(?,?,?)' : '1'} ORDER BY kind,id,revision LIMIT 101`;
    const batch = await this.guardedBatch<Row>(session, ticket, [
      this.base.identity.sessions.guard(session, false, false),
      this.guard(session, ticket),
      q(
        this.base.db,
        sql,
        ...Array<string>(5).fill(session.subjectId),
        ...(point ? [point.kind, point.id, point.revision] : []),
      ),
    ]);
    const rows = batch[2]!.results,
      records: z.infer<typeof PortableRecord>[] = [];
    let length = 0,
      last: Row | undefined;
    for (const row of rows.slice(0, 100)) {
      const value = await this.value(session, row);
      const record = {
        kind: row.kind,
        identity: {
          source: {
            namespaceId: session.subjectId,
            revision: `snapshot-${ticket.snapshot_revision}`,
          },
          kind: row.kind,
          recordId: row.id,
          recordRevision: row.revision,
        },
        originalId: row.id,
        value,
      };
      const size = utf8.encode(JSON.stringify(record)).length;
      if (length + size > 950_000) {
        if (!records.length) throw new RecordError(413, 'INPUT_TOO_LARGE');
        break;
      }
      records.push(record as z.infer<typeof PortableRecord>);
      length += size;
      last = row;
    }
    let account = null;
    if (!cursor) {
      const created = await q(
        this.base.db,
        'SELECT created_at FROM accounts WHERE id=?',
        session.subjectId,
      ).first<number>('created_at');
      const credentials = await q(
        this.base.db,
        'SELECT id,created_at,backed_up FROM credentials WHERE owner_id=? ORDER BY id LIMIT 10',
        session.subjectId,
      ).all<{ id: string; created_at: number; backed_up: number }>();
      account = {
        subjectId: session.subjectId,
        createdAt: iso(created!),
        credentials: credentials.results.map((c) => ({
          id: c.id,
          createdAt: iso(c.created_at),
          backedUp: Boolean(c.backed_up),
        })),
      };
    }
    const nextCursor =
      records.length < rows.length && last
        ? await this.base.cursor(session, scope, {
            kind: last.kind,
            id: last.id,
            revision: last.revision,
          })
        : null;
    const result = apiSchemas.ExportPage.parse({
      format: 'reflection-export.v1',
      exportId: id,
      snapshotRevision: ticket.snapshot_revision,
      records,
      nextCursor,
      exportedAt: iso(Date.now()),
      account,
    });
    // Validate again after decryption/serialization; never release a mixed or revoked snapshot.
    await this.ticket(session, id);
    const sessions = [
      ...new Set(
        rows
          .slice(0, records.length)
          .map((row) => row.session_id)
          .filter((id): id is string => id !== null),
      ),
    ];
    await this.guardedBatch(session, ticket, [
      this.base.identity.sessions.guard(session, false, false),
      this.guard(session, ticket),
      ...(sessions.length
        ? [
            assertion(
              this.base.db,
              `(SELECT count(*) FROM reading_sessions s WHERE s.owner_id=? AND s.id IN (${sessions.map(() => '?').join(',')}) AND ${availableSession})=?`,
              session.subjectId,
              ...sessions,
              sessions.length,
            ),
          ]
        : []),
    ]);
    return result;
  }
  private async value(session: Session, row: Row): Promise<unknown> {
    const metadata = JSON.parse(row.metadata) as Record<string, unknown>;
    const owner = session.subjectId;
    if (row.kind === 'permission')
      return {
        revision: row.revision,
        modelAllowed: Boolean(metadata.allowed),
        policyVersion: 'egress.v1',
      };
    if (row.kind === 'session') {
      const question = row.value_enc
        ? await this.base.opened<z.infer<typeof Question>>(
            owner,
            'reading_sessions',
            'question_enc',
            row.id,
            row.value_enc,
            Question,
          )
        : null;
      return {
        id: row.id,
        revision: row.revision,
        status: metadata.status,
        question: question?.text ?? null,
        editionIds: metadata.editionIds,
        reflectionIds: metadata.reflectionIds,
        savedAt: metadata.savedAt === null ? null : iso(Number(metadata.savedAt)),
        createdAt: iso(Number(metadata.createdAt)),
        requests: metadata.requests,
      };
    }
    if (row.kind === 'reading') {
      if (
        metadata.status === 'withdrawn' ||
        metadata.status === 'deleted' ||
        metadata.contentState === 'withdrawn' ||
        !row.value_enc
      )
        return {
          kind: 'reading.unavailable.v1',
          editionId: row.id,
          sessionId: row.session_id,
          editionNumber: row.revision,
          parentEditionId: metadata.parentEditionId,
          reason: 'content_withdrawn',
          unavailableAt: iso(Number(metadata.unavailableAt)),
        };
      const value = await this.base.opened<z.infer<typeof Reading>>(
        owner,
        'reading_editions',
        'body_enc',
        row.id,
        row.value_enc,
        Reading,
        1,
        row.key_version,
      );
      if (
        value.editionId !== row.id ||
        value.sessionId !== row.session_id ||
        value.editionNumber !== row.revision
      )
        throw new RecordError(503, 'KEY_UNAVAILABLE');
      return value;
    }
    if (row.kind === 'reflection') {
      if (!row.value_enc) throw new RecordError(503, 'KEY_UNAVAILABLE');
      const value = await this.base.opened<z.infer<typeof Reflection>>(
        owner,
        'reflection_revisions',
        'body_enc',
        `${row.id}:${row.revision}`,
        row.value_enc,
        Reflection,
        row.revision,
        row.key_version,
      );
      if (
        value.id !== row.id ||
        value.revision !== row.revision ||
        value.sessionId !== row.session_id ||
        value.editionId !== metadata.editionId
      )
        throw new RecordError(503, 'KEY_UNAVAILABLE');
      return value;
    }
    const transmission = row.value_enc
      ? await this.base.opened<{ v: 1; syntheticOnly: true; payload: string }>(
          owner,
          'provider_dispatches',
          'transmission_enc',
          String(metadata.dispatchId),
          row.value_enc,
          z.strictObject({
            v: z.literal(1),
            syntheticOnly: z.literal(true),
            payload: z.string().max(200000),
          }),
          1,
          row.key_version,
        )
      : null;
    return {
      requestId: row.id,
      state: metadata.state,
      createdAt: iso(Number(metadata.createdAt)),
      inputTokens: metadata.inputTokens,
      outputTokens: metadata.outputTokens,
      actualCostMicroUsd: null,
      costState: 'none',
      transmission: transmission?.payload ?? null,
      reproduction: transmission ? 'complete' : 'redacted',
    };
  }
}
