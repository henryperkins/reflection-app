import { AuthResult, SessionView } from '../../contracts/index.ts';
import { assertion, onlineGuard, DB_NOW, statement } from './checkpoint.ts';
import { encode, type IdentityCrypto, randomToken } from './crypto.ts';
import { IdentityError, type Session } from './types.ts';
const DAY = 86_400_000;
export class IdentitySessions {
  constructor(
    private db: D1Database,
    private crypt: IdentityCrypto,
  ) {}
  async issue(
    subjectId: string,
    epoch: number,
    authenticatedAt = Date.now(),
    guards: D1PreparedStatement[] = [],
  ) {
    const token = randomToken(),
      tokenHash = await this.crypt.hash('session', token);
    const csrfToken = encode(await this.crypt.mac('csrf', [token, epoch]));
    const csrfHash = await this.crypt.hash('csrf-verifier', csrfToken),
      now = Date.now();
    await this.db.batch([
      onlineGuard(this.db),
      ...guards,
      assertion(
        this.db,
        "EXISTS(SELECT 1 FROM accounts WHERE id=? AND auth_epoch=? AND status='active' AND write_fence IS NULL)",
        subjectId,
        epoch,
      ),
      statement(
        this.db,
        'INSERT INTO auth_sessions(token_hash,owner_id,csrf_hash,auth_epoch,authenticated_at,created_at,idle_expires_at,expires_at) VALUES (?,?,?,?,?,?,?,?)',
        tokenHash,
        subjectId,
        csrfHash,
        epoch,
        authenticatedAt,
        now,
        now + DAY,
        now + 7 * DAY,
      ),
    ]);
    return {
      token,
      result: AuthResult.parse({
        subjectId,
        csrfToken,
        recoveryHandle: null,
        recoveryCodes: [],
        recentAuthUntil: new Date(authenticatedAt + 300_000).toISOString(),
      }),
    };
  }
  async get(token: string | undefined): Promise<Session> {
    if (!token || !/^[\w-]{43}$/.test(token)) throw new IdentityError(401, 'AUTH_REQUIRED');
    const tokenHash = await this.crypt.hash('session', token);
    const row = await statement(
      this.db,
      `SELECT s.*, a.write_fence FROM auth_sessions s JOIN accounts a ON a.id=s.owner_id WHERE s.token_hash=? AND a.status='active' AND s.auth_epoch=a.auth_epoch AND s.expires_at>${DB_NOW} AND s.idle_expires_at>${DB_NOW}`,
      tokenHash,
    ).first<{
      owner_id: string;
      auth_epoch: number;
      authenticated_at: number;
      csrf_hash: string;
      write_fence: string | null;
    }>();
    if (!row) throw new IdentityError(401, 'AUTH_REQUIRED');
    const csrfToken = encode(await this.crypt.mac('csrf', [token, row.auth_epoch]));
    if ((await this.crypt.hash('csrf-verifier', csrfToken)) !== row.csrf_hash)
      throw new IdentityError(401, 'AUTH_REQUIRED');
    await this.db.batch([
      onlineGuard(this.db),
      statement(
        this.db,
        `UPDATE auth_sessions SET idle_expires_at=min(expires_at,${DB_NOW}+?) WHERE token_hash=? AND idle_expires_at<${DB_NOW}+?`,
        DAY,
        tokenHash,
        DAY - 300_000,
      ),
    ]);
    return {
      subjectId: row.owner_id,
      epoch: row.auth_epoch,
      authenticatedAt: row.authenticated_at,
      tokenHash,
      csrfToken,
      writeFence: row.write_fence,
    };
  }
  guard(session: Session, recent = false, writable = true): D1PreparedStatement {
    return assertion(
      this.db,
      `NOT EXISTS(SELECT 1 FROM system_state WHERE restore_in_progress=1) AND EXISTS(SELECT 1 FROM auth_sessions s JOIN accounts a ON a.id=s.owner_id WHERE s.token_hash=? AND s.owner_id=? AND s.auth_epoch=? AND a.auth_epoch=s.auth_epoch AND a.status='active' ${writable ? 'AND a.write_fence IS NULL' : ''} AND s.expires_at>${DB_NOW} AND s.idle_expires_at>${DB_NOW}${recent ? ` AND s.authenticated_at>${DB_NOW}-300000` : ''})`,
      session.tokenHash,
      session.subjectId,
      session.epoch,
    );
  }
  async view(session: Session) {
    const permission = await statement(
      this.db,
      'SELECT p.revision,p.model_allowed FROM permission_revisions p JOIN accounts a ON a.id=p.owner_id AND a.permission_revision=p.revision WHERE a.id=? AND a.auth_epoch=?',
      session.subjectId,
      session.epoch,
    ).first<{ revision: number; model_allowed: number }>();
    if (!permission) throw new IdentityError(401, 'AUTH_REQUIRED');
    return SessionView.parse({
      subjectId: session.subjectId,
      csrfToken: session.csrfToken,
      permission: {
        revision: permission.revision,
        modelAllowed: Boolean(permission.model_allowed),
        policyVersion: 'egress.v1',
      },
      remainingDay: await this.remaining(
        session.subjectId,
        `day:${new Date().toISOString().slice(0, 10)}`,
        3,
      ),
      remainingMonth: await this.remaining(
        session.subjectId,
        `month:${new Date().toISOString().slice(0, 7)}`,
        30,
      ),
      recentAuthUntil: new Date(session.authenticatedAt + 300_000).toISOString(),
    });
  }
  private async remaining(owner: string, period: string, allowance: number) {
    const row = await statement(
      this.db,
      'SELECT allowance-held-consumed AS remaining FROM quota_buckets WHERE owner_id=? AND period=?',
      owner,
      period,
    ).first<{ remaining: number }>();
    return row?.remaining ?? allowance;
  }
  async logout(session: Session) {
    await this.db.batch([
      onlineGuard(this.db),
      statement(this.db, 'DELETE FROM auth_sessions WHERE token_hash=?', session.tokenHash),
    ]);
  }
}
