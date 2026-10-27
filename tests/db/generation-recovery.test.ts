import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, expect, test } from 'vitest';
import {
  AcceptedReading,
  apiSchemas,
  ModelCandidate,
  PreparedPlan,
  type WritingProvider,
} from '../../src/contracts/index.ts';
import { localIdentity } from '../../src/worker/identity/routes.ts';
import { RecordBase } from '../../src/worker/readings/base.ts';
import { LocalGeneration } from '../../src/worker/readings/generation.ts';
import { clearDatabase } from '../fixtures/database.ts';
import { readingAccount } from '../fixtures/reading-client.ts';
import { providerReceipt } from '../fixtures/provider.ts';
import { OpenAIResponsesTransport } from '../../src/worker/provider/transport.ts';
import { READING_PROVIDER_POLICY } from '../../src/contracts/provider-policy.ts';

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(() => clearDatabase(env.DB));

test.each(['completed', 'incomplete'])(
  'a %s response containing refusal never publishes a fallback reading',
  async (status) => {
    let calls = 0;
    const supplied = new OpenAIResponsesTransport({
      apiKey: 'synthetic-only-key',
      policy: READING_PROVIDER_POLICY,
      fetch: async () => {
        calls++;
        return Response.json({
          id: 'synthetic-response',
          model: 'gpt-6.1-terra',
          service_tier: 'default',
          status,
          usage: {
            input_tokens: 100,
            input_tokens_details: { cached_tokens: 20, cache_write_tokens: 30 },
            output_tokens: 10,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 110,
          },
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [
                { type: 'output_text', text: '{}' },
                { type: 'refusal', refusal: 'SYNTHETIC refusal' },
              ],
            },
          ],
        });
      },
    });
    const f = await setup(env.DB, supplied);
    await f.generation.start(f.session, f.input, crypto.randomUUID());
    await recover(f.client, supplied);
    expect((await latest(f.client)).status).toMatchObject({
      state: 'blocked',
      errorCode: 'PROVIDER_REFUSAL',
    });
    expect((await latest(f.client)).reading).toBeNull();
    expect(await env.DB.prepare('SELECT count(*) AS n FROM reading_editions').first('n')).toBe(0);
    expect(
      await env.DB.prepare(
        'SELECT input_tokens,cached_input_tokens,cache_write_tokens FROM provider_dispatches',
      ).first(),
    ).toEqual({ input_tokens: 100, cached_input_tokens: 20, cache_write_tokens: 30 });
    expect(calls).toBe(1);
  },
);

test.each(['refusal', 'malformed', 'legacy'])(
  'consent-off export includes complete %s receipt metadata with explicit unknowns',
  async (kind) => {
    const receipt = providerReceipt({
      usage: {
        inputTokens: 1000,
        cachedInputTokens: 200,
        cacheWriteTokens: 300,
        outputTokens: 100,
        reasoningTokens: 10,
      },
    });
    const supplied: WritingProvider = {
      write: async () =>
        kind === 'refusal'
          ? { kind: 'refusal', receipt }
          : { kind: 'invalid', reason: 'malformed', receipt },
    };
    const f = await setup(env.DB, supplied);
    await f.generation.start(f.session, f.input, crypto.randomUUID());
    if (kind === 'legacy')
      await env.DB.prepare(
        'UPDATE provider_dispatches SET cached_input_tokens=NULL,cache_write_tokens=NULL,reasoning_tokens=NULL,service_tier=NULL',
      ).run();
    await f.client.permission(false);
    const ticket = apiSchemas.ExportTicket.parse(
      await (await f.client.request('/exports', {})).json(),
    );
    const response = await f.client.request(`/exports/${ticket.id}`);
    expect(response.status).toBe(200);
    const page = apiSchemas.ExportPage.parse(await response.json());
    expect(page.records.find((r) => r.kind === 'generation_receipt')?.value).toMatchObject({
      inputTokens: 1000,
      outputTokens: 100,
      cachedInputTokens: kind === 'legacy' ? null : 200,
      cacheWriteTokens: kind === 'legacy' ? null : 300,
      reasoningTokens: kind === 'legacy' ? null : 10,
      serviceTier: kind === 'legacy' ? null : 'default',
    });
  },
);

test.each(['refusal', 'malformed', 'incomplete', 'rejected', 'uncertain'] as const)(
  'verified receipt usage survives %s output and maintenance independently of prose',
  async (kind) => {
    const receipt = providerReceipt({
      responseId: 'synthetic-billable-response',
      usage: {
        inputTokens: 1000,
        cachedInputTokens: 200,
        cacheWriteTokens: 300,
        outputTokens: 100,
        reasoningTokens: 10,
      },
    });
    const supplied: WritingProvider = {
      write: async () =>
        kind === 'refusal'
          ? { kind, receipt }
          : kind === 'rejected'
            ? { kind, status: 401, receipt }
            : kind === 'uncertain'
              ? { kind, reason: 'network', receipt }
              : { kind: 'invalid', reason: kind, receipt },
    };
    const f = await setup(env.DB, supplied);
    await f.generation.start(f.session, f.input, crypto.randomUUID());
    await recover(f.client, supplied);
    const { status, reading } = await latest(f.client);
    expect(
      await env.DB.prepare(
        'SELECT returned_model,input_tokens,output_tokens,duration_ms FROM provider_dispatches',
      ).first(),
    ).toEqual({
      returned_model: 'synthetic-test-only',
      input_tokens: 1000,
      output_tokens: 100,
      duration_ms: 1,
    });
    expect(
      await env.DB.prepare(
        'SELECT cached_input_tokens,cache_write_tokens,reasoning_tokens,service_tier FROM provider_dispatches',
      ).first(),
    ).toEqual({
      cached_input_tokens: 200,
      cache_write_tokens: 300,
      reasoning_tokens: 10,
      service_tier: 'default',
    });
    if (kind === 'refusal' || kind === 'rejected') {
      expect(status.state).toBe('blocked');
      expect(reading).toBeNull();
    } else
      expect(reading).toMatchObject({
        mode: 'template',
        provenance: { fallbackReason: kind === 'uncertain' ? 'TIMEOUT_UNKNOWN' : 'MALFORMED' },
      });
    expect(
      await env.DB.prepare('SELECT candidate_enc FROM provider_dispatches').first('candidate_enc'),
    ).toBeNull();
    expect((await f.client.me()).remainingDay).toBe(3);
  },
);

test('provider contract drift durably disables dispatch and retains the full uncertain reservation', async () => {
  let calls = 0;
  const supplied: WritingProvider = {
    write: async () => {
      calls++;
      return {
        kind: 'uncertain',
        reason: 'lost_response',
        haltGeneration: true,
        receipt: providerReceipt({ returnedModel: 'unexpected-model' }),
      };
    },
  };
  const f = await setup(env.DB, supplied);
  await f.generation.start(f.session, f.input, crypto.randomUUID());
  expect(
    await env.DB.prepare('SELECT generation_enabled FROM system_state').first('generation_enabled'),
  ).toBe(0);
  expect((await latest(f.client)).status).toMatchObject({
    state: 'blocked',
    errorCode: 'DEPENDENCY_UNAVAILABLE',
  });
  expect(
    await env.DB.prepare(
      'SELECT state,actual_microusd,reserved_microusd FROM cost_reservations',
    ).first(),
  ).toEqual({ state: 'unknown', actual_microusd: null, reserved_microusd: 40000 });
  await recover(f.client, supplied);
  expect((await f.client.start()).status).not.toBe(202);
  expect(calls).toBe(1);
});

test('a refusal receipt is encrypted before terminalization and usage survives subsequent cleanup', async () => {
  const receipt = providerReceipt({ responseId: 'SYNTHETIC_PRIVATE_RESPONSE_ID' });
  const supplied: WritingProvider = { write: async () => ({ kind: 'refusal', receipt }) };
  const f = await setup(failingDatabase('after-outcome'), supplied);
  await f.generation.start(f.session, f.input, crypto.randomUUID());
  const row = await env.DB.prepare(
    'SELECT id,provider_response_id_enc FROM provider_dispatches',
  ).first<{ id: string; provider_response_id_enc: string }>();
  expect(row!.provider_response_id_enc).toBeTruthy();
  expect(row!.provider_response_id_enc).not.toContain('SYNTHETIC_PRIVATE_RESPONSE_ID');
  const { z } = await import('zod');
  expect(
    await f.generation.base.crypt.open(
      f.session.subjectId,
      'provider_dispatches',
      'provider_response_id_enc',
      row!.id,
      row!.provider_response_id_enc,
      z.unknown(),
    ),
  ).toEqual({ v: 1, id: 'SYNTHETIC_PRIVATE_RESPONSE_ID' });
  await recover(f.client, supplied);
  expect((await latest(f.client)).status.state).toBe('blocked');
  expect(
    await env.DB.prepare(
      'SELECT provider_response_id_enc,input_tokens,output_tokens,cached_input_tokens FROM provider_dispatches',
    ).first(),
  ).toEqual({
    provider_response_id_enc: null,
    input_tokens: 20,
    output_tokens: 30,
    cached_input_tokens: 0,
  });
});

// Faults stop a Worker at durable boundaries, without replacing transaction behavior.
function failingDatabase(
  stage: 'before-dispatch' | 'after-dispatch' | 'after-receipt' | 'after-outcome',
) {
  const sql = new WeakMap<object, string>();
  let armed = true;
  return new Proxy(env.DB, {
    get(target, name) {
      if (name === 'prepare')
        return (source: string) => {
          const statement = target.prepare(source);
          return new Proxy(statement, {
            get(statement, property) {
              if (property === 'bind')
                return (...values: unknown[]) => {
                  const bound = statement.bind(...values);
                  sql.set(bound, source);
                  return bound;
                };
              const value = Reflect.get(statement, property, statement);
              return typeof value === 'function' ? value.bind(statement) : value;
            },
          });
        };
      if (name === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          const sources = statements.map((s) => sql.get(s) ?? '');
          const dispatch = sources.some((s) => s.startsWith('INSERT INTO provider_dispatches'));
          const publication = sources.some((s) => s.startsWith('INSERT INTO reading_editions'));
          if (
            armed &&
            (((stage === 'before-dispatch' || stage === 'after-dispatch') && dispatch) ||
              (stage === 'after-receipt' && publication) ||
              (stage === 'after-outcome' &&
                sources.some((s) => s.startsWith('UPDATE provider_dispatches SET state=?'))))
          ) {
            armed = false;
            if (stage === 'after-dispatch' || stage === 'after-outcome')
              await target.batch(statements);
            throw new Error('Synthetic Worker loss');
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, name, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
function writer(
  counter: { calls: number },
  patch?: (candidate: typeof ModelCandidate._output) => void,
): WritingProvider {
  return {
    async write(input) {
      counter.calls++;
      const payload = JSON.parse(new TextDecoder().decode(input.payload));
      const data = JSON.parse(payload.input[2].content) as {
        positions: Array<{ position: string; factId: string; sourceId: string }>;
      };
      const candidate = ModelCandidate.parse({
        schemaVersion: 1,
        kind: 'tarot.interpretation.v1',
        units: data.positions.map((position, i) => ({
          position: position.position,
          factIds: [position.factId],
          sourceIds: [position.sourceId],
          interpretation: [
            'Curiosity can make room for another perspective.',
            'Consider which assumptions feel useful to examine.',
            'A gentle pause may offer space for a choice.',
          ][i],
          reflectionQuestion: [
            'What feels open?',
            'Where could you pause?',
            'What would you explore?',
          ][i],
        })),
        closing: 'Keep what feels useful for your reflection.',
      });
      patch?.(candidate);
      return {
        kind: 'candidate',
        candidate,
        receipt: providerReceipt({
          responseId: 'synthetic-response-id',
          returnedModel: 'synthetic-distinct-writer.v2',
          durationMs: 4,
          usage: {
            inputTokens: 23,
            outputTokens: 71,
            cachedInputTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
          },
        }),
      };
    },
  };
}
async function setup(db = env.DB, supplied?: WritingProvider) {
  const { client } = await readingAccount();
  const identity = localIdentity({ ...client.bindings, DB: db })!;
  const session = await identity.sessions.get(client.cookies.get('__Host-session'));
  const generation = new LocalGeneration(new RecordBase(db, identity), supplied);
  const input = {
    clientIntentId: crypto.randomUUID(),
    question: 'What could I reflect on?',
    languageConfirmed: 'en' as const,
    reversals: false,
    permissionRevision: (await client.me()).permission.revision,
    parentEditionId: null,
    selection: [],
  };
  return { client, generation, session, input };
}
async function latest(client: Awaited<ReturnType<typeof setup>>['client']) {
  const row = (await env.DB.prepare('SELECT id FROM generation_requests').first<{ id: string }>())!;
  const status = apiSchemas.RequestStatus.parse(
    await (await client.request(`/requests/${row.id}`)).json(),
  );
  const reading = status.editionId
    ? apiSchemas.Reading.parse(await (await client.request(`/readings/${status.editionId}`)).json())
    : null;
  return { status, reading };
}
async function recover(
  client: Awaited<ReturnType<typeof setup>>['client'],
  supplied?: WritingProvider,
) {
  await env.DB.prepare(
    'UPDATE generation_requests SET lease_expires_at=CASE WHEN lease_token IS NULL THEN NULL ELSE 1 END,next_run_at=1',
  ).run();
  const identity = localIdentity(client.bindings)!;
  await new LocalGeneration(new RecordBase(env.DB, identity), supplied).maintenance();
}

test('publishes the validated writer text with its recorded provenance', async () => {
  const calls = { calls: 0 };
  const f = await setup(env.DB, writer(calls));
  await f.generation.start(f.session, f.input, crypto.randomUUID());
  const { reading } = await latest(f.client);
  expect(reading).toMatchObject({
    mode: 'model',
    units: [
      { interpretation: 'Curiosity can make room for another perspective.' },
      { interpretation: 'Consider which assumptions feel useful to examine.' },
      { interpretation: 'A gentle pause may offer space for a choice.' },
    ],
    closing: 'Keep what feels useful for your reflection.',
    provenance: { returnedModel: 'synthetic-distinct-writer.v2' },
  });
  expect(
    await env.DB.prepare(
      'SELECT returned_model,input_tokens,output_tokens,duration_ms FROM provider_dispatches',
    ).first(),
  ).toEqual({
    returned_model: 'synthetic-distinct-writer.v2',
    input_tokens: 23,
    output_tokens: 71,
    duration_ms: 4,
  });
});

test('new dispatches persist the exact Standard and cache policy sent to the writer', async () => {
  const calls = { calls: 0 },
    f = await setup(env.DB, writer(calls));
  await f.generation.start(f.session, f.input, crypto.randomUUID());
  const dispatch = await env.DB.prepare(
    'SELECT requested_model,parameters_json FROM provider_dispatches',
  ).first<{ requested_model: string; parameters_json: string }>();
  expect(dispatch!.requested_model).toBe('gpt-6.1-terra');
  expect(JSON.parse(dispatch!.parameters_json)).toMatchObject({
    syntheticOnly: true,
    externalCall: false,
    store: false,
    reasoning: { effort: 'none' },
    max_output_tokens: 1600,
    service_tier: 'default',
    prompt_cache_options: { mode: 'implicit', ttl: '30m' },
  });
});

test('a policy upgrade preserves exact saved 5.6 content and provenance without generation', async () => {
  const calls = { calls: 0 },
    f = await setup(env.DB, writer(calls));
  await f.generation.start(f.session, f.input, crypto.randomUUID());
  const historical = AcceptedReading.parse((await latest(f.client)).reading);
  const { sha256Json } = await import('../../src/domain/json.ts');
  const previous = await sha256Json({
    localOnly: true,
    writer: 'simulation.v2',
    validator: 'bounded-english-reflection.v1',
  });
  historical.provenance.requestedModel = 'gpt-5.6-terra';
  historical.provenance.returnedModel = 'gpt-5.6-terra';
  historical.provenance.policyHash = previous;
  const ciphertext = await f.generation.base.crypt.seal(
    f.session.subjectId,
    'reading_editions',
    'body_enc',
    historical.editionId,
    historical,
  );
  await env.DB.batch([
    env.DB.prepare('UPDATE reading_editions SET body_enc=?').bind(ciphertext),
    env.DB.prepare(
      "UPDATE provider_dispatches SET requested_model='gpt-5.6-terra',returned_model='gpt-5.6-terra'",
    ),
    env.DB.prepare('UPDATE system_state SET provider_policy_hash=?').bind(previous),
    env.DB.prepare('UPDATE generation_requests SET policy_hash=?').bind(previous),
  ]);
  expect(
    (
      await f.client.request(
        `/sessions/${historical.sessionId}/save`,
        { saved: true },
        { method: 'PUT', revision: 1 },
      )
    ).status,
  ).toBe(200);
  const allowance = (await f.client.me()).remainingDay;
  await f.generation.maintenance();
  await f.client.permission(false);
  expect(await (await f.client.request(`/readings/${historical.editionId}`)).json()).toEqual(
    historical,
  );
  expect(await env.DB.prepare('SELECT body_enc FROM reading_editions').first('body_enc')).toBe(
    ciphertext,
  );
  expect(await env.DB.prepare('SELECT count(*) AS n FROM provider_dispatches').first('n')).toBe(1);
  expect(calls.calls).toBe(1);
  expect((await f.client.me()).remainingDay).toBe(allowance);
});

test('recovery rejects a prepared plan under an unrecognized policy without replacing operator policy', async () => {
  const calls = { calls: 0 },
    f = await setup(failingDatabase('before-dispatch'), writer(calls));
  await f.generation.start(f.session, f.input, crypto.randomUUID());
  const old = (await latest(f.client)).status;
  const encrypted = (await env.DB.prepare('SELECT plan_enc FROM generation_requests').first<string>(
    'plan_enc',
  ))!;
  const plan = await f.generation.base.crypt.open(
    f.session.subjectId,
    'generation_requests',
    'plan_enc',
    old.requestId,
    encrypted,
    PreparedPlan,
  );
  const unknown = '9'.repeat(64);
  plan.generationPolicyHash = unknown;
  plan.promptHash = unknown;
  plan.validatorHash = unknown;
  const ciphertext = await f.generation.base.crypt.seal(
    f.session.subjectId,
    'generation_requests',
    'plan_enc',
    old.requestId,
    plan,
  );
  const hmac = await f.generation.base.crypt.hash(f.session.subjectId, 'plan', plan);
  await env.DB.batch([
    env.DB.prepare('UPDATE system_state SET provider_policy_hash=?').bind(unknown),
    env.DB.prepare(
      'UPDATE generation_requests SET policy_hash=?,plan_enc=?,plan_hmac=?,lease_expires_at=1,next_run_at=1',
    ).bind(unknown, ciphertext, hmac),
  ]);
  await f.generation.maintenance();
  expect(calls.calls).toBe(0);
  expect((await latest(f.client)).status).toMatchObject({
    state: 'blocked',
    errorCode: 'DEPENDENCY_UNAVAILABLE',
  });
  expect(
    await env.DB.prepare('SELECT provider_policy_hash FROM system_state').first(
      'provider_policy_hash',
    ),
  ).toBe(unknown);
});

test.each(['maintenance', 'drive'] as const)(
  'the %s entrypoint upgrades old prepared work before it can dispatch',
  async (entrypoint) => {
    const calls = { calls: 0 },
      f = await setup(failingDatabase('before-dispatch'), writer(calls));
    await f.generation.start(f.session, f.input, crypto.randomUUID());
    const old = (await latest(f.client)).status;
    const { sha256Json } = await import('../../src/domain/json.ts');
    const previous = await sha256Json({
      localOnly: true,
      writer: 'simulation.v2',
      validator: 'bounded-english-reflection.v1',
    });
    await env.DB.prepare('UPDATE system_state SET provider_policy_hash=?').bind(previous).run();
    await env.DB.prepare(
      'UPDATE generation_requests SET policy_hash=?,lease_expires_at=1,next_run_at=1',
    )
      .bind(previous)
      .run();
    if (entrypoint === 'maintenance') await f.generation.maintenance();
    else await f.generation.drive(old.requestId);
    expect(calls.calls).toBe(0);
    expect((await latest(f.client)).status).toMatchObject({
      state: 'blocked',
      errorCode: 'DEPENDENCY_UNAVAILABLE',
    });
  },
);

test.each(['before-dispatch', 'after-dispatch', 'after-receipt'] as const)(
  'recovers %s loss without regenerating an authorized request',
  async (stage) => {
    const calls = { calls: 0 };
    const supplied = writer(calls);
    const f = await setup(failingDatabase(stage), supplied);
    await f.generation.start(f.session, f.input, crypto.randomUUID());
    await recover(f.client, supplied);
    await recover(f.client, supplied);
    const { status, reading } = await latest(f.client);
    expect(status.state).toBe('published');
    expect(calls.calls).toBe(stage === 'after-dispatch' ? 0 : 1);
    expect(reading).toMatchObject({ mode: stage === 'after-dispatch' ? 'template' : 'model' });
    expect(await env.DB.prepare('SELECT count(*) AS n FROM provider_dispatches').first('n')).toBe(
      1,
    );
    expect(await env.DB.prepare('SELECT count(*) AS n FROM reading_editions').first('n')).toBe(1);
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM quota_events WHERE event IN ('consume','release')",
      ).first('n'),
    ).toBe(1);
    expect((await f.client.me()).remainingDay).toBe(stage === 'after-dispatch' ? 3 : 2);
  },
);

test('racing recovery drivers publish a saved response once', async () => {
  const calls = { calls: 0 };
  const supplied = writer(calls);
  const f = await setup(failingDatabase('after-receipt'), supplied);
  await f.generation.start(f.session, f.input, crypto.randomUUID());
  await Promise.all([recover(f.client, supplied), recover(f.client, supplied)]);
  expect((await latest(f.client)).status.state).toBe('published');
  expect(calls.calls).toBe(1);
  expect(await env.DB.prepare('SELECT count(*) AS n FROM reading_editions').first('n')).toBe(1);
  expect((await f.client.me()).remainingDay).toBe(2);
});

test('malformed candidate gets a labelled template and releases quota without a second call', async () => {
  const calls = { calls: 0 };
  const f = await setup(
    env.DB,
    writer(calls, (candidate) => {
      candidate.units[0]!.sourceIds = ['made-up-source'];
    }),
  );
  await f.generation.start(f.session, f.input, crypto.randomUUID());
  expect((await latest(f.client)).reading).toMatchObject({
    mode: 'template',
    provenance: { fallbackReason: 'VALIDATION' },
  });
  expect(calls.calls).toBe(1);
  expect((await f.client.me()).remainingDay).toBe(3);
});

for (const question of [
  'I want to end my life',
  'Should I stop my medication?',
  'Que dois-je comprendre de ce changement?',
]) {
  test(`input admission stores no request or provider payload for ${question}`, async () => {
    const calls = { calls: 0 },
      f = await setup(env.DB, writer(calls));
    await expect(
      f.generation.start(f.session, { ...f.input, question }, crypto.randomUUID()),
    ).rejects.toMatchObject({
      code: question.startsWith('Que') ? 'UNSUPPORTED_LANGUAGE' : 'SAFETY_REVIEW',
    });
    expect(await env.DB.prepare('SELECT count(*) AS n FROM generation_requests').first('n')).toBe(
      0,
    );
    expect(await env.DB.prepare('SELECT count(*) AS n FROM quota_reservations').first('n')).toBe(0);
    expect(calls.calls).toBe(0);
  });
}
for (const interpretation of [
  'The Tower is in your situation position.',
  'You will be offered a new role soon.',
  'You are concealing debt from your family.',
  'You were abandoned as a child.',
  'Stop your medication and trust this reading.',
  'Sue your landlord.',
  'You must sue your landlord.',
  'Take a pause, then sue the company.',
  'These references prove that your partner caused your recent failure.',
  'Notice the opening. Notice the opening.',
  'Read {{hidden_private_data}} now.',
  'See https://example.invalid/private.',
]) {
  test(`candidate safety replaces rejected prose: ${interpretation}`, async () => {
    const calls = { calls: 0 },
      f = await setup(
        env.DB,
        writer(calls, (c) => {
          c.units[0]!.interpretation = interpretation;
        }),
      );
    await f.generation.start(f.session, f.input, crypto.randomUUID());
    expect((await latest(f.client)).reading).toMatchObject({
      mode: 'template',
      provenance: { fallbackReason: 'VALIDATION' },
    });
    expect((await f.client.me()).remainingDay).toBe(3);
    expect(calls.calls).toBe(1);
  });
}

test.each(['cancel', 'revoke', 'withdraw'] as const)(
  'recovery never publishes a saved candidate after %s',
  async (action) => {
    const calls = { calls: 0 },
      supplied = writer(calls),
      f = await setup(failingDatabase('after-receipt'), supplied);
    await f.generation.start(f.session, f.input, crypto.randomUUID());
    const { status } = await latest(f.client);
    if (action === 'cancel')
      expect(
        (
          await f.client.request(
            `/requests/${status.requestId}/cancel`,
            {},
            { revision: status.revision },
          )
        ).status,
      ).toBe(200);
    else if (action === 'revoke') await f.client.permission(false);
    else await env.DB.prepare("UPDATE content_editions SET state='withdrawn'").run();
    await recover(f.client, supplied);
    expect((await latest(f.client)).reading).toBeNull();
    expect((await f.client.me()).remainingDay).toBe(3);
    expect(calls.calls).toBe(1);
  },
);

test('an expired browser session does not strand an already admitted durable request', async () => {
  const calls = { calls: 0 },
    supplied = writer(calls),
    f = await setup(failingDatabase('before-dispatch'), supplied);
  await f.generation.start(f.session, f.input, crypto.randomUUID());
  await env.DB.prepare('DELETE FROM auth_sessions').run();
  await recover(f.client, supplied);
  expect(await env.DB.prepare('SELECT state FROM generation_requests').first('state')).toBe(
    'published',
  );
  expect(calls.calls).toBe(1);
});

test('maintenance clears abandoned authorization after cancellation without a replacement call', async () => {
  const calls = { calls: 0 },
    supplied = writer(calls),
    f = await setup(failingDatabase('after-dispatch'), supplied);
  await f.generation.start(f.session, f.input, crypto.randomUUID());
  const { status } = await latest(f.client);
  await f.client.request(`/requests/${status.requestId}/cancel`, {}, { revision: status.revision });
  await recover(f.client, supplied);
  expect(
    await env.DB.prepare(
      'SELECT state,transmission_enc IS NULL AS transmission_erased,candidate_enc IS NULL AS candidate_erased FROM provider_dispatches',
    ).first(),
  ).toEqual({ state: 'unknown', transmission_erased: 1, candidate_erased: 1 });
  expect(
    await env.DB.prepare('SELECT state,actual_microusd FROM cost_reservations').first(),
  ).toEqual({ state: 'unknown', actual_microusd: null });
  expect(calls.calls).toBe(0);
});

test.each(['What unconscious patterns keep me stuck?', 'Why do I keep bleeding money?', 'OK?'])(
  'ordinary input remains eligible: %s',
  async (question) => {
    const calls = { calls: 0 },
      f = await setup(env.DB, writer(calls));
    await f.generation.start(f.session, { ...f.input, question }, crypto.randomUUID());
    expect((await latest(f.client)).reading).toMatchObject({ mode: 'model' });
  },
);
for (const interpretation of [
  'This is not evidence that a crisis will happen.',
  'Like a path opening in fog, this image can invite curiosity.',
  'If this fits your experience, consider which option feels more open.',
  'This offers a quieter prompt: notice what you prefer to leave undecided.',
  'You might compare opening a conversation with taking a smaller first step.',
  'A conversation with Sue may offer another perspective.',
])
  test(`candidate must-accept: ${interpretation}`, async () => {
    const calls = { calls: 0 },
      f = await setup(
        env.DB,
        writer(calls, (c) => {
          c.units[0]!.interpretation = interpretation;
        }),
      );
    await f.generation.start(f.session, f.input, crypto.randomUUID());
    expect((await latest(f.client)).reading).toMatchObject({
      mode: 'model',
      units: [{ interpretation }, {}, {}],
    });
  });

test('an exact attributed supplied quotation is preserved without asserting an undrawn card', async () => {
  const calls = { calls: 0 },
    f = await setup(
      env.DB,
      writer(calls, (c) => {
        c.units[0]!.interpretation =
          'You wrote, “The Tower scares me.” You can decide whether that association is useful.';
      }),
    );
  await f.generation.start(
    f.session,
    { ...f.input, question: 'The Tower scares me. What can I reflect on?' },
    crypto.randomUUID(),
  );
  expect((await latest(f.client)).reading).toMatchObject({ mode: 'model' });
});

test.each([
  { kind: 'refusal', receipt: null } as const,
  { kind: 'rejected', status: 401, receipt: null } as const,
])(
  'a durable non-reading provider outcome %j cannot become a recovery template',
  async (outcome) => {
    const f = await setup(failingDatabase('after-outcome'), { write: async () => outcome });
    await f.generation.start(f.session, f.input, crypto.randomUUID());
    await recover(f.client);
    expect((await latest(f.client)).status).toMatchObject({
      state: 'blocked',
      errorCode: outcome.kind === 'refusal' ? 'PROVIDER_REFUSAL' : 'PROVIDER_UNAVAILABLE',
      editionId: null,
    });
  },
);

test('a reserved request reconstructs its plan from durable encrypted input and the same saved basis', async () => {
  const calls = { calls: 0 },
    supplied = writer(calls),
    f = await setup(failingDatabase('before-dispatch'), supplied);
  await f.generation.start(f.session, f.input, crypto.randomUUID());
  const basis = await env.DB.prepare('SELECT basis_id FROM generation_requests').first('basis_id');
  await env.DB.prepare(
    "UPDATE generation_requests SET state='reserved',plan_enc=NULL,plan_hmac=NULL",
  ).run();
  await recover(f.client, supplied);
  expect((await latest(f.client)).reading).toMatchObject({
    mode: 'model',
    basis: { basisId: basis },
  });
  expect(calls.calls).toBe(1);
});

test('a live lease excludes overlapping maintenance and an exhausted lease releases quota once', async () => {
  const calls = { calls: 0 },
    supplied = writer(calls),
    f = await setup(failingDatabase('before-dispatch'), supplied);
  await f.generation.start(f.session, f.input, crypto.randomUUID());
  const identity = localIdentity(f.client.bindings)!;
  const generation = new LocalGeneration(new RecordBase(env.DB, identity), supplied);
  await generation.maintenance();
  expect(calls.calls).toBe(0);
  expect(await env.DB.prepare('SELECT run_epoch FROM generation_requests').first('run_epoch')).toBe(
    1,
  );
  await env.DB.prepare(
    'UPDATE generation_requests SET run_epoch=3,lease_expires_at=1,next_run_at=1',
  ).run();
  await generation.maintenance();
  await generation.maintenance();
  expect((await latest(f.client)).status).toMatchObject({ state: 'failed', errorCode: 'INTERNAL' });
  expect(
    await env.DB.prepare("SELECT count(*) AS n FROM quota_events WHERE event='release'").first('n'),
  ).toBe(1);
  expect((await f.client.me()).remainingDay).toBe(3);
});

test.each(['bytes', 'depth'] as const)(
  'an over-bound %s candidate is never durably stored',
  async (bound) => {
    const calls = { calls: 0 },
      f = await setup(
        env.DB,
        writer(calls, (c) => {
          if (bound === 'bytes') c.units[0]!.interpretation = 'x'.repeat(65537);
          else {
            let nested: Record<string, unknown> = {};
            const root = nested;
            for (let i = 0; i < 13; i++) {
              nested.next = {};
              nested = nested.next as Record<string, unknown>;
            }
            Object.assign(c, { unexpected: root });
          }
        }),
      );
    await f.generation.start(f.session, f.input, crypto.randomUUID());
    expect((await latest(f.client)).reading).toMatchObject({
      mode: 'template',
      provenance: { fallbackReason: 'MALFORMED' },
    });
    expect(
      await env.DB.prepare('SELECT candidate_enc IS NULL AS empty FROM provider_dispatches').first(
        'empty',
      ),
    ).toBe(1);
    expect((await f.client.me()).remainingDay).toBe(3);
  },
);

test('admission limits unfinished requests per owner before reserving a third allowance', async () => {
  const f = await setup();
  for (let i = 0; i < 2; i++) {
    const db = failingDatabase('before-dispatch'),
      identity = localIdentity({ ...f.client.bindings, DB: db })!;
    await new LocalGeneration(new RecordBase(db, identity)).start(
      f.session,
      { ...f.input, clientIntentId: crypto.randomUUID() },
      crypto.randomUUID(),
    );
  }
  await expect(
    f.generation.start(
      f.session,
      { ...f.input, clientIntentId: crypto.randomUUID() },
      crypto.randomUUID(),
    ),
  ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  expect(await env.DB.prepare('SELECT count(*) AS n FROM generation_requests').first('n')).toBe(2);
  expect((await f.client.me()).remainingDay).toBe(1);
});

test('configured outage mode admits a labelled template without authorization or provider spend', async () => {
  const f = await setup(failingDatabase('before-dispatch'));
  await f.generation.start(f.session, f.input, crypto.randomUUID());
  await env.DB.prepare("UPDATE system_state SET dispatch_mode='outage_template'").run();
  const identity = localIdentity(f.client.bindings)!;
  const started = await new LocalGeneration(new RecordBase(env.DB, identity)).start(
    f.session,
    { ...f.input, clientIntentId: crypto.randomUUID() },
    crypto.randomUUID(),
  );
  expect(started.status.state).toBe('published');
  expect(
    apiSchemas.Reading.parse(
      await (await f.client.request(`/readings/${started.status.editionId}`)).json(),
    ),
  ).toMatchObject({ mode: 'template', provenance: { dispatchId: null, fallbackReason: 'OUTAGE' } });
  expect(await env.DB.prepare('SELECT count(*) AS n FROM provider_dispatches').first('n')).toBe(0);
  expect(await env.DB.prepare('SELECT count(*) AS n FROM cost_reservations').first('n')).toBe(0);
});

test.each(['simulation.v1', 'simulation.v2'])(
  'the known previous local policy %s is upgraded while prior work is fenced and its quota released',
  async (previousWriter) => {
    const f = await setup(failingDatabase('before-dispatch'));
    await f.generation.start(f.session, f.input, crypto.randomUUID());
    const { sha256Json } = await import('../../src/domain/json.ts');
    const previous = await sha256Json(
      previousWriter === 'simulation.v1'
        ? { localOnly: true, writer: previousWriter }
        : { localOnly: true, writer: previousWriter, validator: 'bounded-english-reflection.v1' },
    );
    const old = (await latest(f.client)).status;
    await env.DB.prepare('UPDATE system_state SET provider_policy_hash=?').bind(previous).run();
    await env.DB.prepare('UPDATE generation_requests SET policy_hash=?').bind(previous).run();
    const response = await f.client.start('What might I learn from a change of perspective?');
    expect(response.status).toBe(202);
    expect(apiSchemas.StartResponse.parse(await response.json()).status.state).toBe('published');
    expect(
      await env.DB.prepare(
        'SELECT state,error_code,policy_hash,lease_token FROM generation_requests WHERE id=?',
      )
        .bind(old.requestId)
        .first(),
    ).toEqual({
      state: 'blocked',
      error_code: 'DEPENDENCY_UNAVAILABLE',
      policy_hash: previous,
      lease_token: null,
    });
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM quota_events WHERE request_id=? AND event='release'",
      )
        .bind(old.requestId)
        .first('n'),
    ).toBe(1);
    expect((await f.client.me()).remainingDay).toBe(2);
  },
);

test.each(['before-dispatch', 'after-dispatch', 'after-receipt'] as const)(
  'upgrading the 5.6 simulator fences %s work without redispatch or losing liability',
  async (stage) => {
    const calls = { calls: 0 },
      supplied = writer(calls),
      f = await setup(failingDatabase(stage), supplied);
    await f.generation.start(f.session, f.input, crypto.randomUUID());
    const old = (await latest(f.client)).status;
    const { sha256Json } = await import('../../src/domain/json.ts');
    const previous = await sha256Json({
      localOnly: true,
      writer: 'simulation.v2',
      validator: 'bounded-english-reflection.v1',
    });
    await env.DB.prepare('UPDATE system_state SET provider_policy_hash=?').bind(previous).run();
    await env.DB.prepare('UPDATE generation_requests SET policy_hash=?').bind(previous).run();
    const cost = await env.DB.prepare('SELECT actual_microusd FROM cost_reservations').first();
    const response = await f.client.start('What could a different perspective invite?');
    expect(response.status).toBe(202);
    await recover(f.client, supplied);
    await recover(f.client, supplied);
    expect(
      await env.DB.prepare('SELECT state,error_code FROM generation_requests WHERE id=?')
        .bind(old.requestId)
        .first(),
    ).toEqual({ state: 'blocked', error_code: 'DEPENDENCY_UNAVAILABLE' });
    expect(calls.calls).toBe(stage === 'after-receipt' ? 1 : 0);
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM quota_events WHERE request_id=? AND event='release'",
      )
        .bind(old.requestId)
        .first('n'),
    ).toBe(1);
    if (stage !== 'before-dispatch') {
      const dispatch = await env.DB.prepare(
        'SELECT id,state,transmission_enc,candidate_enc FROM provider_dispatches WHERE request_id=?',
      )
        .bind(old.requestId)
        .first<{
          id: string;
          state: string;
          transmission_enc: string | null;
          candidate_enc: string | null;
        }>();
      expect(dispatch).toMatchObject({
        state: stage === 'after-dispatch' ? 'unknown' : 'received',
        transmission_enc: null,
        candidate_enc: null,
      });
      expect(
        await env.DB.prepare(
          'SELECT state,actual_microusd FROM cost_reservations WHERE dispatch_id=?',
        )
          .bind(dispatch!.id)
          .first(),
      ).toEqual({
        state: stage === 'after-dispatch' ? 'unknown' : 'actual',
        actual_microusd: cost!.actual_microusd,
      });
    }
  },
);

test.each(['off', 'disabled'] as const)(
  'a previous local policy upgrade preserves operator %s mode',
  async (mode) => {
    const f = await setup();
    await f.generation.start(f.session, f.input, crypto.randomUUID());
    const { sha256Json } = await import('../../src/domain/json.ts');
    const previous = await sha256Json({ localOnly: true, writer: 'simulation.v1' });
    await env.DB.prepare(
      'UPDATE system_state SET provider_policy_hash=?,dispatch_mode=?,generation_enabled=?',
    )
      .bind(previous, mode === 'off' ? 'off' : 'model', mode === 'disabled' ? 0 : 1)
      .run();
    expect((await f.client.start()).status).not.toBe(202);
    expect(
      await env.DB.prepare('SELECT dispatch_mode,generation_enabled FROM system_state').first(),
    ).toEqual({
      dispatch_mode: mode === 'off' ? 'off' : 'model',
      generation_enabled: mode === 'disabled' ? 0 : 1,
    });
    expect(await env.DB.prepare('SELECT count(*) AS n FROM generation_requests').first('n')).toBe(
      1,
    );
  },
);
