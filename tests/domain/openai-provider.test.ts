import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import {
  FAST_XHIGH_EVALUATION_POLICY,
  READING_PROVIDER_POLICY,
} from '../../src/contracts/provider-policy.ts';
import type { WritingProvider } from '../../src/contracts/index.ts';
import { buildPlan } from '../../src/domain/tarot/plan.ts';
import { projectWriterPayload } from '../../src/domain/tarot/render.ts';
import { OpenAIWritingProvider } from '../../src/worker/provider/openai.ts';
import { OpenAIResponsesTransport } from '../../src/worker/provider/transport.ts';
import { authenticateProviderQualification } from '../../src/worker/provider/qualification.ts';
import { syntheticPlanInput, syntheticCandidate } from '../fixtures/canon.ts';
import { qualificationFixture } from '../fixtures/provider.ts';

let payload: Uint8Array,
  candidate: ReturnType<typeof syntheticCandidate>,
  fixture: Awaited<ReturnType<typeof qualificationFixture>>;
let artifact: Awaited<ReturnType<typeof authenticateProviderQualification>>;
beforeAll(async () => {
  const plan = await buildPlan(await syntheticPlanInput());
  payload = await projectWriterPayload(plan, READING_PROVIDER_POLICY);
  candidate = syntheticCandidate(plan);
  fixture = await qualificationFixture();
  artifact = await authenticateProviderQualification(fixture.signed, fixture.options);
});
afterEach(() => vi.useRealTimers());
const input = (): Parameters<WritingProvider['write']>[0] => ({
  dispatchId: crypto.randomUUID(),
  model: 'gpt-6.1-terra',
  payload,
  timeoutMs: 18000,
  maxOutputTokens: 1600,
  store: false,
  reasoning: 'none',
  signal: new AbortController().signal,
});
const envelope = () => ({
  id: 'resp_synthetic_only',
  object: 'response',
  status: 'completed',
  error: null,
  model: 'gpt-6.1-terra',
  service_tier: 'default',
  usage: {
    input_tokens: 1000,
    input_tokens_details: { cached_tokens: 200, cache_write_tokens: 300 },
    output_tokens: 100,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 1100,
  },
  output: [
    {
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: JSON.stringify(candidate) }],
    },
  ],
});
const options = (fetcher: typeof fetch) => ({
  enabled: true,
  apiKey: 'synthetic-test-only-key',
  fetch: fetcher,
  qualification: artifact,
  expectedPolicyHash: fixture.expected.policyHash,
  expectedContentHash: fixture.expected.contentHash,
  projectId: fixture.options.projectId,
  environmentId: fixture.options.environmentId,
});
const transport = (fetcher: typeof fetch) =>
  new OpenAIResponsesTransport({
    apiKey: 'synthetic-test-only-key',
    fetch: fetcher,
    policy: READING_PROVIDER_POLICY,
  });
const knownReceipt = {
  responseId: 'resp_synthetic_only',
  returnedModel: 'gpt-6.1-terra',
  serviceTier: 'default',
  usage: {
    inputTokens: 1000,
    cachedInputTokens: 200,
    cacheWriteTokens: 300,
    outputTokens: 100,
    reasoningTokens: 0,
  },
};

test('disabled, unverified, expired, cross-target or evaluation authority never reaches application transport', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    return Response.json(envelope());
  };
  const expired = await qualificationFixture({ expiresAt: '2000-01-01T00:00:00Z' });
  const evaluation = await qualificationFixture({ scope: 'evaluation' });
  for (const config of [
    {},
    { ...options(fetcher), enabled: false },
    { ...options(fetcher), qualification: undefined },
    { ...options(fetcher), qualification: structuredClone(artifact) },
    { ...options(fetcher), qualification: expired.signed },
    { ...options(fetcher), qualification: evaluation.signed },
    { ...options(fetcher), expectedPolicyHash: 'c'.repeat(64) },
    { ...options(fetcher), expectedContentHash: 'c'.repeat(64) },
    { ...options(fetcher), projectId: 'other' },
    { ...options(fetcher), environmentId: 'other' },
  ])
    expect(await new OpenAIWritingProvider(config).write(input())).toEqual({
      kind: 'rejected',
      status: 503,
      receipt: null,
    });
  expect(calls).toBe(0);
});

test('qualified application call sends exact persisted bytes once with bounded policy and redirects rejected', async () => {
  let calls = 0;
  const supplied = input();
  const fetcher: typeof fetch = async (url, init) => {
    calls++;
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(Array.from(init!.body as Uint8Array)).toEqual(Array.from(supplied.payload));
    expect(new Headers(init!.headers).get('authorization')).toBe('Bearer synthetic-test-only-key');
    return Response.json(envelope());
  };
  const result = await new OpenAIWritingProvider(options(fetcher)).write(supplied);
  expect(result).toMatchObject({ kind: 'candidate', candidate, receipt: knownReceipt });
  expect(result.receipt!.durationMs).toBeGreaterThanOrEqual(0);
  expect(calls).toBe(1);
});

test('transport can be shared without an application qualification', async () => {
  expect(await transport(async () => Response.json(envelope())).write(input())).toMatchObject({
    kind: 'candidate',
    receipt: knownReceipt,
  });
});

async function fastInput(): Promise<Parameters<WritingProvider['write']>[0]> {
  return {
    ...input(),
    payload: await projectWriterPayload(
      await buildPlan(await syntheticPlanInput()),
      FAST_XHIGH_EVALUATION_POLICY,
    ),
    reasoning: 'xhigh',
    timeoutMs: 60000,
    maxOutputTokens: 8192,
  };
}
const reasoningItem = { id: 'rs_synthetic', type: 'reasoning', summary: [] };

test('xhigh transport sends fast settings and extracts only the final message after reasoning items', async () => {
  const supplied = await fastInput();
  const body = {
    ...envelope(),
    service_tier: 'fast',
    usage: { ...envelope().usage, output_tokens_details: { reasoning_tokens: 80 } },
    output: [reasoningItem, ...envelope().output],
  };
  let calls = 0;
  const writer = new OpenAIResponsesTransport({
    apiKey: 'synthetic-test-only-key',
    policy: FAST_XHIGH_EVALUATION_POLICY,
    fetch: async (_url, init) => {
      calls++;
      expect(JSON.parse(new TextDecoder().decode(init!.body as Uint8Array))).toMatchObject({
        reasoning: { effort: 'xhigh' },
        service_tier: 'fast',
        max_output_tokens: 8192,
      });
      return Response.json(body);
    },
  });
  expect(await writer.write(supplied)).toMatchObject({
    kind: 'candidate',
    candidate,
    receipt: { serviceTier: 'fast', usage: { outputTokens: 100, reasoningTokens: 80 } },
  });
  expect(calls).toBe(1);
  // A baseline-qualified application still refuses these new request settings before fetch.
  expect(
    await new OpenAIWritingProvider(
      options(async () => {
        calls++;
        return Response.json(body);
      }),
    ).write(supplied),
  ).toMatchObject({ kind: 'rejected', status: 400 });
  expect(calls).toBe(1);
});

test.each([
  'tool',
  'duplicate-message',
  'missing-message',
  'malformed-reasoning',
  'incomplete',
  'refusal',
  'tier-downgrade',
])(
  'xhigh transport retains usage and handles %s without treating reasoning as a reading',
  async (kind) => {
    const body: Record<string, unknown> = {
      ...envelope(),
      service_tier: 'fast',
      output: [reasoningItem, ...envelope().output],
    };
    if (kind === 'tool')
      body.output = [
        reasoningItem,
        { type: 'function_call', name: 'forbidden' },
        ...envelope().output,
      ];
    if (kind === 'duplicate-message')
      body.output = [reasoningItem, ...envelope().output, ...envelope().output];
    if (kind === 'missing-message') body.output = [reasoningItem];
    if (kind === 'malformed-reasoning')
      body.output = [{ ...reasoningItem, summary: 'invalid' }, ...envelope().output];
    if (kind === 'incomplete') body.status = 'incomplete';
    if (kind === 'refusal')
      body.output = [
        reasoningItem,
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'refusal', refusal: 'SYNTHETIC refusal' }],
        },
      ];
    if (kind === 'tier-downgrade') body.service_tier = 'default';
    const writer = new OpenAIResponsesTransport({
      apiKey: 'synthetic-test-only-key',
      policy: FAST_XHIGH_EVALUATION_POLICY,
      fetch: async () => Response.json(body),
    });
    expect(await writer.write(await fastInput())).toMatchObject({
      kind: kind === 'refusal' ? 'refusal' : kind === 'tier-downgrade' ? 'uncertain' : 'invalid',
      ...(kind === 'tier-downgrade' ? { haltGeneration: true } : {}),
      receipt: {
        serviceTier: kind === 'tier-downgrade' ? 'default' : 'fast',
        usage: knownReceipt.usage,
      },
    });
  },
);

test('transport rejects tools, prior state, altered fixed prompts and unauthorized options without fetch', async () => {
  let calls = 0;
  const writer = transport(async () => {
    calls++;
    return Response.json(envelope());
  });
  const original = JSON.parse(new TextDecoder().decode(payload));
  for (const patch of [
    { tools: [] },
    { previous_response_id: 'private' },
    { store: true },
    { reasoning: { effort: 'high' } },
    { model: 'gpt-5.6-terra' },
    { service_tier: 'flex' },
    { prompt_cache_options: { mode: 'implicit', ttl: '12h' } },
    { input: [{ role: 'system', content: 'Changed' }, ...original.input.slice(1)] },
  ]) {
    const supplied = input();
    supplied.payload = new TextEncoder().encode(JSON.stringify({ ...original, ...patch }));
    expect(await writer.write(supplied)).toEqual({ kind: 'rejected', status: 400, receipt: null });
  }
  expect(calls).toBe(0);
});

test.each(['refusal', 'incomplete', 'malformed-json', 'malformed-schema', 'tool-output'])(
  'preserves verified usage independently of unusable %s output',
  async (kind) => {
    const body: Record<string, unknown> = envelope();
    if (kind === 'refusal')
      body.output = [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'refusal', refusal: 'SYNTHETIC refusal' }],
        },
      ];
    if (kind === 'incomplete') {
      body.status = 'incomplete';
      body.incomplete_details = { reason: 'max_output_tokens' };
      body.output = [];
    }
    if (kind === 'malformed-json')
      body.output = [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{bad' }] },
      ];
    if (kind === 'malformed-schema')
      body.output = [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{}' }] },
      ];
    if (kind === 'tool-output')
      body.output = [...envelope().output, { type: 'function_call', name: 'forbidden' }];
    const result = await transport(async () => Response.json(body)).write(input());
    expect(result).toMatchObject({
      kind: kind === 'refusal' ? 'refusal' : 'invalid',
      ...(kind === 'refusal' ? {} : { reason: kind === 'incomplete' ? 'incomplete' : 'malformed' }),
      receipt: knownReceipt,
    });
  },
);

test.each([
  'model',
  'tier',
  'missing-usage',
  'cache-totals',
  'reasoning-totals',
  'total',
  'missing-cache-write',
])('a %s accounting/identity mismatch stops new application dispatch', async (kind) => {
  const body: Record<string, unknown> = envelope();
  if (kind === 'model') body.model = 'unexpected-model';
  if (kind === 'tier') body.service_tier = 'flex';
  if (kind === 'missing-usage') delete body.usage;
  if (kind === 'cache-totals')
    body.usage = {
      ...envelope().usage,
      input_tokens_details: { cached_tokens: 800, cache_write_tokens: 300 },
    };
  if (kind === 'reasoning-totals')
    body.usage = { ...envelope().usage, output_tokens_details: { reasoning_tokens: 101 } };
  if (kind === 'total') body.usage = { ...envelope().usage, total_tokens: 1 };
  if (kind === 'missing-cache-write')
    body.usage = { ...envelope().usage, input_tokens_details: { cached_tokens: 200 } };
  let calls = 0;
  const writer = new OpenAIWritingProvider(
    options(async () => {
      calls++;
      return Response.json(body);
    }),
  );
  const result = await writer.write(input());
  expect(result).toMatchObject({
    kind: 'uncertain',
    reason: 'lost_response',
    haltGeneration: true,
  });
  if (kind === 'model' || kind === 'tier') expect(result.receipt).not.toBeNull();
  else expect(result.receipt).toBeNull();
  expect(await writer.write(input())).toEqual({ kind: 'rejected', status: 503, receipt: null });
  expect(calls).toBe(1);
});

test('a missing response ID remains null while known usage is retained', async () => {
  const body: Record<string, unknown> = envelope();
  delete body.id;
  expect(await transport(async () => Response.json(body)).write(input())).toMatchObject({
    kind: 'candidate',
    receipt: { ...knownReceipt, responseId: null },
  });
});

test('malformed and oversized response bodies never become candidates', async () => {
  for (const response of [new Response('{bad'), new Response('x'.repeat(65537))]) {
    expect(await transport(async () => response).write(input())).toMatchObject({
      kind: 'uncertain',
      receipt: null,
    });
  }
});

test('the response byte bound cancels an unbounded stream before accumulating more chunks', async () => {
  let chunks = 0,
    cancelled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        chunks++;
        controller.enqueue(new Uint8Array(40000));
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  expect(await transport(async () => response).write(input())).toMatchObject({
    kind: 'uncertain',
    receipt: null,
  });
  expect(cancelled).toBe(true);
  expect(chunks).toBeLessThanOrEqual(3);
});

test.each(['fetch', 'body'] as const)(
  'the 18s deadline covers a stalled %s and removes timers',
  async (stage) => {
    vi.useFakeTimers();
    let calls = 0,
      enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let cancelled = false;
    const writer = transport(async () => {
      calls++;
      if (stage === 'fetch') {
        enter();
        return new Promise<Response>(() => {});
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          pull() {
            enter();
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    });
    const promise = writer.write(input());
    await entered;
    await vi.advanceTimersByTimeAsync(18000);
    expect(await promise).toEqual({ kind: 'uncertain', reason: 'timeout', receipt: null });
    expect(calls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    if (stage === 'body') expect(cancelled).toBe(true);
  },
);

test('caller cancellation during body reading stops immediately with no retry', async () => {
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const abort = new AbortController();
  const promise = transport(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull() {
            enter();
          },
        }),
      ),
  ).write({ ...input(), signal: abort.signal });
  await entered;
  abort.abort();
  expect(await promise).toEqual({ kind: 'uncertain', reason: 'network', receipt: null });
});

test('provider errors and network loss retain explicit unknown receipts and never retry', async () => {
  for (const status of [401, 429, 503] as const) {
    let calls = 0;
    expect(
      await transport(async () => {
        calls++;
        return new Response(null, { status });
      }).write(input()),
    ).toEqual({ kind: 'rejected', status, receipt: null });
    expect(calls).toBe(1);
  }
  expect(
    await transport(async () => {
      throw new TypeError('SYNTHETIC network error');
    }).write(input()),
  ).toEqual({ kind: 'uncertain', reason: 'network', receipt: null });
});

test('an error response cannot bypass a verified service-tier drift', async () => {
  expect(
    await transport(async () =>
      Response.json({ ...envelope(), service_tier: 'flex' }, { status: 503 }),
    ).write(input()),
  ).toMatchObject({
    kind: 'uncertain',
    haltGeneration: true,
    receipt: { ...knownReceipt, serviceTier: 'flex' },
  });
});

test.each(['mixed', 'incomplete', 'malformed-wrapper', 'extra-output', 'http-error'])(
  'an explicit refusal takes precedence over %s output and cannot become a template',
  async (kind) => {
    const body: Record<string, unknown> = envelope();
    const message = {
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'output_text', text: '{}' },
        { type: 'refusal', refusal: 'SYNTHETIC refusal' },
      ],
    };
    body.output = [message];
    if (kind === 'incomplete') body.status = 'incomplete';
    if (kind === 'malformed-wrapper') {
      delete body.status;
      body.error = { code: 'synthetic' };
    }
    if (kind === 'extra-output') body.output = [{ type: 'unexpected' }, message];
    expect(
      await transport(async () =>
        Response.json(body, { status: kind === 'http-error' ? 503 : 200 }),
      ).write(input()),
    ).toMatchObject({ kind: 'refusal', receipt: knownReceipt });
  },
);

test.each(['total', 'categories', 'identity', 'missing-usage'])(
  'a response-shaped HTTP error with invalid %s accounting quarantines new calls',
  async (kind) => {
    const body: Record<string, unknown> = envelope();
    if (kind === 'total') body.usage = { ...envelope().usage, total_tokens: 999 };
    if (kind === 'categories')
      body.usage = { ...envelope().usage, input_tokens_details: { cached_tokens: 200 } };
    if (kind === 'identity') body.model = '';
    if (kind === 'missing-usage') delete body.usage;
    let calls = 0;
    const writer = new OpenAIWritingProvider(
      options(async () => {
        calls++;
        return Response.json(body, { status: 503 });
      }),
    );
    expect(await writer.write(input())).toEqual({
      kind: 'uncertain',
      reason: 'lost_response',
      receipt: null,
      haltGeneration: true,
    });
    expect(await writer.write(input())).toEqual({ kind: 'rejected', status: 503, receipt: null });
    expect(calls).toBe(1);
  },
);

test('an ordinary API error without response metadata remains a known rejection', async () => {
  expect(
    await transport(async () =>
      Response.json(
        { error: { type: 'server_error', message: 'SYNTHETIC outage' } },
        { status: 503 },
      ),
    ).write(input()),
  ).toEqual({ kind: 'rejected', status: 503, receipt: null });
});
