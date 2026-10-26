import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, expect, test } from 'vitest';
import { apiSchemas, AuthOptions } from '../../src/contracts/index.ts';
import { encode, uuidBytes } from '../../src/worker/identity/crypto.ts';
import { localIdentity } from '../../src/worker/identity/routes.ts';
import { clearDatabase } from '../fixtures/database.ts';
import {
  ReadingClient,
  readingAccount,
  readingBindings,
  login,
} from '../fixtures/reading-client.ts';
import { syntheticPasskey } from '../fixtures/passkeys.ts';

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(() => clearDatabase(env.DB));

test('competing enrollment reserves one credential ID before either checkpoint can become durable', async () => {
  const owners = [await readingAccount(false, false), await readingAccount(false, false)];
  for (const owner of owners) await login(owner.client, owner.passkey, owner.kit.subjectId);
  const statements = new WeakMap<object, string>();
  let batches = 0,
    puts = 0;
  let releaseBatches!: () => void, releasePuts!: () => void, progressed!: () => void;
  const together = new Promise<void>((resolve) => {
    releaseBatches = resolve;
  });
  const held = new Promise<void>((resolve) => {
    releasePuts = resolve;
  });
  const progress = new Promise<void>((resolve) => {
    progressed = resolve;
  });
  const db = new Proxy(env.DB, {
    get(target, property) {
      if (property === 'prepare')
        return (sql: string) => {
          const prepared = target.prepare(sql);
          return new Proxy(prepared, {
            get(statement, name) {
              if (name === 'bind')
                return (...values: unknown[]) => {
                  const bound = statement.bind(...values);
                  statements.set(bound, sql);
                  return bound;
                };
              const value = Reflect.get(statement, name, statement);
              return typeof value === 'function' ? value.bind(statement) : value;
            },
          });
        };
      if (property === 'batch')
        return async (batch: D1PreparedStatement[]) => {
          if (
            batch.some((item) =>
              statements.get(item)?.startsWith('INSERT INTO security_operations'),
            )
          ) {
            if (++batches === 2) releaseBatches();
            await together;
          }
          return target.batch(batch);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const bucket = new Proxy(env.RECOVERY, {
    get(target, property) {
      if (property === 'put')
        return async (...args: Parameters<R2Bucket['put']>) => {
          if (++puts === 2) progressed();
          await held;
          return target.put(...args);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const samePasskey = await syntheticPasskey();
  const clients = owners.map((owner) => {
    const client = new ReadingClient({ ...readingBindings, DB: db, RECOVERY: bucket });
    client.cookies = new Map(owner.client.cookies);
    client.csrf = owner.client.csrf;
    return client;
  });
  const pending = await Promise.all(
    clients.map(async (client) => {
      const options = AuthOptions.parse(
        await (await client.request('/auth/options', { purpose: 'add' })).json(),
      );
      return { challengeId: options.challengeId, credential: await samePasskey.register(options) };
    }),
  );
  const replies = clients.map((client, i) =>
    client.request('/auth/register', pending[i]).then((response) => {
      progressed();
      return response;
    }),
  );
  let fenced: unknown;
  try {
    // Either the loser rolls back before R2, or the unfixed race reaches both R2 writes.
    await progress;
    fenced = await env.DB.prepare(
      'SELECT count(*) AS n FROM accounts WHERE write_fence IS NOT NULL',
    ).first('n');
  } finally {
    releasePuts();
  }
  const results = await Promise.all(replies);
  expect(fenced).toBe(1);
  expect(results.map((reply) => reply.status).sort()).toEqual([200, 401]);
  await localIdentity(readingBindings)!.maintenance();
  expect(
    await env.DB.prepare('SELECT count(*) AS n FROM accounts WHERE write_fence IS NOT NULL').first(
      'n',
    ),
  ).toBe(0);
  expect(
    await env.DB.prepare(
      "SELECT count(*) AS n FROM security_operations WHERE state<>'applied'",
    ).first('n'),
  ).toBe(0);
  expect(
    await env.DB.prepare('SELECT count(*) AS n FROM credentials WHERE id=?')
      .bind(samePasskey.id)
      .first('n'),
  ).toBe(1);
  for (const client of clients) expect((await client.request('/me')).status).toBe(200);
});

test.each(['register', 'add', 'recover'] as const)(
  'a %s credential reservation stays unusable until its checkpoint is durable',
  async (purpose) => {
    const owner = purpose === 'register' ? null : await readingAccount(false, false);
    if (purpose === 'add') await login(owner!.client, owner!.passkey, owner!.kit.subjectId);
    const client = new ReadingClient({
      ...readingBindings,
      RECOVERY: {
        put: async () => {
          throw new Error('synthetic checkpoint outage');
        },
      } as unknown as R2Bucket,
    });
    if (owner && purpose === 'add') {
      client.cookies = new Map(owner.client.cookies);
      client.csrf = owner.client.csrf;
    }
    let options: ReturnType<typeof AuthOptions.parse>;
    if (purpose === 'recover') {
      const recovery = new ReadingClient();
      const grant = apiSchemas.RecoveryGrant.parse(
        await (
          await recovery.request('/auth/recover', {
            recoveryHandle: owner!.kit.recoveryHandle,
            code: owner!.kit.recoveryCodes[0],
          })
        ).json(),
      );
      options = grant.options;
      client.cookies = new Map(recovery.cookies);
    } else {
      options = AuthOptions.parse(
        await (await client.request('/auth/options', { purpose })).json(),
      );
    }
    const passkey = await syntheticPasskey();
    const response = await client.request('/auth/register', {
      challengeId: options.challengeId,
      credential: await passkey.register(options),
    });
    expect(response.status).toBe(503);
    const reserved = await env.DB.prepare('SELECT owner_id FROM credentials WHERE id=?')
      .bind(passkey.id)
      .first<string>('owner_id');
    expect(reserved).toBe(owner?.kit.subjectId ?? options.challengeId);
    const unauthenticated = new ReadingClient();
    const challenge = AuthOptions.parse(
      await (await unauthenticated.request('/auth/options', { purpose: 'authenticate' })).json(),
    );
    expect(
      (
        await unauthenticated.request('/auth/authenticate', {
          challengeId: challenge.challengeId,
          credential: await passkey.authenticate(challenge, encode(uuidBytes(reserved!))),
        })
      ).status,
    ).toBe(401);
    expect((await unauthenticated.request('/me')).status).toBe(401);
    if (purpose === 'add') expect((await client.request('/auth/credentials')).status).toBe(503);
    await localIdentity(readingBindings)!.maintenance();
    await login(unauthenticated, passkey, reserved!);
    expect((await unauthenticated.request('/me')).status).toBe(200);
  },
);
