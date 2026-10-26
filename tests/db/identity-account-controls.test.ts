import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, expect, test } from 'vitest';
import { apiSchemas, AuthOptions, AuthResult } from '../../src/contracts/index.ts';
import {
  encode,
  IdentityCrypto,
  randomToken,
  uuidBytes,
} from '../../src/worker/identity/crypto.ts';
import { clearDatabase } from '../fixtures/database.ts';
import { IDENTITY_SECRETS } from '../fixtures/identity.ts';
import { ReadingClient, readingAccount, readingBindings } from '../fixtures/reading-client.ts';
import { syntheticPasskey } from '../fixtures/passkeys.ts';

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(() => clearDatabase(env.DB));
type Passkey = Awaited<ReturnType<typeof syntheticPasskey>>;
async function authenticate(
  client: ReadingClient,
  passkey: Passkey,
  subjectId: string,
  counter = 1,
) {
  const options = AuthOptions.parse(
    await (
      await client.request('/auth/options', {
        purpose: client.cookies.get('__Host-session') ? 'reauthenticate' : 'authenticate',
      })
    ).json(),
  );
  const reply = await client.request('/auth/authenticate', {
    challengeId: options.challengeId,
    credential: await passkey.authenticate(options, encode(uuidBytes(subjectId)), counter),
  });
  expect(reply.status, await reply.clone().text()).toBe(200);
  const result = AuthResult.parse(await reply.json());
  client.csrf = result.csrfToken;
}
async function addition(client: ReadingClient) {
  const reply = await client.request('/auth/options', { purpose: 'add' });
  expect(reply.status, await reply.clone().text()).toBe(200);
  const options = AuthOptions.parse(await reply.json());
  const passkey = await syntheticPasskey();
  return {
    options,
    passkey,
    body: {
      challengeId: options.challengeId,
      credential: await passkey.register(options),
    },
  };
}
async function add(client: ReadingClient) {
  const pending = await addition(client);
  const response = await client.request('/auth/register', pending.body);
  expect(response.status, await response.clone().text()).toBe(200);
  const result = AuthResult.parse(await response.json());
  client.csrf = result.csrfToken;
  return { ...pending, result };
}
async function epoch(subjectId: string) {
  return env.DB.prepare('SELECT auth_epoch FROM accounts WHERE id=?')
    .bind(subjectId)
    .first('auth_epoch');
}
async function factors(subjectId: string) {
  return (
    await env.DB.prepare('SELECT * FROM recovery_codes WHERE owner_id=? ORDER BY code_hash')
      .bind(subjectId)
      .all()
  ).results;
}

test('credential listing reveals only the signed-in account removable metadata', async () => {
  const owner = await readingAccount(false, false);
  const other = await readingAccount(false, false);
  expect((await new ReadingClient().request('/auth/credentials')).status).toBe(401);
  const response = await owner.client.request('/auth/credentials');
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  const listed = apiSchemas.Credentials.parse(await response.json());
  expect(listed.items).toEqual([
    { id: owner.passkey.id, createdAt: expect.any(String), backedUp: false },
  ]);
  expect(JSON.stringify(listed)).not.toContain(other.passkey.id);
});

test('new enrollment alone does not authorize adding another passkey or removing one', async () => {
  const { client, passkey } = await readingAccount(false, false);
  expect((await client.request('/auth/options', { purpose: 'add' })).status).toBe(401);
  expect(
    (await client.request(`/auth/credentials/${passkey.id}`, {}, { method: 'DELETE' })).status,
  ).toBe(401);
});

test('additional passkey enrollment preserves the account kit and keys, checkpoints factors, and revokes other sessions', async () => {
  const { client, passkey, kit } = await readingAccount(true, false);
  const other = new ReadingClient();
  await authenticate(other, passkey, kit.subjectId);
  await authenticate(client, passkey, kit.subjectId, 2);
  const previous = await epoch(kit.subjectId);
  const keys = (await env.DB.prepare('SELECT * FROM account_keys').all()).results;
  const recovery = await factors(kit.subjectId);
  const pending = await addition(client);
  expect(pending.options.excludeCredentialIds).toEqual([passkey.id]);
  expect(pending.options.user?.id).toBe(encode(uuidBytes(kit.subjectId)));
  const response = await client.request('/auth/register', pending.body);
  expect(response.status, await response.clone().text()).toBe(200);
  const result = AuthResult.parse(await response.json());
  client.csrf = result.csrfToken;
  expect(result.subjectId).toBe(kit.subjectId);
  expect(result.recoveryHandle).toBeNull();
  expect(result.recoveryCodes).toEqual([]);
  expect(await epoch(kit.subjectId)).toBe(Number(previous) + 1);
  expect(await factors(kit.subjectId)).toEqual(recovery);
  expect((await env.DB.prepare('SELECT * FROM account_keys').all()).results).toEqual(keys);
  expect(
    await env.DB.prepare('SELECT recovery_ack_at FROM accounts').first('recovery_ack_at'),
  ).not.toBeNull();
  expect((await other.request('/me')).status).toBe(401);
  expect((await client.request('/me')).status).toBe(200);
  const row = await env.DB.prepare(
    'SELECT * FROM security_operations WHERE owner_id=? ORDER BY epoch DESC LIMIT 1',
  )
    .bind(kit.subjectId)
    .first<{ owner_id: string; epoch: number; id: string; ledger_key: string }>();
  const checkpoint = await new IdentityCrypto(IDENTITY_SECRETS).openCheckpoint(
    row!.owner_id,
    row!.epoch,
    row!.id,
    await (await env.RECOVERY.get(row!.ledger_key))!.text(),
  );
  expect(checkpoint.credentials.map((value) => value.id).sort()).toEqual(
    [passkey.id, pending.passkey.id].sort(),
  );
});

test('additional enrollment rechecks CSRF, recent existing-passkey authentication, and live session at finish', async () => {
  const { client, passkey, kit } = await readingAccount(false, false);
  await authenticate(client, passkey, kit.subjectId);
  const pending = await addition(client);
  expect(
    (await client.request('/auth/register', pending.body, { headers: { 'X-CSRF-Token': 'wrong' } }))
      .status,
  ).toBe(403);
  await env.DB.prepare(
    'UPDATE auth_sessions SET authenticated_at=0,passkey_authenticated_at=0',
  ).run();
  expect((await client.request('/auth/register', pending.body)).status).toBe(401);
  await env.DB.prepare('DELETE FROM auth_sessions').run();
  expect((await client.request('/auth/register', pending.body)).status).toBe(401);
  expect(await env.DB.prepare('SELECT count(*) AS n FROM credentials').first('n')).toBe(1);
  expect(await epoch(kit.subjectId)).toBe(1);
});

test('removal is owned, recent, preserves recovery, protects the final factor, and rotates the caller session', async () => {
  const { client, passkey, kit } = await readingAccount(false, false);
  await authenticate(client, passkey, kit.subjectId);
  const second = await add(client);
  const other = new ReadingClient();
  await authenticate(other, passkey, kit.subjectId, 2);
  const foreign = await readingAccount(false, false);
  expect(
    (await client.request(`/auth/credentials/${foreign.passkey.id}`, {}, { method: 'DELETE' }))
      .status,
  ).toBe(404);
  expect(
    (await client.request(`/auth/credentials/${randomToken()}`, {}, { method: 'DELETE' })).status,
  ).toBe(404);
  const recovery = await factors(kit.subjectId);
  const before = await epoch(kit.subjectId);
  const reply = await client.request(
    `/auth/credentials/${second.passkey.id}`,
    {},
    { method: 'DELETE' },
  );
  expect(reply.status, await reply.clone().text()).toBe(204);
  await client.me();
  expect(await epoch(kit.subjectId)).toBe(Number(before) + 1);
  expect(await factors(kit.subjectId)).toEqual(recovery);
  expect((await other.request('/me')).status).toBe(401);
  expect(
    (await client.request(`/auth/credentials/${passkey.id}`, {}, { method: 'DELETE' })).status,
  ).toBe(409);
  const options = AuthOptions.parse(
    await (await other.request('/auth/options', { purpose: 'authenticate' })).json(),
  );
  expect(
    (
      await other.request('/auth/authenticate', {
        challengeId: options.challengeId,
        credential: await second.passkey.authenticate(options, encode(uuidBytes(kit.subjectId))),
      })
    ).status,
  ).toBe(401);
});

test('concurrent additions cannot exceed ten passkeys and a full account cannot start enrollment', async () => {
  const { client, passkey, kit } = await readingAccount(false, false);
  for (let i = 0; i < 8; i++)
    await env.DB.prepare(
      'INSERT INTO credentials(id,owner_id,public_key,sign_count,backed_up,transports_json,created_at) SELECT ?,owner_id,public_key,sign_count,backed_up,transports_json,created_at FROM credentials WHERE id=?',
    )
      .bind(randomToken(), passkey.id)
      .run();
  const other = new ReadingClient();
  await authenticate(other, passkey, kit.subjectId);
  await authenticate(client, passkey, kit.subjectId, 2);
  const first = await addition(client),
    second = await addition(other);
  const results = await Promise.all([
    client.request('/auth/register', first.body),
    other.request('/auth/register', second.body),
  ]);
  expect(results.map((reply) => reply.status).sort()).toEqual([200, 401]);
  expect(
    await env.DB.prepare('SELECT count(*) AS n FROM credentials WHERE owner_id=?')
      .bind(kit.subjectId)
      .first('n'),
  ).toBe(10);
  const winner = results[0]!.status === 200 ? client : other;
  await winner.me();
  expect((await winner.request('/auth/options', { purpose: 'add' })).status).toBe(409);
});

test('a credential already owned by another account cannot fence or merge the enrollment account', async () => {
  const { client, passkey, kit } = await readingAccount(false, false);
  const foreign = await readingAccount(false, false);
  await authenticate(client, passkey, kit.subjectId);
  const pending = await addition(client);
  const response = await client.request('/auth/register', {
    challengeId: pending.options.challengeId,
    credential: await foreign.passkey.register(pending.options),
  });
  expect(response.status).toBe(409);
  expect(
    await env.DB.prepare('SELECT write_fence FROM accounts WHERE id=?')
      .bind(kit.subjectId)
      .first('write_fence'),
  ).toBeNull();
  expect(await epoch(kit.subjectId)).toBe(1);
  expect((await client.request('/me')).status).toBe(200);
  expect((await foreign.client.request('/me')).status).toBe(200);
});

test('checkpoint outage never acknowledges enrollment or grants its replacement session and maintenance resumes it', async () => {
  const { client, passkey, kit } = await readingAccount(false, false);
  await authenticate(client, passkey, kit.subjectId);
  const pending = await addition(client);
  const unavailable = new ReadingClient({
    ...readingBindings,
    RECOVERY: {
      put: async () => {
        throw new Error('synthetic checkpoint outage');
      },
    } as unknown as R2Bucket,
  });
  unavailable.cookies = new Map(client.cookies);
  unavailable.csrf = client.csrf;
  const response = await unavailable.request('/auth/register', pending.body);
  expect(response.status).toBe(503);
  expect(response.headers.getSetCookie()).toEqual([]);
  expect(await env.DB.prepare('SELECT count(*) AS n FROM credentials').first('n')).toBe(2);
  expect(
    await env.DB.prepare(
      'SELECT count(*) AS n FROM credentials c JOIN accounts a ON a.id=c.owner_id WHERE a.write_fence IS NULL',
    ).first('n'),
  ).toBe(0);
  expect(await epoch(kit.subjectId)).toBe(1);
  expect(await env.DB.prepare('SELECT write_fence FROM accounts').first('write_fence')).toMatch(
    /^security:/,
  );
  const { IdentityService } = await import('../../src/worker/identity/service.ts');
  await new IdentityService(
    env.DB,
    env.RECOVERY,
    new IdentityCrypto(IDENTITY_SECRETS),
    'http://localhost:8787',
  ).maintenance();
  expect(await env.DB.prepare('SELECT count(*) AS n FROM credentials').first('n')).toBe(2);
  expect(await epoch(kit.subjectId)).toBe(2);
  expect((await client.request('/me')).status).toBe(401);
});

test('logout-all requires CSRF and atomically revokes every session and owned challenge', async () => {
  const { client, passkey, kit } = await readingAccount(false, false);
  const other = new ReadingClient();
  await authenticate(other, passkey, kit.subjectId);
  await authenticate(client, passkey, kit.subjectId, 2);
  const pending = await addition(client);
  const before = await epoch(kit.subjectId);
  expect(
    (await client.request('/auth/logout-all', {}, { headers: { 'X-CSRF-Token': 'wrong' } })).status,
  ).toBe(403);
  const response = await client.request('/auth/logout-all', {});
  expect(response.status).toBe(204);
  expect(response.headers.getSetCookie().join('\n')).toContain('__Host-session=;');
  expect(await epoch(kit.subjectId)).toBe(Number(before) + 1);
  expect((await client.request('/me')).status).toBe(401);
  expect((await other.request('/me')).status).toBe(401);
  expect((await client.request('/auth/register', pending.body)).status).toBe(401);
  expect(await env.DB.prepare('SELECT count(*) AS n FROM auth_sessions').first('n')).toBe(0);
  expect(
    await env.DB.prepare('SELECT count(*) AS n FROM auth_challenges WHERE owner_id=?')
      .bind(kit.subjectId)
      .first('n'),
  ).toBe(0);
});

test('successful kit recovery does not consume the five failures per hour budget', async () => {
  const { kit } = await readingAccount(false, false);
  const fresh = new ReadingClient();
  for (const code of kit.recoveryCodes.slice(0, 6)) {
    const reply = await fresh.request('/auth/recover', {
      recoveryHandle: kit.recoveryHandle,
      code,
    });
    expect(reply.status, await reply.clone().text()).toBe(200);
  }
  const crypt = new IdentityCrypto(IDENTITY_SECRETS);
  const hash = await crypt.hash('rate', [
    'recovery-handle',
    Math.floor(Date.now() / 86_400_000),
    kit.recoveryHandle,
  ]);
  expect(
    await env.DB.prepare('SELECT count FROM rate_buckets WHERE scope_hash=?')
      .bind(hash)
      .first('count'),
  ).toBeNull();
});

test('five failed kit checks block both that handle and that IP without storing the secrets', async () => {
  const { kit } = await readingAccount(false, false);
  const failed = new ReadingClient();
  for (let attempt = 0; attempt < 5; attempt++) {
    expect(
      (
        await failed.request('/auth/recover', {
          recoveryHandle: kit.recoveryHandle,
          code: randomToken(16),
        })
      ).status,
    ).toBe(401);
  }
  const otherIp = new ReadingClient();
  expect(
    (
      await otherIp.request('/auth/recover', {
        recoveryHandle: kit.recoveryHandle,
        code: kit.recoveryCodes[0],
      })
    ).status,
  ).toBe(429);
  expect(
    (
      await failed.request('/auth/recover', {
        recoveryHandle: 'unknown-handle',
        code: randomToken(16),
      })
    ).status,
  ).toBe(429);
  const stored = JSON.stringify(await env.DB.prepare('SELECT * FROM rate_buckets').all());
  expect(stored).not.toContain(kit.recoveryHandle);
  expect(stored).not.toContain(failed.ip);
});

test('credential removal accepts the published bodyless DELETE and rejects an expired passkey assertion', async () => {
  const { client, passkey, kit } = await readingAccount(false, false);
  await authenticate(client, passkey, kit.subjectId);
  const second = await add(client);
  await env.DB.prepare('UPDATE auth_sessions SET passkey_authenticated_at=0').run();
  expect(
    (await client.request(`/auth/credentials/${second.passkey.id}`, {}, { method: 'DELETE' }))
      .status,
  ).toBe(401);
  await authenticate(client, passkey, kit.subjectId, 2);
  expect(
    (
      await client.request(`/auth/credentials/${second.passkey.id}`, undefined, {
        method: 'DELETE',
      })
    ).status,
  ).toBe(204);
  await client.me();
  expect(
    apiSchemas.Credentials.parse(
      await (await client.request('/auth/credentials')).json(),
    ).items.map((value) => value.id),
  ).toEqual([passkey.id]);
});

test('a recovery checkpoint dependency failure does not consume the failure budget', async () => {
  const { kit } = await readingAccount(false, false);
  const unavailable = new ReadingClient({
    ...readingBindings,
    RECOVERY: {
      put: async () => {
        throw new Error('synthetic checkpoint outage');
      },
    } as unknown as R2Bucket,
  });
  const before = (await env.DB.prepare('SELECT * FROM rate_buckets ORDER BY scope_hash').all())
    .results;
  expect(
    (
      await unavailable.request('/auth/recover', {
        recoveryHandle: kit.recoveryHandle,
        code: kit.recoveryCodes[0],
      })
    ).status,
  ).toBe(503);
  expect(
    (await env.DB.prepare('SELECT * FROM rate_buckets ORDER BY scope_hash').all()).results,
  ).toEqual(before);
});
