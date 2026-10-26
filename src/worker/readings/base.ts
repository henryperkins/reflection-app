import type { z } from 'zod';
import type { ErrorCode } from '../../contracts/index.ts';
import { canonicalJson } from '../../domain/json.ts';
import { assertion } from '../identity/checkpoint.ts';
import { decode, encode } from '../identity/crypto.ts';
import type { IdentityService } from '../identity/service.ts';
import type { Session } from '../identity/types.ts';
import { statement as q, DB_NOW } from '../db/core.ts';
import { RecordCrypto } from './crypto.ts';

export class RecordError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    readonly revision: number | null = null,
  ) {
    super(code);
  }
}
export interface Account {
  id: string;
  key_version: number;
  data_revision: number;
  permission_revision: number;
  model_allowed: number;
  recovery_ack_at: number | null;
  storage_bytes: number;
}
export interface SessionRow {
  id: string;
  owner_id: string;
  status: string;
  revision: number;
  question_enc: string | null;
  created_at: number;
  saved_at: number | null;
  retention_expires_at: number | null;
}
export const iso = (time: number) => new Date(time).toISOString();
export const availableSession = `(s.status='saved' OR (s.status='open' AND s.retention_expires_at>${DB_NOW}))`;
export const terminalStates = "'published','blocked','failed','expired','cancelled'";
export class RecordBase {
  readonly crypt: RecordCrypto;
  constructor(
    readonly db: D1Database,
    readonly identity: IdentityService,
  ) {
    this.crypt = new RecordCrypto(db, identity.crypt);
  }
  async account(session: Session): Promise<Account> {
    const row = await q(
      this.db,
      `SELECT a.*,p.model_allowed FROM accounts a JOIN permission_revisions p ON p.owner_id=a.id AND p.revision=a.permission_revision WHERE a.id=? AND a.auth_epoch=? AND a.status='active'`,
      session.subjectId,
      session.epoch,
    ).first<Account>();
    if (!row) throw new RecordError(401, 'UNAUTHENTICATED');
    return row;
  }
  async checked(session: Session, revision?: number, guards: D1PreparedStatement[] = []) {
    await this.db.batch([
      this.identity.sessions.guard(session, false, false),
      ...(revision === undefined
        ? []
        : [
            assertion(
              this.db,
              'EXISTS(SELECT 1 FROM accounts WHERE id=? AND data_revision=?)',
              session.subjectId,
              revision,
            ),
          ]),
      ...guards,
    ]);
  }
  async checkedSession(
    session: Session,
    id: string,
    revision: number,
    guards: D1PreparedStatement[] = [],
  ) {
    try {
      await this.checked(session, revision, [this.sessionGuard(session, id), ...guards]);
    } catch (error) {
      await this.checked(session);
      await this.ownedSession(session, id);
      throw error;
    }
  }
  async atomic(session: Session, statements: D1PreparedStatement[], bytes = 0, recent = false) {
    await this.db.batch([
      this.identity.sessions.guard(session, recent),
      ...statements,
      q(
        this.db,
        `UPDATE accounts SET data_revision=data_revision+1,storage_bytes=max(0,storage_bytes+?),updated_at=${DB_NOW} WHERE id=? AND storage_bytes+?<=20971520`,
        bytes,
        session.subjectId,
        bytes,
      ),
      assertion(this.db, 'changes()=1'),
    ]);
  }
  async ownedSession(session: Session, id: string): Promise<SessionRow> {
    const row = await q(
      this.db,
      'SELECT * FROM reading_sessions WHERE owner_id=? AND id=?',
      session.subjectId,
      id,
    ).first<SessionRow>();
    if (!row) throw new RecordError(404, 'NOT_FOUND');
    const valid = await q(
      this.db,
      `SELECT 1 FROM reading_sessions s WHERE s.owner_id=? AND s.id=? AND ${availableSession}`,
      session.subjectId,
      id,
    ).first();
    if (!valid) throw new RecordError(410, 'CONTENT_UNAVAILABLE');
    return row;
  }
  sessionGuard(session: Session, id: string, revision?: number) {
    return assertion(
      this.db,
      `EXISTS(SELECT 1 FROM reading_sessions s WHERE s.owner_id=? AND s.id=? AND ${availableSession}${revision === undefined ? '' : ' AND s.revision=?'})`,
      session.subjectId,
      id,
      ...(revision === undefined ? [] : [revision]),
    );
  }
  async opened<T>(...args: Parameters<RecordCrypto['open']>): Promise<T> {
    try {
      return (await this.crypt.open(...args)) as T;
    } catch {
      throw new RecordError(503, 'KEY_UNAVAILABLE');
    }
  }
  async mutation(session: Session, key: string, operation: string, payload: unknown) {
    const keyHash = await this.identity.crypt.hash('idempotency', [session.subjectId, key]);
    const payloadHash = await this.crypt.hash(session.subjectId, 'mutation', [operation, payload]);
    const row = await q(
      this.db,
      'SELECT operation,payload_hmac,resource_id FROM idempotency_keys WHERE owner_id=? AND key_hash=?',
      session.subjectId,
      keyHash,
    ).first<{ operation: string; payload_hmac: string; resource_id: string }>();
    if (row && (row.operation !== operation || row.payload_hmac !== payloadHash))
      throw new RecordError(409, 'IDEMPOTENCY_MISMATCH');
    return {
      existing: row?.resource_id,
      payloadHash,
      insert: (id: string) =>
        q(
          this.db,
          `INSERT INTO idempotency_keys VALUES (?,?,?,?,?,${DB_NOW},${DB_NOW}+604800000)`,
          session.subjectId,
          keyHash,
          operation,
          payloadHash,
          id,
        ),
    };
  }
  async cursor(session: Session, scope: unknown, value: unknown) {
    const body = encode(new TextEncoder().encode(canonicalJson(value)));
    return `${body}.${await this.identity.crypt.hash('record-cursor', [session.subjectId, scope, body])}`;
  }
  async parseCursor<T>(session: Session, scope: unknown, cursor: string, schema: z.ZodType<T>) {
    try {
      if (cursor.length > 2000) throw new Error();
      const [body, mac, extra] = cursor.split('.');
      if (
        !body ||
        extra ||
        mac !== (await this.identity.crypt.hash('record-cursor', [session.subjectId, scope, body]))
      )
        throw new Error();
      return schema.parse(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decode(body))),
      );
    } catch {
      throw new RecordError(400, 'BAD_INPUT');
    }
  }
  /** Release each held reservation once, then fence all unfinished work in the same transaction. */
  stopStatements(owner: string, sessionId?: string) {
    const filter = sessionId ? ' AND session_id=?' : '';
    const args = sessionId ? [owner, sessionId] : [owner];
    const ids = `SELECT id FROM generation_requests WHERE owner_id=?${filter} AND state NOT IN (${terminalStates})`;
    return [
      q(
        this.db,
        `UPDATE quota_buckets SET held=held-(SELECT count(*) FROM quota_reservations qr WHERE qr.owner_id=quota_buckets.owner_id AND qr.state='held' AND (qr.day_period=quota_buckets.period OR qr.month_period=quota_buckets.period) AND qr.request_id IN (${ids})) WHERE owner_id=?`,
        ...args,
        owner,
      ),
      q(
        this.db,
        `INSERT OR IGNORE INTO quota_events SELECT request_id,owner_id,'release',${DB_NOW} FROM quota_reservations WHERE state='held' AND request_id IN (${ids})`,
        ...args,
      ),
      q(
        this.db,
        `UPDATE quota_reservations SET state='released' WHERE state='held' AND request_id IN (${ids})`,
        ...args,
      ),
      q(
        this.db,
        `UPDATE generation_requests SET state='blocked',error_code='CONSENT_REQUIRED',revision=revision+1,lease_token=NULL,lease_expires_at=NULL,finished_at=${DB_NOW} WHERE id IN (${ids})`,
        ...args,
      ),
    ];
  }
}
