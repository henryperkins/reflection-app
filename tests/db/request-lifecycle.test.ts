import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, expect, test } from 'vitest';
import { apiSchemas, type WriterOutcome } from '../../src/contracts/index.ts';
import { localIdentity } from '../../src/worker/identity/routes.ts';
import { RecordBase } from '../../src/worker/readings/base.ts';
import { LocalGeneration } from '../../src/worker/readings/generation.ts';
import { InterceptedWritingProvider } from '../../src/worker/provider/intercepted.ts';
import { RetentionMaintenance } from '../../src/worker/maintenance/retention.ts';
import { clearDatabase } from '../fixtures/database.ts';
import { gate } from '../fixtures/barrier.ts';
import { ReadingClient, readingAccount, readingBindings } from '../fixtures/reading-client.ts';

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(() => clearDatabase(env.DB));

function controlled(client: ReadingClient, db: D1Database) {
  const next = new ReadingClient({ ...readingBindings, DB: db });
  next.cookies = client.cookies;
  next.csrf = client.csrf;
  return next;
}
async function status(client: ReadingClient, id: string, after = 0) {
  return apiSchemas.RequestStatus.parse(
    await (await client.request(`/requests/${id}?after=${after}`)).json(),
  );
}
async function service(client: ReadingClient, outcome?: WriterOutcome) {
  const identity = localIdentity(client.bindings)!;
  const session = await identity.sessions.get(client.cookies.get('__Host-session'));
  const base = new RecordBase(client.bindings.DB, identity);
  const generation = new LocalGeneration(
    base,
    outcome ? new InterceptedWritingProvider({ outcome }) : undefined,
  );
  const view = await client.me();
  const input = {
    clientIntentId: crypto.randomUUID(),
    question: 'Synthetic lifecycle question',
    languageConfirmed: 'en' as const,
    reversals: false,
    permissionRevision: view.permission.revision,
    parentEditionId: null,
    selection: [],
  };
  return { generation, session, input };
}

test('status keeps its cursor when retention prunes events between reads', async () => {
  const { client } = await readingAccount();
  const { started } = await client.create();
  const previous = await status(client, started.requestId);
  await env.DB.prepare('UPDATE request_events SET created_at=1').run();
  let armed = true;
  const db = new Proxy(env.DB, {
    get(target, property) {
      if (property === 'prepare')
        return (sql: string) => {
          const prepared = target.prepare(sql);
          if (!sql.startsWith('SELECT r.*,e.id AS edition_id')) return prepared;
          return new Proxy(prepared, {
            get(statement, name) {
              if (name === 'bind')
                return (...values: unknown[]) => {
                  const bound = statement.bind(...values);
                  return new Proxy(bound, {
                    get(query, operation) {
                      if (operation === 'first')
                        return async () => {
                          const row = await query.first();
                          if (armed) {
                            armed = false;
                            await new RetentionMaintenance(env.DB).run();
                          }
                          return row;
                        };
                      const value = Reflect.get(query, operation, query);
                      return typeof value === 'function' ? value.bind(query) : value;
                    },
                  });
                };
              const value = Reflect.get(statement, name, statement);
              return typeof value === 'function' ? value.bind(statement) : value;
            },
          });
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  expect((await status(controlled(client, db), started.requestId)).nextSequence).toBe(
    previous.nextSequence,
  );
  await new RetentionMaintenance(env.DB).run();
  expect(await status(client, started.requestId)).toMatchObject({
    events: [],
    nextSequence: previous.nextSequence,
  });
});

test('status honors after and rejects malformed or negative cursors', async () => {
  const { client } = await readingAccount();
  const { started } = await client.create();
  const snapshot = await status(client, started.requestId);
  expect((await status(client, started.requestId, snapshot.nextSequence)).events).toEqual([]);
  for (const after of ['-1', 'NaN', '1.5', '9007199254740992'])
    expect((await client.request(`/requests/${started.requestId}?after=${after}`)).status).toBe(
      400,
    );
});

test('status preserves cursors for pre-watermark records and pages more than twenty events', async () => {
  const { client, kit } = await readingAccount();
  const { started } = await client.create();
  const prior = await status(client, started.requestId);
  await env.DB.prepare('UPDATE generation_requests SET next_event=1').run();
  expect((await status(client, started.requestId, prior.nextSequence)).nextSequence).toBe(
    prior.nextSequence,
  );
  await env.DB.batch(
    Array.from({ length: 25 }, (_, i) =>
      env.DB.prepare(
        "INSERT INTO request_events(request_id,owner_id,sequence,state,code,created_at) VALUES (?, ?, ?, 'published', 'ACCEPTED', 1)",
      ).bind(started.requestId, kit.subjectId, prior.nextSequence + i + 1),
    ),
  );
  const page = await status(client, started.requestId);
  expect(page.events).toHaveLength(20);
  expect(page.nextSequence).toBe(20);
  const tail = await status(client, started.requestId, page.nextSequence);
  expect(tail.events[0]?.sequence).toBe(21);
  expect(tail.nextSequence).toBe(prior.nextSequence + 25);
});

test('deferred Start acknowledges admission and resolves an owned intent without redispatch', async () => {
  const { client } = await readingAccount();
  const { generation, session, input } = await service(client);
  const work: Promise<void>[] = [];
  const key = crypto.randomUUID();
  const started = await generation.start(session, input, key, (p) => {
    work.push(p);
  });
  try {
    expect(started.status.state).toBe('prepared');
    const reply = await client.request(`/requests?intentId=${input.clientIntentId}`);
    expect(reply.status).toBe(200);
    expect(apiSchemas.RequestStatus.parse(await reply.json()).requestId).toBe(started.requestId);
    const other = await readingAccount();
    expect((await other.client.request(`/requests?intentId=${input.clientIntentId}`)).status).toBe(
      404,
    );
  } finally {
    await Promise.all(work);
  }
  const joined = await generation.start(session, input, key);
  expect(joined).toMatchObject({
    joined: true,
    requestId: started.requestId,
    status: { state: 'published' },
  });
  expect(await env.DB.prepare('SELECT count(*) AS n FROM provider_dispatches').first('n')).toBe(1);
  expect((await client.me()).remainingDay).toBe(2);
});

test.each(['dispatch', 'publication'])(
  'cancellation before %s fences late work and releases allowance exactly once',
  async (stage) => {
    const { client } = await readingAccount();
    const barrier = gate((sql) =>
      sql.some((s) =>
        s.startsWith(
          stage === 'dispatch' ? 'INSERT INTO provider_dispatches' : 'INSERT INTO reading_editions',
        ),
      ),
    );
    const pending = controlled(client, barrier.db).start();
    await barrier.ready;
    const id = (await env.DB.prepare('SELECT id FROM generation_requests').first<string>('id'))!;
    const snapshot = await status(client, id);
    const key = crypto.randomUUID();
    try {
      const reply = await client.request(
        `/requests/${id}/cancel`,
        {},
        { revision: snapshot.revision, key },
      );
      expect(reply.status).toBe(200);
      expect(apiSchemas.RequestStatus.parse(await reply.json()).state).toBe('cancelled');
      expect(
        (await client.request(`/requests/${id}/cancel`, {}, { revision: snapshot.revision, key }))
          .status,
      ).toBe(200);
    } finally {
      barrier.release();
      await pending;
    }
    expect((await status(client, id)).state).toBe('cancelled');
    expect(await env.DB.prepare('SELECT count(*) AS n FROM reading_editions').first('n')).toBe(0);
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM quota_events WHERE event='release'").first(
        'n',
      ),
    ).toBe(1);
    expect((await client.me()).remainingDay).toBe(3);
    expect((await status(client, id)).events.at(-1)).toMatchObject({
      code: 'STOPPED',
      errorCode: 'CANCELLED',
    });
  },
);

test('cancellation checks owner and revision and preserves a published reading', async () => {
  const { client } = await readingAccount();
  const { started, reading } = await client.create();
  const id = started.requestId;
  const snapshot = await status(client, id);
  const other = await readingAccount();
  expect(
    (await other.client.request(`/requests/${id}/cancel`, {}, { revision: snapshot.revision }))
      .status,
  ).toBe(404);
  expect((await client.request(`/requests/${id}/cancel`, {})).status).toBe(428);
  expect(
    (await client.request(`/requests/${id}/cancel`, {}, { revision: snapshot.revision - 1 }))
      .status,
  ).toBe(409);
  expect(
    (await client.request(`/requests/${id}/cancel`, {}, { revision: snapshot.revision })).status,
  ).toBe(409);
  expect(await (await client.request(`/readings/${snapshot.editionId}`)).json()).toEqual(reading);
  expect((await client.me()).remainingDay).toBe(2);
});

test.each([
  [{ kind: 'refusal', receipt: null }, 'blocked', 'PROVIDER_REFUSAL'],
  [{ kind: 'rejected', status: 503, receipt: null }, 'published', null],
  [{ kind: 'uncertain', reason: 'timeout', receipt: null }, 'published', null],
] as const)(
  'writer outcome %j is distinct and never retried',
  async (outcome, state, errorCode) => {
    const { client } = await readingAccount();
    const { generation, session, input } = await service(client, outcome);
    const key = crypto.randomUUID();
    const first = await generation.start(session, input, key);
    expect(first.status).toMatchObject({ state, errorCode });
    if (state === 'published') {
      const reading = apiSchemas.Reading.parse(
        await (await client.request(`/readings/${first.status.editionId}`)).json(),
      );
      expect(reading).toMatchObject({
        mode: 'template',
        provenance: { fallbackReason: outcome.kind === 'uncertain' ? 'TIMEOUT_UNKNOWN' : 'OUTAGE' },
      });
    } else expect(first.status.editionId).toBeNull();
    const retry = await generation.start(session, input, key);
    expect(retry).toMatchObject({ joined: true, requestId: first.requestId });
    expect(await env.DB.prepare('SELECT count(*) AS n FROM provider_dispatches').first('n')).toBe(
      1,
    );
    expect((await client.me()).remainingDay).toBe(3);
  },
);

test('consent revocation records STOPPED before a delayed writer can publish', async () => {
  const { client } = await readingAccount();
  const barrier = gate((sql) => sql.some((s) => s.startsWith('INSERT INTO reading_editions')));
  const pending = controlled(client, barrier.db).start();
  await barrier.ready;
  try {
    await client.permission(false);
  } finally {
    barrier.release();
    await pending;
  }
  const id = (await env.DB.prepare('SELECT id FROM generation_requests').first<string>('id'))!;
  const snapshot = await status(client, id);
  expect(snapshot).toMatchObject({ state: 'blocked', errorCode: 'CONSENT_REQUIRED' });
  expect(snapshot.events.at(-1)).toMatchObject({ code: 'STOPPED', errorCode: 'CONSENT_REQUIRED' });
  expect((await client.me()).remainingDay).toBe(3);
});

test('expiry stops an unfinished request without reporting consent withdrawal', async () => {
  const { client } = await readingAccount();
  const barrier = gate((sql) => sql.some((s) => s.startsWith('INSERT INTO reading_editions')));
  const pending = controlled(client, barrier.db).start();
  await barrier.ready;
  const { generation } = await service(client);
  try {
    await env.DB.prepare('UPDATE generation_requests SET created_at=0,expires_at=1').run();
    await generation.maintenance();
  } finally {
    barrier.release();
    await pending;
  }
  const id = (await env.DB.prepare('SELECT id FROM generation_requests').first<string>('id'))!;
  expect((await status(client, id)).events.at(-1)).toMatchObject({
    code: 'STOPPED',
    errorCode: 'EXPIRED',
  });
  expect((await client.me()).remainingDay).toBe(3);
});
