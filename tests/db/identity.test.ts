import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, expect, test } from 'vitest';
import { apiSchemas, AuthOptions, AuthResult } from '../../src/contracts/index.ts';
import worker, { type Env } from '../../src/worker/index.ts';
import { encode, uuidBytes } from '../../src/worker/identity/crypto.ts';
import { clearDatabase } from '../fixtures/database.ts';
import { IDENTITY_SECRETS, IDENTITY_ORIGIN } from '../fixtures/identity.ts';
import { syntheticPasskey } from '../fixtures/passkeys.ts';
const bindings = {
  DB: env.DB,
  RECOVERY: env.RECOVERY,
  IDENTITY_MODE: 'synthetic-local',
  IDENTITY_ORIGIN,
  IDENTITY_SECRETS: JSON.stringify(IDENTITY_SECRETS),
} as Env;
beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(() => clearDatabase(env.DB));
class Client {
  cookies = new Map<string, string>();
  csrf = '';
  async request(path: string, body?: unknown, headers: Record<string, string> = {}) {
    const response = await worker.fetch(
      new Request(IDENTITY_ORIGIN + '/api/v1' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Origin: IDENTITY_ORIGIN,
          'Content-Type': 'application/json',
          Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
          'X-CSRF-Token': this.csrf,
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      bindings,
    );
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0]!.split('=');
      this.cookies.set(pair[0]!, pair.slice(1).join('='));
    }
    return response;
  }
  async options(purpose = 'register') {
    const response = await this.request('/auth/options', { purpose });
    expect(response.status).toBe(200);
    return AuthOptions.parse(await response.json());
  }
}
async function register(client = new Client()) {
  const passkey = await syntheticPasskey();
  const options = await client.options();
  const response = await client.request('/auth/register', {
    challengeId: options.challengeId,
    credential: await passkey.register(options),
  });
  expect(response.status).toBe(200);
  const result = AuthResult.parse(await response.json());
  client.csrf = result.csrfToken;
  return { client, passkey, result };
}
test('real WebAuthn registration creates a hash-only account, complete kit and consent-off session', async () => {
  const { client, result } = await register();
  expect(result.recoveryCodes).toHaveLength(10);
  expect(result.recoveryHandle).toBeTruthy();
  const me = apiSchemas.SessionView.parse(await (await client.request('/me')).json());
  expect(me.subjectId).toBe(result.subjectId);
  expect(me.permission.modelAllowed).toBe(false);
  const rows = await env.DB.prepare(
    'SELECT * FROM accounts JOIN recovery_codes ON accounts.id=recovery_codes.owner_id',
  ).all();
  const stored = JSON.stringify(rows);
  expect(stored).not.toContain(result.recoveryHandle!);
  for (const code of result.recoveryCodes) expect(stored).not.toContain(code);
});
test('wrong browser, origin, user verification and replay fail before account creation', async () => {
  const client = new Client(),
    key = await syntheticPasskey(),
    options = await client.options();
  const credential = await key.register(options);
  expect(
    (await new Client().request('/auth/register', { challengeId: options.challengeId, credential }))
      .status,
  ).toBe(401);
  expect(
    (
      await client.request(
        '/auth/register',
        { challengeId: options.challengeId, credential },
        { Origin: 'https://evil.test' },
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await client.request('/auth/register', {
        challengeId: options.challengeId,
        credential: await key.register(options, IDENTITY_ORIGIN, false),
      })
    ).status,
  ).toBe(401);
  const replies = await Promise.all(
    [1, 2].map(() =>
      client.request('/auth/register', { challengeId: options.challengeId, credential }),
    ),
  );
  expect(replies.map((r) => r.status).sort()).toEqual([200, 401]);
});
test('login checks subject and signature counters, and logout invalidates the session', async () => {
  const { client, passkey, result } = await register();
  expect((await client.request('/auth/logout', {})).status).toBe(204);
  expect((await client.request('/me')).status).toBe(401);
  const options = await client.options('authenticate');
  expect(
    (
      await client.request('/auth/authenticate', {
        challengeId: options.challengeId,
        credential: await passkey.authenticate(options, encode(uuidBytes(crypto.randomUUID()))),
      })
    ).status,
  ).toBe(401);
  const response = await client.request('/auth/authenticate', {
    challengeId: options.challengeId,
    credential: await passkey.authenticate(options, encode(uuidBytes(result.subjectId))),
  });
  expect(response.status).toBe(200);
  const logged = AuthResult.parse(await response.json());
  expect(logged.recoveryCodes).toEqual([]);
  expect(logged.recoveryHandle).toBeNull();
});
test('kit recovery alone grants no account access until replacement passkey enrollment; keys survive', async () => {
  const { client, result, passkey } = await register();
  const keys = await env.DB.prepare('SELECT * FROM account_keys').first();
  const fresh = new Client();
  const response = await fresh.request('/auth/recover', {
    recoveryHandle: result.recoveryHandle,
    code: result.recoveryCodes[0],
  });
  expect(response.status).toBe(200);
  const grant = apiSchemas.RecoveryGrant.parse(await response.json());
  expect((await fresh.request('/me')).status).toBe(401);
  expect((await client.request('/me')).status).toBe(401);
  expect(
    (
      await new Client().request('/auth/recover', {
        recoveryHandle: result.recoveryHandle,
        code: result.recoveryCodes[0],
      })
    ).status,
  ).toBe(401);
  const replacement = await syntheticPasskey();
  const finish = await fresh.request('/auth/register', {
    challengeId: grant.challengeId,
    credential: await replacement.register(grant.options),
  });
  expect(finish.status).toBe(200);
  const recovered = AuthResult.parse(await finish.json());
  expect(recovered.subjectId).toBe(result.subjectId);
  expect(recovered.recoveryCodes).toHaveLength(10);
  expect(recovered.recoveryHandle).not.toBe(result.recoveryHandle);
  expect(await env.DB.prepare('SELECT * FROM account_keys').first()).toEqual(keys);
  const oldOptions = await client.options('authenticate');
  expect(
    (
      await client.request('/auth/authenticate', {
        challengeId: oldOptions.challengeId,
        credential: await passkey.authenticate(oldOptions, encode(uuidBytes(result.subjectId))),
      })
    ).status,
  ).toBe(401);
});
test('CSRF, expiry and stale recovery challenges fail closed', async () => {
  const { client, result } = await register();
  expect((await client.request('/auth/recovery/ack', {}, { 'X-CSRF-Token': 'wrong' })).status).toBe(
    403,
  );
  expect((await client.request('/auth/recovery/ack', {})).status).toBe(204);
  expect(
    await env.DB.prepare('SELECT recovery_ack_at FROM accounts').first('recovery_ack_at'),
  ).toBeGreaterThan(0);
  // Ack rotates the session; /me derives its new CSRF token.
  const me = apiSchemas.SessionView.parse(await (await client.request('/me')).json());
  client.csrf = me.csrfToken;
  const fresh = new Client();
  const first = apiSchemas.RecoveryGrant.parse(
    await (
      await fresh.request('/auth/recover', {
        recoveryHandle: result.recoveryHandle,
        code: result.recoveryCodes[0],
      })
    ).json(),
  );
  await env.DB.prepare('UPDATE auth_challenges SET expires_at=0 WHERE id=?')
    .bind(first.challengeId)
    .run();
  const key = await syntheticPasskey();
  expect(
    (
      await fresh.request('/auth/register', {
        challengeId: first.challengeId,
        credential: await key.register(first.options),
      })
    ).status,
  ).toBe(401);
});

test('identity errors use the published envelope and never include credential details', async () => {
  const response = await new Client().request('/auth/recover', {
    recoveryHandle: 'missing',
    code: 'abc',
  });
  expect(response.status).toBe(401);
  const error = apiSchemas.ErrorEnvelope.parse(await response.json());
  expect(error.error.code).toBe('UNAUTHENTICATED');
  expect(error.error.message).toContain('recovery handle and code were not accepted');
  expect(error.error.retry).toBe('never');
  expect(JSON.stringify(error)).not.toContain('missing');
});
test('registration failures name the actionable cause while staying in the generic envelope', async () => {
  const messageOf = async (response: Response) => {
    expect(response.status).toBe(401);
    const error = apiSchemas.ErrorEnvelope.parse(await response.json());
    expect(error.error.code).toBe('UNAUTHENTICATED');
    return error.error;
  };
  // No challenge cookie in this browser.
  const orphan = new Client(),
    orphanKey = await syntheticPasskey(),
    orphanOptions = await orphan.options();
  const missing = await messageOf(
    await new Client().request('/auth/register', {
      challengeId: orphanOptions.challengeId,
      credential: await orphanKey.register(orphanOptions),
    }),
  );
  expect(missing.message).toContain('not found in this browser');
  expect(missing.retry).toBe('refresh_then_retry');
  // Challenge left to expire.
  const expiredClient = new Client(),
    expiredKey = await syntheticPasskey(),
    expiredOptions = await expiredClient.options();
  await env.DB.prepare('UPDATE auth_challenges SET expires_at=0 WHERE id=?')
    .bind(expiredOptions.challengeId)
    .run();
  const expired = await messageOf(
    await expiredClient.request('/auth/register', {
      challengeId: expiredOptions.challengeId,
      credential: await expiredKey.register(expiredOptions),
    }),
  );
  expect(expired.message).toContain('expired');
  expect(expired.retry).toBe('refresh_then_retry');
  // Authenticator did not report a discoverable credential.
  const rkClient = new Client(),
    rkKey = await syntheticPasskey(),
    rkOptions = await rkClient.options();
  const rkCredential = await rkKey.register(rkOptions);
  const notDiscoverable = await messageOf(
    await rkClient.request('/auth/register', {
      challengeId: rkOptions.challengeId,
      credential: {
        ...rkCredential,
        clientExtensionResults: { credProps: { rk: false } },
      },
    }),
  );
  expect(notDiscoverable.message).toContain('discoverable');
  // Authenticator did not perform user verification.
  const uvClient = new Client(),
    uvKey = await syntheticPasskey(),
    uvOptions = await uvClient.options();
  const unverified = await messageOf(
    await uvClient.request('/auth/register', {
      challengeId: uvOptions.challengeId,
      credential: await uvKey.register(uvOptions, IDENTITY_ORIGIN, false),
    }),
  );
  expect(unverified.message).toContain('verification was not completed');
  // A consumed challenge cannot be replayed.
  const usedClient = new Client(),
    usedKey = await syntheticPasskey(),
    usedOptions = await usedClient.options();
  const usedBody = {
    challengeId: usedOptions.challengeId,
    credential: await usedKey.register(usedOptions),
  };
  const browserCookie = usedClient.cookies.get('__Host-challenge')!;
  expect((await usedClient.request('/auth/register', usedBody)).status).toBe(200);
  // Success clears the cookie; restore it to replay against the consumed challenge.
  usedClient.cookies.set('__Host-challenge', browserCookie);
  const used = await messageOf(await usedClient.request('/auth/register', usedBody));
  expect(used.message).toContain('already used');
  expect(used.retry).toBe('refresh_then_retry');
});
test('rate limits deny new challenges and do not store raw addresses', async () => {
  const client = new Client();
  for (let i = 0; i < 10; i++)
    expect(
      (
        await client.request(
          '/auth/options',
          { purpose: 'register' },
          { 'CF-Connecting-IP': '192.0.2.99' },
        )
      ).status,
    ).toBe(200);
  expect(
    (
      await client.request(
        '/auth/options',
        { purpose: 'register' },
        { 'CF-Connecting-IP': '192.0.2.99' },
      )
    ).status,
  ).toBe(429);
  expect(JSON.stringify(await env.DB.prepare('SELECT * FROM rate_buckets').all())).not.toContain(
    '192.0.2.99',
  );
});
test('session expiry and positive authenticator counter rollback deny authentication', async () => {
  const { client, passkey, result } = await register();
  await env.DB.prepare('UPDATE auth_sessions SET idle_expires_at=0').run();
  expect((await client.request('/me')).status).toBe(401);
  let options = await client.options('authenticate');
  const response = await client.request('/auth/authenticate', {
    challengeId: options.challengeId,
    credential: await passkey.authenticate(options, encode(uuidBytes(result.subjectId)), 10),
  });
  expect(response.status).toBe(200);
  options = await client.options('authenticate');
  expect(
    (
      await client.request('/auth/authenticate', {
        challengeId: options.challengeId,
        credential: await passkey.authenticate(options, encode(uuidBytes(result.subjectId)), 9),
      })
    ).status,
  ).toBe(401);
});
test('rotating a kit invalidates every prior handle/code and requires recent authentication', async () => {
  const { client, result } = await register();
  const response = await client.request('/auth/recovery-codes', {});
  expect(response.status).toBe(200);
  const kit = apiSchemas.RecoveryCodes.parse(await response.json());
  expect(kit.codes).toHaveLength(10);
  expect(
    (
      await new Client().request('/auth/recover', {
        recoveryHandle: result.recoveryHandle,
        code: result.recoveryCodes[1],
      })
    ).status,
  ).toBe(401);
  const me = apiSchemas.SessionView.parse(await (await client.request('/me')).json());
  client.csrf = me.csrfToken;
  await env.DB.prepare('UPDATE auth_sessions SET authenticated_at=0').run();
  expect((await client.request('/auth/recovery-codes', {})).status).toBe(401);
});

test('scheduled maintenance removes expired auth/rate records without changing active accounts', async () => {
  const { result } = await register();
  await env.DB.prepare('UPDATE auth_challenges SET expires_at=0').run();
  await env.DB.prepare('UPDATE auth_sessions SET idle_expires_at=0').run();
  await env.DB.prepare('UPDATE rate_buckets SET expires_at=0').run();
  await worker.scheduled({} as ScheduledController, bindings, {} as ExecutionContext);
  for (const table of ['auth_challenges', 'auth_sessions', 'rate_buckets'])
    expect(await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first('n')).toBe(0);
  expect(await env.DB.prepare('SELECT id FROM accounts').first('id')).toBe(result.subjectId);
});

test('concurrent use of the same recovery code consumes it once and issues no full session', async () => {
  const { result } = await register();
  const replies = await Promise.all(
    [new Client(), new Client()].map((client) =>
      client.request('/auth/recover', {
        recoveryHandle: result.recoveryHandle,
        code: result.recoveryCodes[0],
      }),
    ),
  );
  expect(replies.map((reply) => reply.status).sort()).toEqual([200, 401]);
  expect(
    await env.DB.prepare(
      'SELECT count(*) AS n FROM recovery_codes WHERE used_at IS NOT NULL',
    ).first('n'),
  ).toBe(1);
  expect(await env.DB.prepare('SELECT auth_epoch FROM accounts').first('auth_epoch')).toBe(2);
  expect(await env.DB.prepare('SELECT count(*) AS n FROM auth_sessions').first('n')).toBe(0);
});
test('database-clock expiry after WebAuthn verification rolls back registration without changing its deadline', async () => {
  const { IdentityService } = await import('../../src/worker/identity/service.ts');
  const { IdentityCrypto } = await import('../../src/worker/identity/crypto.ts');
  const client = new Client(),
    key = await syntheticPasskey(),
    options = await client.options();
  const credential = await key.register(options);
  const deadline = Date.now() + 500;
  await env.DB.prepare('UPDATE auth_challenges SET expires_at=? WHERE id=?')
    .bind(deadline, options.challengeId)
    .run();
  let pausedAfterVerification = false;
  const database = new Proxy(env.DB, {
    get(target, property) {
      if (property === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          pausedAfterVerification = true;
          while (
            Number(
              await target
                .prepare("SELECT CAST(unixepoch('subsec')*1000 AS INTEGER) AS now")
                .first('now'),
            ) <= deadline
          )
            await new Promise((resolve) => setTimeout(resolve, 10));
          return target.batch(statements);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const service = new IdentityService(
    database,
    env.RECOVERY,
    new IdentityCrypto(IDENTITY_SECRETS),
    IDENTITY_ORIGIN,
  );
  await expect(
    service.register(
      { challengeId: options.challengeId, credential },
      client.cookies.get('__Host-challenge'),
    ),
  ).rejects.toThrow(/CHECK constraint failed/);
  expect(pausedAfterVerification).toBe(true);
  expect(
    await env.DB.prepare('SELECT expires_at FROM auth_challenges WHERE id=?')
      .bind(options.challengeId)
      .first('expires_at'),
  ).toBe(deadline);
  expect(
    await env.DB.prepare('SELECT consumed_at FROM auth_challenges WHERE id=?')
      .bind(options.challengeId)
      .first('consumed_at'),
  ).toBeNull();
  expect(await env.DB.prepare('SELECT count(*) AS n FROM accounts').first('n')).toBe(0);
});
