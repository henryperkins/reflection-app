import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { buildPlan } from '../../src/domain/tarot/plan.ts';
import { projectWriterPayload } from '../../src/domain/tarot/render.ts';
import type { WritingProvider } from '../../src/contracts/index.ts';
import {
  OpenAIWritingProvider,
  type ProviderQualification,
} from '../../src/worker/provider/openai.ts';
import { syntheticPlanInput } from '../fixtures/canon.ts';

let payload: Uint8Array;
beforeAll(async () => {
  payload = await projectWriterPayload(await buildPlan(await syntheticPlanInput()));
});
afterEach(() => vi.useRealTimers());
const qualification: ProviderQualification = {
  version: 'openai-responses.qualification.v1',
  model: 'gpt-5.6-terra',
  policyHash: 'a'.repeat(64),
  expiresAt: '2099-01-01T00:00:00Z',
  evidence: {
    projectAccess: 'b'.repeat(64),
    retention: 'c'.repeat(64),
    editorial: 'd'.repeat(64),
    corpus: 'e'.repeat(64),
    tokenEstimator: 'f'.repeat(64),
    pricing: '1'.repeat(64),
  },
};
const input = (): Parameters<WritingProvider['write']>[0] => ({
  dispatchId: crypto.randomUUID(),
  model: 'gpt-5.6-terra',
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
  model: 'gpt-5.6-terra',
  usage: { input_tokens: 31, output_tokens: 47, total_tokens: 78 },
  output: [
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: JSON.stringify({ synthetic: 'candidate' }) }],
    },
  ],
});
const options = (fetcher: typeof fetch) => ({
  enabled: true,
  apiKey: 'synthetic-test-only-key',
  fetch: fetcher,
  qualification,
  expectedPolicyHash: qualification.policyHash,
});

test('disabled and unqualified provider never enters its transport', async () => {
  const fetcher: typeof fetch = async () => {
    throw new Error('Transport was reached');
  };
  for (const config of [
    {},
    { ...options(fetcher), enabled: false },
    { ...options(fetcher), qualification: undefined },
    { ...options(fetcher), expectedPolicyHash: '2'.repeat(64) },
  ]) {
    expect(await new OpenAIWritingProvider(config).write(input())).toEqual({
      kind: 'rejected',
      status: 503,
    });
  }
});
test('qualified injected transport sends exact persisted bytes once with redirects and storage disabled', async () => {
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
  expect(await new OpenAIWritingProvider(options(fetcher)).write(supplied)).toMatchObject({
    kind: 'candidate',
    candidate: { synthetic: 'candidate' },
    returnedModel: 'gpt-5.6-terra',
    providerResponseId: 'resp_synthetic_only',
    inputTokens: 31,
    outputTokens: 47,
  });
  expect(calls).toBe(1);
});
test('an unauthorized payload cannot add tools, prior response state, or enable storage', async () => {
  const fetcher: typeof fetch = async () => {
    throw new Error('Forbidden transport');
  };
  for (const patch of [
    { tools: [] },
    { previous_response_id: 'private' },
    { store: true },
    { reasoning: { effort: 'high' } },
  ]) {
    const supplied = input();
    supplied.payload = new TextEncoder().encode(
      JSON.stringify({ ...JSON.parse(new TextDecoder().decode(payload)), ...patch }),
    );
    expect(await new OpenAIWritingProvider(options(fetcher)).write(supplied)).toEqual({
      kind: 'rejected',
      status: 400,
    });
  }
});
test('provider refusal is handled outside the model JSON schema', async () => {
  const body = {
    ...envelope(),
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'refusal', refusal: 'Synthetic refusal' }],
      },
    ],
  };
  expect(
    await new OpenAIWritingProvider(options(async () => Response.json(body))).write(input()),
  ).toEqual({ kind: 'refusal' });
});
test.each(['incomplete', 'malformed', 'tool-output', 'usage-missing'] as const)(
  'response %s remains unusable and is never retried',
  async (kind) => {
    let calls = 0;
    const body: Record<string, unknown> = envelope();
    if (kind === 'incomplete') body.status = 'incomplete';
    if (kind === 'tool-output')
      body.output = [...envelope().output, { type: 'function_call', name: 'forbidden' }];
    if (kind === 'usage-missing') delete body.usage;
    const result = await new OpenAIWritingProvider(
      options(async () => {
        calls++;
        return kind === 'malformed' ? new Response('{bad') : Response.json(body);
      }),
    ).write(input());
    expect(result).toEqual({ kind: 'uncertain', reason: 'lost_response' });
    expect(calls).toBe(1);
  },
);
test('bounded streaming reader cancels a response before accumulating oversized content', async () => {
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
  const result = await new OpenAIWritingProvider(options(async () => response)).write(input());
  expect(result).toEqual({ kind: 'uncertain', reason: 'lost_response' });
  expect(cancelled).toBe(true);
  expect(chunks).toBeLessThanOrEqual(3);
});
test('18-second timeout aborts a transport that ignores cancellation and never retries', async () => {
  vi.useFakeTimers();
  let calls = 0;
  let signal: AbortSignal | undefined;
  const promise = new OpenAIWritingProvider(
    options(async (_url, init) => {
      calls++;
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    }),
  ).write(input());
  await vi.advanceTimersByTimeAsync(18000);
  expect(await promise).toEqual({ kind: 'uncertain', reason: 'timeout' });
  expect(signal?.aborted).toBe(true);
  expect(calls).toBe(1);
  expect(vi.getTimerCount()).toBe(0);
});
test('provider errors and network loss never cause automatic retry', async () => {
  for (const status of [401, 429, 503]) {
    let calls = 0;
    expect(
      await new OpenAIWritingProvider(
        options(async () => {
          calls++;
          return new Response(null, { status });
        }),
      ).write(input()),
    ).toEqual({ kind: 'rejected', status });
    expect(calls).toBe(1);
  }
  expect(
    await new OpenAIWritingProvider(
      options(async () => {
        throw new TypeError('Synthetic network failure');
      }),
    ).write(input()),
  ).toEqual({ kind: 'uncertain', reason: 'network' });
});
