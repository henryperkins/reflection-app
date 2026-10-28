import { verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import type { z } from 'zod';
import { apiSchemas, AuthOptions, IdentityCheckpoint } from '../../contracts/index.ts';
import { assertion, onlineGuard, DB_NOW, IdentityCheckpoints, statement } from './checkpoint.ts';
import { type Checkpoint, encode, type IdentityCrypto, randomToken, uuidBytes } from './crypto.ts';
import { IdentitySessions } from './sessions.ts';
import { type Challenge, type CredentialRow, IdentityError, type Session } from './types.ts';

export class IdentityService {
  readonly sessions: IdentitySessions;
  readonly checkpoints: IdentityCheckpoints;
  constructor(
    private db: D1Database,
    bucket: R2Bucket,
    readonly crypt: IdentityCrypto,
    readonly origin: string,
  ) {
    this.sessions = new IdentitySessions(db, crypt);
    this.checkpoints = new IdentityCheckpoints(db, bucket, crypt);
  }
  async maintenance(deadlineMs = Infinity): Promise<void> {
    await this.checkpoints.resumePending(deadlineMs);
  }
  async rate(scope: string, identity: string, limit: number, period: number): Promise<void> {
    const now = Date.now(),
      day = Math.floor(now / 86_400_000),
      start = Math.floor(now / period) * period;
    const hash = await this.crypt.hash('rate', [scope, day, identity]);
    const results = await this.db.batch<{ count: number }>([
      onlineGuard(this.db),
      statement(
        this.db,
        'INSERT INTO rate_buckets(scope_hash,window_start,count,expires_at) VALUES (?,?,1,?) ON CONFLICT(scope_hash,window_start) DO UPDATE SET count=count+1 RETURNING count',
        hash,
        start,
        now + 2 * 86_400_000,
      ),
    ]);
    const row = results[1]?.results[0];
    if (!row || row.count > limit) throw new IdentityError(429, 'RATE_LIMITED');
  }
  private async newChallenge(
    purpose: string,
    owner: string | null = null,
    epoch: number | null = null,
  ) {
    const id = crypto.randomUUID(),
      challenge = randomToken(),
      browser = randomToken(),
      now = Date.now();
    const options = AuthOptions.parse({
      challengeId: id,
      challenge,
      rpId: new URL(this.origin).hostname,
      user:
        purpose === 'authenticate' || purpose === 'reauthenticate'
          ? null
          : {
              id: encode(uuidBytes(owner ?? id)),
              name: `Reflection account ${id.slice(0, 8)}`,
              displayName: `Reflection account ${id.slice(0, 8)}`,
            },
      rpName: 'Reflection',
      timeout: 300000,
      userVerification: 'required',
      residentKey: 'required',
      attestation: 'none',
      algorithms: [-7, -257],
      excludeCredentialIds: [],
    });
    const insert = statement(
      this.db,
      'INSERT INTO auth_challenges(id,owner_id,purpose,challenge_hash,browser_hash,auth_epoch,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?)',
      id,
      owner,
      purpose,
      await this.crypt.hash('challenge', challenge),
      await this.crypt.hash('browser', browser),
      epoch,
      now + 300_000,
      now,
    );
    return { options, browser, insert };
  }
  async begin(purpose: z.infer<typeof apiSchemas.AuthBegin>['purpose'], session?: Session) {
    if (purpose === 'reauthenticate' && !session) throw new IdentityError(401, 'AUTH_REQUIRED');
    let excluded: string[] = [];
    if (purpose === 'add') {
      const current = this.recentPasskey(session);
      excluded = (await this.credentials(current)).items.map((credential) => credential.id);
      if (excluded.length >= 10) throw new IdentityError(409, 'CREDENTIAL_LIMIT');
    }
    const made = await this.newChallenge(
      purpose,
      session?.subjectId ?? null,
      session?.epoch ?? null,
    );
    made.options.excludeCredentialIds = excluded;
    await this.db.batch([
      onlineGuard(this.db),
      ...(session
        ? [this.sessions.guard(session, purpose === 'add', true, purpose === 'add')]
        : []),
      made.insert,
    ]);
    return made;
  }
  private recentPasskey(session?: Session): Session {
    if (
      !session ||
      session.authenticatedAt <= Date.now() - 300_000 ||
      session.passkeyAuthenticatedAt === null ||
      session.passkeyAuthenticatedAt <= Date.now() - 300_000
    )
      throw new IdentityError(401, 'REAUTH_REQUIRED');
    return session;
  }
  async credentials(session: Session) {
    if (session.writeFence) throw new IdentityError(503, 'DEPENDENCY_UNAVAILABLE');
    const results = await this.db.batch<{ id: string; created_at: number; backed_up: number }>([
      this.sessions.guard(session),
      statement(
        this.db,
        'SELECT id,created_at,backed_up FROM credentials WHERE owner_id=? ORDER BY created_at,id',
        session.subjectId,
      ),
    ]);
    return apiSchemas.Credentials.parse({
      items: results[1]!.results.map((credential) => ({
        id: credential.id,
        createdAt: new Date(credential.created_at).toISOString(),
        backedUp: Boolean(credential.backed_up),
      })),
    });
  }
  private async challenge(
    id: string,
    browser: string | undefined,
    purposes: string[],
  ): Promise<Challenge> {
    if (!browser) throw new IdentityError(401, 'AUTH_FAILED');
    const row = await statement(
      this.db,
      `SELECT * FROM auth_challenges WHERE id=? AND browser_hash=? AND consumed_at IS NULL AND expires_at>${DB_NOW}`,
      id,
      await this.crypt.hash('browser', browser),
    ).first<Challenge>();
    if (!row || !purposes.includes(row.purpose)) throw new IdentityError(401, 'AUTH_FAILED');
    if (row.owner_id) {
      const account = await statement(
        this.db,
        "SELECT 1 AS ok FROM accounts WHERE id=? AND auth_epoch=? AND status='active' AND write_fence IS NULL",
        row.owner_id,
        row.auth_epoch,
      ).first();
      if (!account) throw new IdentityError(401, 'AUTH_FAILED');
    }
    return row;
  }
  private consume(row: Challenge): D1PreparedStatement[] {
    return [
      assertion(
        this.db,
        `EXISTS(SELECT 1 FROM auth_challenges WHERE id=? AND purpose=? AND browser_hash=? AND consumed_at IS NULL AND expires_at>${DB_NOW})`,
        row.id,
        row.purpose,
        row.browser_hash,
      ),
      statement(this.db, `UPDATE auth_challenges SET consumed_at=${DB_NOW} WHERE id=?`, row.id),
    ];
  }
  private async kit() {
    const recoveryHandle = randomToken(16),
      codes = Array.from({ length: 10 }, () => randomToken(16)),
      createdAt = new Date().toISOString();
    return {
      recoveryHandle,
      codes,
      hash: await this.crypt.hash('recovery-handle', recoveryHandle),
      verifiers: await Promise.all(
        codes.map(async (code) => ({
          codeHash: await this.crypt.hash('recovery-code', [recoveryHandle, code]),
          usedAt: null,
          createdAt,
        })),
      ),
    };
  }
  async snapshot(subjectId: string): Promise<Checkpoint> {
    const account = await statement(
      this.db,
      "SELECT * FROM accounts WHERE id=? AND status='active' AND write_fence IS NULL",
      subjectId,
    ).first<{ auth_epoch: number; recovery_handle_hash: string; recovery_ack_at: number | null }>();
    if (!account) throw new IdentityError(401, 'AUTH_FAILED');
    const credentials = await statement(
      this.db,
      'SELECT * FROM credentials WHERE owner_id=? ORDER BY id',
      subjectId,
    ).all<CredentialRow>();
    const codes = await statement(
      this.db,
      'SELECT * FROM recovery_codes WHERE owner_id=? ORDER BY code_hash',
      subjectId,
    ).all<{ code_hash: string; used_at: number | null; created_at: number }>();
    return IdentityCheckpoint.parse({
      v: 1,
      operationId: crypto.randomUUID(),
      subjectId,
      epoch: account.auth_epoch,
      createdAt: new Date().toISOString(),
      recoveryHandleHash: account.recovery_handle_hash,
      recoveryAcknowledgedAt:
        account.recovery_ack_at === null ? null : new Date(account.recovery_ack_at).toISOString(),
      credentials: credentials.results.map((c) => ({
        id: c.id,
        publicKey: encode(new Uint8Array(c.public_key)),
        signCount: c.sign_count,
        backedUp: Boolean(c.backed_up),
        transports: JSON.parse(c.transports_json),
        createdAt: new Date(c.created_at).toISOString(),
      })),
      recoveryCodes: codes.results.map((c) => ({
        codeHash: c.code_hash,
        usedAt: c.used_at === null ? null : new Date(c.used_at).toISOString(),
        createdAt: new Date(c.created_at).toISOString(),
      })),
    });
  }
  async register(
    input: z.infer<typeof apiSchemas.RegisterFinish>,
    browser: string | undefined,
    ip = 'loopback',
    session?: Session,
    csrfToken?: string,
  ) {
    const challenge = await this.challenge(input.challengeId, browser, [
      'register',
      'recover',
      'add',
    ]);
    const current = challenge.purpose === 'add' ? this.recentPasskey(session) : undefined;
    if (current) {
      if (csrfToken !== current.csrfToken) throw new IdentityError(403, 'FORBIDDEN');
      if (current.subjectId !== challenge.owner_id || current.epoch !== challenge.auth_epoch)
        throw new IdentityError(401, 'AUTH_FAILED');
    }
    const credential = input.credential;
    if (
      credential.id !== credential.rawId ||
      credential.clientExtensionResults.credProps?.rk !== true
    )
      throw new IdentityError(401, 'AUTH_FAILED');
    const verified = await verifyRegistrationResponse({
      response: {
        id: credential.id,
        rawId: credential.rawId,
        type: credential.type,
        response: credential.response,
        clientExtensionResults: { credProps: { rk: true } },
        ...(credential.authenticatorAttachment
          ? { authenticatorAttachment: credential.authenticatorAttachment }
          : {}),
      },
      expectedChallenge: async (value) =>
        (await this.crypt.hash('challenge', value)) === challenge.challenge_hash,
      expectedOrigin: this.origin,
      expectedRPID: new URL(this.origin).hostname,
      requireUserVerification: true,
      supportedAlgorithmIDs: [-7, -257],
    }).catch(() => {
      throw new IdentityError(401, 'AUTH_FAILED');
    });
    if (!verified.verified || verified.registrationInfo.fmt !== 'none')
      throw new IdentityError(401, 'AUTH_FAILED');
    if (current) {
      const previous = await this.snapshot(current.subjectId);
      if (previous.credentials.length >= 10) throw new IdentityError(409, 'CREDENTIAL_LIMIT');
      const info = verified.registrationInfo;
      if (
        await statement(this.db, 'SELECT 1 FROM credentials WHERE id=?', info.credential.id).first()
      )
        throw new IdentityError(409, 'CREDENTIAL_EXISTS');
      const now = new Date().toISOString();
      const snapshot: Checkpoint = {
        ...previous,
        operationId: crypto.randomUUID(),
        epoch: previous.epoch + 1,
        createdAt: now,
        credentials: [
          ...previous.credentials,
          {
            id: info.credential.id,
            publicKey: encode(info.credential.publicKey),
            signCount: info.credential.counter,
            backedUp: info.credentialBackedUp,
            transports: credential.response.transports,
            createdAt: now,
          },
        ],
      };
      await this.checkpoints.commit(snapshot, {
        expected: previous,
        guards: [
          this.sessions.guard(current, true, true, true),
          ...this.consume(challenge),
          assertion(
            this.db,
            'NOT EXISTS(SELECT 1 FROM credentials WHERE id=?)',
            info.credential.id,
          ),
          assertion(
            this.db,
            '(SELECT count(*) FROM credentials WHERE owner_id=?)<10',
            current.subjectId,
          ),
        ],
      });
      return this.sessions.issue(
        current.subjectId,
        snapshot.epoch,
        current.authenticatedAt,
        [],
        current.passkeyAuthenticatedAt,
      );
    }
    if (challenge.purpose === 'register') await this.rate('registration', ip, 3, 86_400_000);
    const subjectId = challenge.owner_id ?? challenge.id,
      previous = challenge.purpose === 'recover' ? await this.snapshot(subjectId) : undefined;
    const kit = await this.kit(),
      now = new Date().toISOString(),
      info = verified.registrationInfo;
    const snapshot: Checkpoint = {
      v: 1,
      operationId: crypto.randomUUID(),
      subjectId,
      epoch: previous ? previous.epoch + 1 : 1,
      createdAt: now,
      recoveryHandleHash: kit.hash,
      recoveryAcknowledgedAt: null,
      credentials: [
        {
          id: info.credential.id,
          publicKey: encode(info.credential.publicKey),
          signCount: info.credential.counter,
          backedUp: info.credentialBackedUp,
          transports: credential.response.transports,
          createdAt: now,
        },
      ],
      recoveryCodes: kit.verifiers,
    };
    if (previous && previous.epoch !== challenge.auth_epoch)
      throw new IdentityError(401, 'AUTH_FAILED');
    await this.checkpoints.commit(snapshot, {
      ...(previous
        ? { expected: previous }
        : { initialKeys: await this.crypt.createAccountKeys(subjectId) }),
      guards: this.consume(challenge),
    });
    const issued = await this.sessions.issue(subjectId, snapshot.epoch);
    issued.result.recoveryHandle = kit.recoveryHandle;
    issued.result.recoveryCodes = kit.codes;
    return issued;
  }
  async authenticate(
    input: z.infer<typeof apiSchemas.AuthenticateFinish>,
    browser: string | undefined,
    session?: Session,
  ) {
    const challenge = await this.challenge(input.challengeId, browser, [
      'authenticate',
      'reauthenticate',
    ]);
    const row = await statement(
      this.db,
      "SELECT c.*,a.auth_epoch FROM credentials c JOIN accounts a ON a.id=c.owner_id WHERE c.id=? AND a.status='active' AND a.write_fence IS NULL",
      input.credential.id,
    ).first<CredentialRow & { auth_epoch: number }>();
    if (
      !row ||
      input.credential.id !== input.credential.rawId ||
      input.credential.response.userHandle !== encode(uuidBytes(row.owner_id))
    )
      throw new IdentityError(401, 'AUTH_FAILED');
    if (
      challenge.purpose === 'reauthenticate' &&
      (!session ||
        session.subjectId !== row.owner_id ||
        session.epoch !== row.auth_epoch ||
        challenge.owner_id !== row.owner_id)
    )
      throw new IdentityError(401, 'AUTH_FAILED');
    const verified = await verifyAuthenticationResponse({
      response: {
        id: input.credential.id,
        rawId: input.credential.rawId,
        type: input.credential.type,
        response: { ...input.credential.response, userHandle: encode(uuidBytes(row.owner_id)) },
        clientExtensionResults: {},
        ...(input.credential.authenticatorAttachment
          ? { authenticatorAttachment: input.credential.authenticatorAttachment }
          : {}),
      },
      expectedChallenge: async (value) =>
        (await this.crypt.hash('challenge', value)) === challenge.challenge_hash,
      expectedOrigin: this.origin,
      expectedRPID: new URL(this.origin).hostname,
      requireUserVerification: true,
      credential: {
        id: row.id,
        publicKey: new Uint8Array(row.public_key),
        counter: row.sign_count,
      },
    }).catch(() => {
      throw new IdentityError(401, 'AUTH_FAILED');
    });
    if (!verified.verified) throw new IdentityError(401, 'AUTH_FAILED');
    const now = Date.now();
    return this.sessions.issue(
      row.owner_id,
      row.auth_epoch,
      now,
      [
        ...this.consume(challenge),
        ...(session ? [this.sessions.guard(session)] : []),
        assertion(
          this.db,
          'EXISTS(SELECT 1 FROM credentials WHERE id=? AND owner_id=? AND sign_count=?)',
          row.id,
          row.owner_id,
          row.sign_count,
        ),
        statement(
          this.db,
          'UPDATE credentials SET sign_count=?,backed_up=? WHERE id=?',
          verified.authenticationInfo.newCounter,
          Number(verified.authenticationInfo.credentialBackedUp),
          row.id,
        ),
        ...(session
          ? [statement(this.db, 'DELETE FROM auth_sessions WHERE token_hash=?', session.tokenHash)]
          : []),
      ],
      now,
    );
  }
  async recover(input: z.infer<typeof apiSchemas.Recover>, ip = 'loopback') {
    const now = Date.now(),
      day = Math.floor(now / 86_400_000),
      start = Math.floor(now / 3_600_000) * 3_600_000;
    const hashes = await Promise.all([
      this.crypt.hash('rate', ['recovery-ip', day, ip]),
      this.crypt.hash('rate', ['recovery-handle', day, input.recoveryHandle]),
    ]);
    const limited = await statement(
      this.db,
      'SELECT 1 FROM rate_buckets WHERE scope_hash IN (?,?) AND window_start=? AND count>=5',
      hashes[0]!,
      hashes[1]!,
      start,
    ).first();
    if (limited) throw new IdentityError(429, 'RATE_LIMITED');
    try {
      return await this.recoverAccount(input);
    } catch (error) {
      if (
        !(error instanceof IdentityError && error.status === 401) &&
        !(
          error instanceof Error &&
          /CHECK constraint failed|UNIQUE constraint failed/.test(error.message)
        )
      )
        throw error;
      const results = await this.db.batch<{ count: number }>([
        onlineGuard(this.db),
        ...hashes.map((hash) =>
          statement(
            this.db,
            'INSERT INTO rate_buckets(scope_hash,window_start,count,expires_at) VALUES (?,?,1,?) ON CONFLICT(scope_hash,window_start) DO UPDATE SET count=count+1 RETURNING count',
            hash,
            start,
            now + 2 * 86_400_000,
          ),
        ),
      ]);
      if (results.slice(1).some((result) => result.results[0]!.count > 5))
        throw new IdentityError(429, 'RATE_LIMITED');
      throw new IdentityError(401, 'AUTH_FAILED');
    }
  }
  private async recoverAccount(input: z.infer<typeof apiSchemas.Recover>) {
    const handleHash = await this.crypt.hash('recovery-handle', input.recoveryHandle),
      codeHash = await this.crypt.hash('recovery-code', [input.recoveryHandle, input.code]);
    const account = await statement(
      this.db,
      "SELECT a.id FROM accounts a JOIN recovery_codes c ON c.owner_id=a.id WHERE a.recovery_handle_hash=? AND c.code_hash=? AND c.used_at IS NULL AND a.status='active' AND a.write_fence IS NULL",
      handleHash,
      codeHash,
    ).first<{ id: string }>();
    if (!account) throw new IdentityError(401, 'AUTH_FAILED');
    const previous = await this.snapshot(account.id),
      epoch = previous.epoch + 1;
    const made = await this.newChallenge('recover', account.id, epoch),
      now = new Date().toISOString();
    const snapshot = {
      ...previous,
      operationId: crypto.randomUUID(),
      epoch,
      createdAt: now,
      recoveryCodes: previous.recoveryCodes.map((code) =>
        code.codeHash === codeHash ? { ...code, usedAt: now } : code,
      ),
    };
    await this.checkpoints.commit(snapshot, {
      expected: previous,
      guards: [
        assertion(
          this.db,
          'EXISTS(SELECT 1 FROM recovery_codes WHERE owner_id=? AND code_hash=? AND used_at IS NULL)',
          account.id,
          codeHash,
        ),
        made.insert,
      ],
    });
    return {
      browser: made.browser,
      result: { challengeId: made.options.challengeId, options: made.options },
    };
  }
  async acknowledge(session: Session) {
    const previous = await this.snapshot(session.subjectId);
    if (previous.recoveryAcknowledgedAt) return null;
    const snapshot = {
      ...previous,
      operationId: crypto.randomUUID(),
      epoch: previous.epoch + 1,
      recoveryAcknowledgedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };
    await this.checkpoints.commit(snapshot, {
      expected: previous,
      guards: [this.sessions.guard(session)],
    });
    return this.sessions.issue(
      session.subjectId,
      snapshot.epoch,
      session.authenticatedAt,
      [],
      session.passkeyAuthenticatedAt,
    );
  }
  async rotate(session: Session) {
    const previous = await this.snapshot(session.subjectId),
      kit = await this.kit();
    const snapshot = {
      ...previous,
      operationId: crypto.randomUUID(),
      epoch: previous.epoch + 1,
      createdAt: new Date().toISOString(),
      recoveryAcknowledgedAt: null,
      recoveryHandleHash: kit.hash,
      recoveryCodes: kit.verifiers,
    };
    await this.checkpoints.commit(snapshot, {
      expected: previous,
      guards: [this.sessions.guard(session, true)],
    });
    return {
      ...(await this.sessions.issue(
        session.subjectId,
        snapshot.epoch,
        session.authenticatedAt,
        [],
        session.passkeyAuthenticatedAt,
      )),
      kit: { recoveryHandle: kit.recoveryHandle, codes: kit.codes },
    };
  }
  async logoutAll(session: Session) {
    const previous = await this.snapshot(session.subjectId);
    // Persist the new epoch independently before acknowledging revocation. The
    // checkpoint apply transaction clears every session and old challenge.
    await this.checkpoints.commit(
      {
        ...previous,
        operationId: crypto.randomUUID(),
        epoch: previous.epoch + 1,
        createdAt: new Date().toISOString(),
      },
      { expected: previous, guards: [this.sessions.guard(session)] },
    );
  }
  async removeCredential(session: Session, id: string) {
    this.recentPasskey(session);
    const previous = await this.snapshot(session.subjectId);
    if (!previous.credentials.some((credential) => credential.id === id))
      throw new IdentityError(404, 'NOT_FOUND');
    if (previous.credentials.length <= 1) throw new IdentityError(409, 'LAST_CREDENTIAL');
    const snapshot: Checkpoint = {
      ...previous,
      operationId: crypto.randomUUID(),
      epoch: previous.epoch + 1,
      createdAt: new Date().toISOString(),
      credentials: previous.credentials.filter((credential) => credential.id !== id),
    };
    await this.checkpoints.commit(snapshot, {
      expected: previous,
      guards: [
        this.sessions.guard(session, true, true, true),
        assertion(
          this.db,
          '(SELECT count(*) FROM credentials WHERE owner_id=?)>1',
          session.subjectId,
        ),
      ],
    });
    return this.sessions.issue(
      session.subjectId,
      snapshot.epoch,
      session.authenticatedAt,
      [],
      session.passkeyAuthenticatedAt,
    );
  }
}
