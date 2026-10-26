import { apiSchemas, type ErrorCode } from '../../contracts/index.ts';
import { assertion } from '../identity/checkpoint.ts';
import type { Session } from '../identity/types.ts';
import { DB_NOW, statement as q } from '../db/core.ts';
import { iso, type RecordBase, RecordError, terminalStates } from './base.ts';

/** Append in the same transaction as the state transition. Supports pre-watermark local rows. */
export function requestEvent(
  db: D1Database,
  owner: string,
  id: string,
  code: string,
  edition: string | null = null,
) {
  return [
    q(
      db,
      `INSERT INTO request_events(request_id,owner_id,sequence,state,code,edition_id,error_code,created_at)
      SELECT id,owner_id,max(next_event,coalesce((SELECT max(sequence)+1 FROM request_events WHERE request_id=r.id),1)),state,?,?,error_code,${DB_NOW}
      FROM generation_requests r WHERE owner_id=? AND id=?`,
      code,
      edition,
      owner,
      id,
    ),
    q(
      db,
      'UPDATE generation_requests SET next_event=(SELECT max(sequence)+1 FROM request_events WHERE request_id=?) WHERE owner_id=? AND id=?',
      id,
      owner,
      id,
    ),
  ];
}

export class RequestState {
  constructor(readonly base: RecordBase) {}
  async status(session: Session, id: string, after = 0) {
    // D1 batch provides one snapshot: pruning cannot split the row watermark from the events.
    const [rows, events] = await this.base.db.batch<Record<string, unknown>>([
      q(
        this.base.db,
        'SELECT r.*,e.id AS edition_id,coalesce((SELECT max(sequence) FROM request_events WHERE request_id=r.id),0) AS event_watermark FROM generation_requests r LEFT JOIN reading_editions e ON e.request_id=r.id AND e.owner_id=r.owner_id WHERE r.owner_id=? AND r.id=?',
        session.subjectId,
        id,
      ),
      q(
        this.base.db,
        'SELECT sequence,created_at,state,code,edition_id,error_code FROM request_events WHERE owner_id=? AND request_id=? AND sequence>? ORDER BY sequence LIMIT 20',
        session.subjectId,
        id,
        after,
      ),
    ]);
    const row = rows!.results[0];
    if (!row) throw new RecordError(404, 'NOT_FOUND');
    const sessionId = String(row.session_id);
    await this.base.ownedSession(session, sessionId);
    await this.base.checked(session, undefined, [this.base.sessionGuard(session, sessionId)]);
    const last = Number(events!.results.at(-1)?.sequence ?? 0);
    return apiSchemas.RequestStatus.parse({
      requestId: id,
      sessionId,
      state: row.state,
      revision: row.revision,
      events: events!.results.map((e) => ({
        sequence: e.sequence,
        at: iso(Number(e.created_at)),
        state: e.state,
        code: e.code,
        editionId: e.edition_id,
        errorCode: e.error_code,
      })),
      nextSequence:
        events!.results.length === 20
          ? last
          : Math.max(Number(row.next_event) - 1, Number(row.event_watermark), last),
      editionId: row.edition_id,
      errorCode: row.error_code,
      expiresAt: iso(Number(row.expires_at)),
    });
  }
  async resolveIntent(session: Session, intent: string, after = 0) {
    const id = await q(
      this.base.db,
      'SELECT id FROM generation_requests WHERE owner_id=? AND client_intent_id=?',
      session.subjectId,
      intent,
    ).first<string>('id');
    if (!id) throw new RecordError(404, 'NOT_FOUND');
    return this.status(session, id, after);
  }
  async cancel(session: Session, id: string, revision: number, key: string) {
    const mutation = await this.base.mutation(session, key, 'reading.cancel', { id, revision });
    const snapshot = await this.status(session, id);
    if (mutation.existing) return snapshot;
    if (snapshot.state === 'published' || snapshot.revision !== revision)
      throw new RecordError(409, 'CONFLICT', snapshot.revision);
    try {
      await this.base.atomic(
        session,
        [
          this.base.sessionGuard(session, snapshot.sessionId),
          assertion(
            this.base.db,
            "EXISTS(SELECT 1 FROM generation_requests WHERE owner_id=? AND id=? AND revision=? AND state<>'published')",
            session.subjectId,
            id,
            revision,
          ),
          ...this.base.stopStatements(
            session.subjectId,
            snapshot.sessionId,
            'cancelled',
            'CANCELLED',
          ),
          mutation.insert(id),
        ],
        true,
      );
    } catch (error) {
      const latest = await this.status(session, id);
      const committed = await this.base.mutation(session, key, 'reading.cancel', { id, revision });
      if (committed.existing) return latest;
      if (latest.revision !== revision || latest.state === 'published')
        throw new RecordError(409, 'CONFLICT', latest.revision);
      throw error;
    }
    return this.status(session, id);
  }
}

export type StopState = 'blocked' | 'failed' | 'expired' | 'cancelled';
/** Statements used by all stop paths; callers include their own authorization/offline fence. */
export function stoppedEvents(
  db: D1Database,
  owner: string,
  sessionId: string | undefined,
  state: StopState,
  code: ErrorCode,
) {
  const filter = sessionId ? ' AND session_id=?' : '';
  const args = sessionId ? [owner, sessionId] : [owner];
  return [
    q(
      db,
      `INSERT INTO request_events(request_id,owner_id,sequence,state,code,error_code,created_at)
      SELECT id,owner_id,max(next_event,coalesce((SELECT max(sequence)+1 FROM request_events WHERE request_id=r.id),1)),?,'STOPPED',?,${DB_NOW}
      FROM generation_requests r WHERE owner_id=?${filter} AND state NOT IN (${terminalStates})`,
      state,
      code,
      ...args,
    ),
    q(
      db,
      `UPDATE generation_requests SET next_event=(SELECT max(sequence)+1 FROM request_events WHERE request_id=generation_requests.id)
      WHERE owner_id=?${filter} AND state NOT IN (${terminalStates})`,
      ...args,
    ),
  ];
}
