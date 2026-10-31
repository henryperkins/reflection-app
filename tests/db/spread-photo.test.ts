import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, expect, test } from 'vitest';
import { createLocalLiveWorker, createHostedPreviewWorker } from '../../src/worker/local-live.ts';
import { apiSchemas, AcceptedReadingV2, type ProviderReceipt } from '../../src/contracts/index.ts';
import { settleSpreadCost } from '../../src/worker/provider/spread-costs.ts';
import { clearDatabase } from '../fixtures/database.ts';
import { ReadingClient, readingAccount, readingBindings } from '../fixtures/reading-client.ts';
import { IDENTITY_SECRETS } from '../fixtures/identity.ts';
import { candidateFromRequest } from '../fixtures/qualified-generation.ts';
import { failingDatabase } from '../fixtures/failing-generation-db.ts';

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(() => clearDatabase(env.DB));
const photo =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
const cards = [
  { position: 'situation', cardId: 'major-00', orientation: 'upright' },
  { position: 'tension', cardId: 'cups-05', orientation: 'reversed' },
  { position: 'possibility', cardId: 'wands-10', orientation: 'upright' },
];
const recognitionReceipt: ProviderReceipt = {
  responseId: 'resp_vision',
  returnedModel: 'muse-spark-1.3',
  serviceTier: 'auto',
  durationMs: 1,
  usage: {
    inputTokens: 1000,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 100,
    reasoningTokens: 10,
  },
};
async function setup(
  withKey = true,
  mode: 'live-local' | 'live-preview' = 'live-local',
  db = env.DB,
) {
  const bindings = {
    ...readingBindings,
    DB: db,
    IDENTITY_MODE: mode,
    IDENTITY_ORIGIN:
      mode === 'live-preview'
        ? 'https://reflection-preview.example.com'
        : readingBindings.IDENTITY_ORIGIN!,
    IDENTITY_SECRETS: JSON.stringify({ ...IDENTITY_SECRETS, environment: mode }),
    READING_MODE: mode,
    OPENAI_API_KEY: 'synthetic-test-key',
    OPENAI_PROJECT_ID: 'proj_synthetic',
    ...(withKey ? { MODEL_API_KEY: 'synthetic-vision-key' } : {}),
  };
  let visionCalls = 0,
    writerCalls = 0;
  let includeVisionUsage = true;
  let beforeVisionReturn = async () => {};
  const worker = (mode === 'live-preview' ? createHostedPreviewWorker : createLocalLiveWorker)(
    async (url, init) => {
      const vision = String(url).startsWith('https://api.meta.ai/');
      if (vision) {
        visionCalls++;
        await beforeVisionReturn();
      } else writerCalls++;
      return Response.json({
        id: vision ? 'resp_vision' : 'resp_writer',
        status: 'completed',
        model: vision ? 'muse-spark-1.3' : 'gpt-6.1-terra',
        service_tier: vision ? 'auto' : 'fast',
        usage:
          vision && !includeVisionUsage
            ? undefined
            : {
                input_tokens: 1000,
                input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
                output_tokens: 100,
                output_tokens_details: { reasoning_tokens: 10 },
                total_tokens: 1100,
              },
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: JSON.stringify(
                  vision
                    ? { cards }
                    : candidateFromRequest(
                        new Uint8Array(await new Request(url, init).arrayBuffer()),
                      ),
                ),
              },
            ],
          },
        ],
      });
    },
  );
  const client = new ReadingClient(bindings, {
    fetch: (request, env) => worker.fetch(request, env),
  });
  await readingAccount(true, true, client);
  const me = await client.me();
  const input = {
    clientIntentId: crypto.randomUUID(),
    question: 'How can I compare formats?',
    languageConfirmed: 'en',
    reversals: false,
    permissionRevision: me.permission.revision,
    parentEditionId: null,
    selection: [],
    spreadPhoto: photo,
  };
  return {
    client,
    input,
    bindings,
    worker,
    visionCalls: () => visionCalls,
    writerCalls: () => writerCalls,
    omitVisionUsage: () => {
      includeVisionUsage = false;
    },
    beforeVisionReturn: (fn: () => Promise<void>) => {
      beforeVisionReturn = fn;
    },
  };
}

test.each(['live-local', 'live-preview'] as const)(
  '%s rejects a photo when the Meta key is absent',
  async (mode) => {
    const f = await setup(false, mode);
    const response = await f.client.request('/requests', f.input);
    expect(response.status).toBe(503);
    expect(f.writerCalls()).toBe(0);
  },
);

test('exhausted reading quota prevents photo egress', async () => {
  const f = await setup();
  await f.client.create();
  await env.DB.prepare('UPDATE quota_buckets SET consumed=allowance,held=0').run();
  const response = await f.client.request('/requests', f.input);
  expect(response.status).toBe(429);
  expect(f.visionCalls()).toBe(0);
});

test('the generation stop switch prevents photo egress', async () => {
  const f = await setup();
  await env.DB.prepare('UPDATE system_state SET generation_enabled=0').run();
  const response = await f.client.request('/requests', f.input);
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(f.visionCalls()).toBe(0);
});

test('concurrent retries join the durable photo request without another provider call', async () => {
  const f = await setup();
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.beforeVisionReturn(async () => {
    enter();
    await barrier;
  });
  const key = crypto.randomUUID();
  const first = f.client.request('/requests', f.input, { key });
  await entered;
  try {
    const joined = await f.client.request('/requests', f.input, { key });
    expect(joined.status).toBe(202);
    const value = apiSchemas.StartResponse.parse(await joined.json());
    expect(value.joined).toBe(true);
    expect(f.visionCalls()).toBe(1);
    expect(await env.DB.prepare('SELECT state FROM quota_reservations').first('state')).toBe(
      'held',
    );
    release();
    const complete = apiSchemas.StartResponse.parse(await (await first).json());
    expect(complete.requestId).toBe(value.requestId);
    expect(complete.status.state).toBe('published');
    expect(f.writerCalls()).toBe(1);
  } finally {
    release();
    await first;
  }
});

test('near-limit photo survives generation, save and export', async () => {
  const f = await setup();
  const largePhoto = `data:image/jpeg;base64,${'A'.repeat(179972)}`;
  const response = await f.client.request('/requests', { ...f.input, spreadPhoto: largePhoto });
  expect(response.status, await response.clone().text()).toBe(202);
  const start = apiSchemas.StartResponse.parse(await response.json());
  expect(start.status.state).toBe('published');
  const reading = AcceptedReadingV2.parse(
    await (await f.client.request(`/readings/${start.status.editionId}`)).json(),
  );
  expect(reading.spreadPhoto).toBe(largePhoto);
  expect(
    (
      await f.client.request(
        `/sessions/${reading.sessionId}/save`,
        { saved: true },
        { method: 'PUT', revision: 1 },
      )
    ).status,
  ).toBe(200);
  const ticket = apiSchemas.ExportTicket.parse(
    await (await f.client.request('/exports', {})).json(),
  );
  const exported = await (await f.client.request(`/exports/${ticket.id}`)).json();
  expect(JSON.stringify(exported)).toContain(largePhoto);
});

test('photo recognition reserves spend before egress and settles actual usage', async () => {
  const f = await setup();
  f.beforeVisionReturn(async () => {
    const cost = await env.DB.prepare(
      "SELECT state,reserved_microusd FROM cost_reservations WHERE requested_model='muse-spark-1.3'",
    ).first();
    expect(cost).toEqual({ state: 'unknown', reserved_microusd: 1328128 });
  });
  const start = apiSchemas.StartResponse.parse(
    await (await f.client.request('/requests', f.input)).json(),
  );
  expect(start.status.state).toBe('published');
  expect(
    await env.DB.prepare(
      "SELECT state,actual_microusd FROM cost_reservations WHERE requested_model='muse-spark-1.3'",
    ).first(),
  ).toEqual({ state: 'actual', actual_microusd: 1675 });
});

test('exhausted spend budget prevents recognition', async () => {
  const f = await setup();
  await f.client.create();
  await env.DB.prepare('UPDATE spend_buckets SET committed_microusd=ceiling_microusd').run();
  await f.client.request('/requests', f.input);
  expect(f.visionCalls()).toBe(0);
  expect(
    await env.DB.prepare(
      'SELECT count(*) n FROM generation_requests WHERE spread_dispatch_id IS NOT NULL',
    ).first('n'),
  ).toBe(0);
});

test('an uncertain recognition result is terminal and retries do not resend or consume quota', async () => {
  const f = await setup();
  f.beforeVisionReturn(async () => {
    throw new Error('Synthetic lost response');
  });
  const key = crypto.randomUUID();
  const response = await f.client.request('/requests', f.input, { key });
  const first = apiSchemas.StartResponse.parse(await response.json());
  expect(first.status).toMatchObject({ state: 'blocked', errorCode: 'PROVIDER_UNCERTAIN' });
  const retry = apiSchemas.StartResponse.parse(
    await (await f.client.request('/requests', f.input, { key })).json(),
  );
  expect(retry.requestId).toBe(first.requestId);
  expect(f.visionCalls()).toBe(1);
  expect(f.writerCalls()).toBe(0);
  expect((await f.client.me()).remainingDay).toBe(3);
  expect(
    await env.DB.prepare(
      "SELECT state FROM cost_reservations WHERE requested_model='muse-spark-1.3'",
    ).first('state'),
  ).toBe('unknown');
});

test('revoking permission while recognition is pending prevents basis persistence and writing', async () => {
  const f = await setup();
  f.beforeVisionReturn(async () => {
    await f.client.permission(false);
  });
  const start = apiSchemas.StartResponse.parse(
    await (await f.client.request('/requests', f.input)).json(),
  );
  expect(start.status).toMatchObject({ state: 'blocked', errorCode: 'CONSENT_REQUIRED' });
  expect(f.visionCalls()).toBe(1);
  expect(f.writerCalls()).toBe(0);
  expect(await env.DB.prepare('SELECT count(*) n FROM basis_snapshots').first('n')).toBe(0);
});

test.each([
  'before-spread-dispatch',
  'after-spread-dispatch',
  'before-spread-basis',
  'after-spread-basis',
] as const)('recovery after %s never repeats an authorized image transmission', async (stage) => {
  const f = await setup(true, 'live-local', failingDatabase(stage));
  const started = apiSchemas.StartResponse.parse(
    await (await f.client.request('/requests', f.input)).json(),
  );
  expect(started.status.state).toBe('reserved');
  await env.DB.prepare('UPDATE generation_requests SET lease_expires_at=1,next_run_at=1').run();
  await f.worker.scheduled({} as ScheduledController, f.bindings, {} as ExecutionContext);
  const result = apiSchemas.RequestStatus.parse(
    await (await f.client.request(`/requests/${started.requestId}`)).json(),
  );
  const recoverable = stage === 'before-spread-dispatch' || stage === 'after-spread-basis';
  expect(result.state).toBe(recoverable ? 'published' : 'blocked');
  if (!recoverable) expect(result.errorCode).toBe('PROVIDER_UNCERTAIN');
  expect(f.visionCalls()).toBe(stage === 'after-spread-dispatch' ? 0 : 1);
  expect(f.writerCalls()).toBe(recoverable ? 1 : 0);
  expect((await f.client.me()).remainingDay).toBe(recoverable ? 2 : 3);
});

test('cancelling during recognition discards its result and preserves incurred cost', async () => {
  const f = await setup();
  f.beforeVisionReturn(async () => {
    const row = await env.DB.prepare('SELECT id,revision FROM generation_requests').first<{
      id: string;
      revision: number;
    }>();
    expect(
      (await f.client.request(`/requests/${row!.id}/cancel`, {}, { revision: row!.revision }))
        .status,
    ).toBe(200);
  });
  const started = apiSchemas.StartResponse.parse(
    await (await f.client.request('/requests', f.input)).json(),
  );
  expect(started.status.state).toBe('cancelled');
  expect(f.writerCalls()).toBe(0);
  expect((await f.client.me()).remainingDay).toBe(3);
  expect(await env.DB.prepare('SELECT count(*) n FROM basis_snapshots').first('n')).toBe(0);
  expect(
    await env.DB.prepare(
      "SELECT state FROM cost_reservations WHERE requested_model='muse-spark-1.3'",
    ).first('state'),
  ).toBe('actual');
});

test('session erasure detaches recognition cost metadata and removes its photo', async () => {
  const f = await setup();
  f.omitVisionUsage();
  const start = apiSchemas.StartResponse.parse(
    await (await f.client.request('/requests', f.input)).json(),
  );
  const dispatchId = await env.DB.prepare(
    'SELECT spread_dispatch_id FROM generation_requests WHERE id=?',
  )
    .bind(start.requestId)
    .first<string>('spread_dispatch_id');
  expect(
    await env.DB.prepare(
      "SELECT state FROM cost_reservations WHERE requested_model='muse-spark-1.3'",
    ).first('state'),
  ).toBe('unknown');
  const response = await f.client.request(
    `/sessions/${start.sessionId}`,
    { receiptId: crypto.randomUUID(), receiptToken: 'a'.repeat(43) },
    { method: 'DELETE', revision: 1 },
  );
  expect(response.status, await response.clone().text()).toBe(202);
  await f.worker.scheduled({} as ScheduledController, f.bindings, {} as ExecutionContext);
  expect(
    await env.DB.prepare(
      "SELECT owner_id,dispatch_id FROM cost_reservations WHERE requested_model='muse-spark-1.3'",
    ).first(),
  ).toEqual({ owner_id: null, dispatch_id: null });
  expect(
    await env.DB.prepare('SELECT input_enc,plan_enc FROM generation_requests WHERE id=?')
      .bind(start.requestId)
      .first(),
  ).toEqual({ input_enc: null, plan_enc: null });
  await settleSpreadCost(env.DB, dispatchId!, recognitionReceipt);
  expect(
    await env.DB.prepare(
      "SELECT state,actual_microusd,owner_id,dispatch_id FROM cost_reservations WHERE requested_model='muse-spark-1.3'",
    ).first(),
  ).toEqual({ state: 'actual', actual_microusd: 1675, owner_id: null, dispatch_id: null });
});

test('concurrent duplicate recognition receipts settle once, independent of transport timing', async () => {
  const f = await setup();
  f.omitVisionUsage();
  await f.client.request('/requests', f.input);
  const cost = await env.DB.prepare(
    "SELECT id,dispatch_id FROM cost_reservations WHERE requested_model='muse-spark-1.3'",
  ).first<{ id: string; dispatch_id: string }>();
  await Promise.all([
    settleSpreadCost(env.DB, cost!.dispatch_id, recognitionReceipt),
    settleSpreadCost(env.DB, cost!.dispatch_id, { ...recognitionReceipt, durationMs: 500 }),
  ]);
  expect(
    await env.DB.prepare('SELECT count(*) n FROM cost_adjustments WHERE cost_id=?')
      .bind(cost!.id)
      .first('n'),
  ).toBe(1);
  const committed = await env.DB.prepare(
    'SELECT committed_microusd FROM spend_buckets ORDER BY period',
  ).all();
  const actual = await env.DB.prepare(
    'SELECT sum(actual_microusd) actual FROM cost_reservations',
  ).first<number>('actual');
  expect(committed.results).toEqual([
    { committed_microusd: actual },
    { committed_microusd: actual },
  ]);
});

test('a conflicting recognition receipt stops new generation without overwriting settled usage', async () => {
  const f = await setup();
  await f.client.request('/requests', f.input);
  const dispatchId = await env.DB.prepare(
    'SELECT spread_dispatch_id FROM generation_requests',
  ).first<string>('spread_dispatch_id');
  await expect(
    settleSpreadCost(env.DB, dispatchId!, {
      ...recognitionReceipt,
      usage: { ...recognitionReceipt.usage, outputTokens: 200 },
    }),
  ).rejects.toThrow('conflicts with settled usage');
  expect(
    await env.DB.prepare('SELECT generation_enabled FROM system_state').first('generation_enabled'),
  ).toBe(0);
  expect(
    await env.DB.prepare(
      "SELECT actual_microusd FROM cost_reservations WHERE requested_model='muse-spark-1.3'",
    ).first('actual_microusd'),
  ).toBe(1675);
});

test('a recognition receipt cannot settle against a different reserved policy', async () => {
  const f = await setup();
  f.beforeVisionReturn(async () => {
    await env.DB.prepare(
      "UPDATE cost_reservations SET provider_policy_hash=? WHERE requested_model='muse-spark-1.3'",
    )
      .bind('0'.repeat(64))
      .run();
  });
  await f.client.request('/requests', f.input);
  expect(
    await env.DB.prepare(
      "SELECT state,actual_microusd FROM cost_reservations WHERE requested_model='muse-spark-1.3'",
    ).first(),
  ).toEqual({ state: 'unknown', actual_microusd: null });
});

test('recognition liability above its reservation is recorded and stops generation', async () => {
  const f = await setup();
  f.omitVisionUsage();
  await f.client.request('/requests', f.input);
  const dispatchId = await env.DB.prepare(
    'SELECT spread_dispatch_id FROM generation_requests',
  ).first<string>('spread_dispatch_id');
  await settleSpreadCost(env.DB, dispatchId!, {
    ...recognitionReceipt,
    usage: { ...recognitionReceipt.usage, inputTokens: 2_000_000 },
  });
  expect(
    await env.DB.prepare('SELECT generation_enabled FROM system_state').first('generation_enabled'),
  ).toBe(0);
  expect(
    await env.DB.prepare(
      "SELECT actual_microusd FROM cost_reservations WHERE requested_model='muse-spark-1.3'",
    ).first('actual_microusd'),
  ).toBe(2500425);
});

test('recognition settlement prices cached input separately and rounds the total once', async () => {
  const f = await setup();
  f.omitVisionUsage();
  await f.client.request('/requests', f.input);
  const dispatchId = await env.DB.prepare(
    'SELECT spread_dispatch_id FROM generation_requests',
  ).first<string>('spread_dispatch_id');
  await settleSpreadCost(env.DB, dispatchId!, {
    ...recognitionReceipt,
    usage: {
      inputTokens: 3,
      cachedInputTokens: 2,
      cacheWriteTokens: 0,
      outputTokens: 1,
      reasoningTokens: 0,
    },
  });
  expect(
    await env.DB.prepare(
      "SELECT actual_microusd FROM cost_reservations WHERE requested_model='muse-spark-1.3'",
    ).first('actual_microusd'),
  ).toBe(6);
});
