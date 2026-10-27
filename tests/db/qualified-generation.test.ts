import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { AcceptedReadingV2, StartRequest, apiSchemas } from '../../src/contracts/index.ts';
import { clearDatabase } from '../fixtures/database.ts';
import { createWorker } from '../../src/worker/index.ts';
import { failingDatabase } from '../fixtures/failing-generation-db.ts';
import { ReadingClient, readingAccount } from '../fixtures/reading-client.ts';
import { qualifiedFixture } from '../fixtures/qualified-generation.ts';
import { localIdentity } from '../../src/worker/identity/routes.ts';
import { RecordBase } from '../../src/worker/readings/base.ts';
import { ReadingGeneration } from '../../src/worker/readings/generation.ts';
import { gate } from '../fixtures/barrier.ts';

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(() => clearDatabase(env.DB));
async function setup(db = env.DB, expiresAt?: string) {
  const { client } = await readingAccount(),
    fixture = await qualifiedFixture(db, expiresAt);
  const identity = localIdentity(client.bindings)!;
  const session = await identity.sessions.get(client.cookies.get('__Host-session'));
  const input = StartRequest.parse({
    clientIntentId: crypto.randomUUID(),
    question: 'My work is manageable. How can I compare formats?',
    languageConfirmed: 'en',
    reversals: true,
    permissionRevision: (await client.me()).permission.revision,
    parentEditionId: null,
    selection: [],
  });
  const generation = new ReadingGeneration(new RecordBase(db, identity), fixture.dependencies);
  return { ...fixture, client, identity, session, input, generation };
}
test('qualified Start preserves the received candidate and signed source versions through save and reopen without a second call', async () => {
  const f = await setup();
  const start = await f.generation.start(f.session, f.input, crypto.randomUUID());
  expect(start.status.state).toBe('published');
  const reading = AcceptedReadingV2.parse(
    await (await f.client.request(`/readings/${start.status.editionId}`)).json(),
  );
  expect(reading.mode).toBe('model');
  expect(reading.synthesis.text).toBe(
    'Preserving a useful method can leave room to compare a different format.',
  );
  expect(reading.contextReceipt?.diagnosticOnly).toBe(false);
  expect(reading.provenance).toMatchObject({
    provider: 'openai',
    requestedModel: 'gpt-6.1-terra',
    returnedModel: 'gpt-6.1-terra',
    policyHash: f.policyHash,
    contentHash: f.bundle.editionHash,
  });
  for (const source of reading.sources)
    expect(source).toEqual(f.bundle.sources.find((s) => s.id === source.id));
  const parameters = JSON.parse(
    (await env.DB.prepare('SELECT parameters_json FROM provider_dispatches').first<string>(
      'parameters_json',
    ))!,
  );
  expect(parameters).toMatchObject({
    syntheticOnly: false,
    externalCall: true,
    reasoning: { effort: 'xhigh' },
    service_tier: 'fast',
  });
  expect(
    (
      await f.client.request(
        `/sessions/${reading.sessionId}/save`,
        { saved: true },
        { method: 'PUT', revision: 1 },
      )
    ).status,
  ).toBe(200);
  f.config.apiKey = '';
  await f.client.permission(false);
  const stored = await env.DB.prepare('SELECT body_enc FROM reading_editions').first('body_enc');
  const quota = await env.DB.prepare('SELECT * FROM quota_buckets').all();
  await f.generation.maintenance();
  expect(await (await f.client.request(`/readings/${reading.editionId}`)).json()).toEqual(reading);
  expect(await env.DB.prepare('SELECT body_enc FROM reading_editions').first('body_enc')).toBe(
    stored,
  );
  expect(await env.DB.prepare('SELECT * FROM quota_buckets').all()).toEqual(quota);
  const ticket = apiSchemas.ExportTicket.parse(
    await (await f.client.request('/exports', {})).json(),
  );
  const exported = apiSchemas.ExportPage.parse(
    await (await f.client.request(`/exports/${ticket.id}`)).json(),
  );
  expect(exported.records.find((r) => r.kind === 'generation_receipt')?.value).toMatchObject({
    transmission: new TextDecoder().decode(f.payload()!),
    reproduction: 'complete',
    contextReceipt: { diagnosticOnly: false },
  });
  expect(f.calls()).toBe(1);
});

test.each(['credentials', 'qualification', 'disabled', 'content-edit'])(
  'missing %s blocks admission before quota and never installs synthetic content',
  async (failure) => {
    const f = await setup();
    if (failure === 'credentials') f.config.apiKey = '';
    if (failure === 'qualification')
      f.dependencies.authorization.qualification = { ...f.config.qualification };
    if (failure === 'disabled')
      await env.DB.prepare('UPDATE system_state SET generation_enabled=0').run();
    if (failure === 'content-edit')
      await env.DB.prepare(
        "UPDATE content_editions SET bundle_json=json_set(bundle_json,'$.sources[0].meaning.core','Altered')",
      ).run();
    await expect(f.generation.start(f.session, f.input, crypto.randomUUID())).rejects.toThrow();
    expect(await env.DB.prepare('SELECT count(*) AS n FROM quota_reservations').first('n')).toBe(0);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM provider_dispatches').first('n')).toBe(
      0,
    );
    expect(await env.DB.prepare('SELECT count(*) AS n FROM content_editions').first('n')).toBe(1);
    expect(f.calls()).toBe(0);
  },
);

for (const stage of ['dispatch', 'publish'] as const) {
  test.each([
    'withdrawal',
    'content-edit',
    'consent',
    'cancel',
    'delete',
    'policy-change',
    'qualification-expiry',
    'key-fence',
  ])(`${stage} barrier fences %s with one quota release and no stale edition`, async (change) => {
    const barrier = gate((sql) =>
      sql.some((s) =>
        s.startsWith(
          stage === 'dispatch' ? 'INSERT INTO provider_dispatches' : 'INSERT INTO reading_editions',
        ),
      ),
    );
    const expires = Date.now() + (change === 'qualification-expiry' ? 3000 : 120000);
    const f = await setup(barrier.db, new Date(expires).toISOString());
    const work = f.generation.start(f.session, f.input, crypto.randomUUID());
    await barrier.ready;
    if (change === 'withdrawal')
      await env.DB.prepare(
        "UPDATE content_editions SET state='withdrawn',policy_revision=policy_revision+1",
      ).run();
    if (change === 'content-edit')
      await env.DB.prepare(
        "UPDATE content_editions SET bundle_json=json_set(bundle_json,'$.sources[0].meaning.core','Altered')",
      ).run();
    if (change === 'consent') await f.client.permission(false);
    if (change === 'cancel') {
      const r = (await env.DB.prepare('SELECT id,revision FROM generation_requests').first<{
        id: string;
        revision: number;
      }>())!;
      await f.generation.cancel(f.session, r.id, r.revision, crypto.randomUUID());
    }
    if (change === 'delete')
      await env.DB.prepare("UPDATE accounts SET status='deleting' WHERE id=?")
        .bind(f.session.subjectId)
        .run();
    if (change === 'policy-change')
      await env.DB.prepare('UPDATE system_state SET provider_policy_hash=?')
        .bind('d'.repeat(64))
        .run();
    if (change === 'qualification-expiry')
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, expires - Date.now() + 25)));
    if (change === 'key-fence')
      await env.DB.prepare("UPDATE accounts SET write_fence='key-rotation' WHERE id=?")
        .bind(f.session.subjectId)
        .run();
    barrier.release();
    try {
      await work;
    } catch {
      /* account deletion may prevent the status reply */
    }
    vi.restoreAllMocks();
    expect(await env.DB.prepare('SELECT count(*) AS n FROM reading_editions').first('n')).toBe(0);
    expect(f.calls()).toBe(stage === 'dispatch' ? 0 : 1);
    expect(await env.DB.prepare('SELECT state FROM quota_reservations').first('state')).toBe(
      'released',
    );
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM quota_events WHERE event='release'").first(
        'n',
      ),
    ).toBe(1);
    await f.generation.maintenance();
    expect(f.calls()).toBe(stage === 'dispatch' ? 0 : 1);
  });
}

for (const changePolicy of [false, true]) {
  test.each(['before-dispatch', 'after-dispatch', 'after-receipt'] as const)(
    `qualified crash recovery never resends or reinterprets; changed policy=${changePolicy}; %s`,
    async (stage) => {
      const f = await setup(failingDatabase(stage));
      const start = await f.generation.start(f.session, f.input, crypto.randomUUID());
      expect(start.status.state).not.toBe('published');
      if (changePolicy)
        await env.DB.prepare('UPDATE system_state SET provider_policy_hash=?')
          .bind('e'.repeat(64))
          .run();
      await env.DB.prepare('UPDATE generation_requests SET lease_expires_at=1,next_run_at=1').run();
      const recovered = new ReadingGeneration(new RecordBase(env.DB, f.identity), f.dependencies);
      await recovered.maintenance();
      const status = await recovered.status(f.session, start.requestId);
      expect(status.state).toBe(changePolicy ? 'blocked' : 'published');
      expect(f.calls()).toBe(
        stage === 'after-receipt' || (!changePolicy && stage === 'before-dispatch') ? 1 : 0,
      );
      if (!changePolicy) {
        const reading = AcceptedReadingV2.parse(
          await (await f.client.request(`/readings/${status.editionId}`)).json(),
        );
        expect(reading.mode).toBe(stage === 'after-dispatch' ? 'template' : 'model');
        if (reading.mode === 'model')
          expect(reading.synthesis.text).toBe(
            'Preserving a useful method can leave room to compare a different format.',
          );
      }
      const count = f.calls();
      await recovered.maintenance();
      expect(f.calls()).toBe(count);
    },
  );
}

test('HTTP and scheduled recovery use the same injected dependencies; absent credentials still allow record access', async () => {
  const db = failingDatabase('before-dispatch'),
    f = await setup(db);
  const app = createWorker(() => f.dependencies);
  const bindings = { ...f.client.bindings, DB: db, READING_MODE: 'qualified' };
  const client = new ReadingClient(bindings, app);
  client.cookies = f.client.cookies;
  client.csrf = f.client.csrf;
  const response = await client.start();
  expect(response.status).toBe(202);
  expect(f.calls()).toBe(0);
  const start = (await response.json()) as { requestId: string };
  await env.DB.prepare('UPDATE generation_requests SET lease_expires_at=1,next_run_at=1').run();
  await app.scheduled(
    {} as ScheduledController,
    { ...bindings, DB: env.DB },
    {} as ExecutionContext,
  );
  const status = (await (await client.request(`/requests/${start.requestId}`)).json()) as {
    editionId: string;
    state: string;
    sessionId: string;
  };
  expect(status.state).toBe('published');
  const original = await (await client.request(`/readings/${status.editionId}`)).json();
  expect(
    (
      await client.request(
        `/sessions/${status.sessionId}/save`,
        { saved: true },
        { method: 'PUT', revision: 1 },
      )
    ).status,
  ).toBe(200);
  f.config.apiKey = '';
  expect((await client.start()).status).toBe(503);
  const unavailable = new ReadingClient(bindings, createWorker());
  unavailable.cookies = client.cookies;
  unavailable.csrf = client.csrf;
  expect((await unavailable.start()).status).toBe(503);
  expect(await (await unavailable.request(`/readings/${status.editionId}`)).json()).toEqual(
    original,
  );
  expect((await unavailable.request('/sessions')).status).toBe(200);
  expect(f.calls()).toBe(1);
});
