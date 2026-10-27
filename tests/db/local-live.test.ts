import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, expect, test } from 'vitest';
import { createLocalLiveWorker, createHostedPreviewWorker } from '../../src/worker/local-live.ts';
import { apiSchemas, AcceptedReadingV2 } from '../../src/contracts/index.ts';
import { clearDatabase } from '../fixtures/database.ts';
import { ReadingClient, readingAccount, readingBindings } from '../fixtures/reading-client.ts';
import { IDENTITY_SECRETS } from '../fixtures/identity.ts';
import { candidateFromRequest } from '../fixtures/qualified-generation.ts';
import { createWorker } from '../../src/worker/index.ts';
import {
  LOCAL_LIVE_READING_POLICY,
  READING_V2_EDITORIAL_EVALUATION_POLICY,
} from '../../src/contracts/provider-policy.ts';
import { providerPolicyHash } from '../../src/domain/provider-policy.ts';

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(() => clearDatabase(env.DB));

async function setup(mode: 'live-local' | 'live-preview' = 'live-local') {
  const bindings = {
    ...readingBindings,
    IDENTITY_MODE: mode as string,
    IDENTITY_ORIGIN:
      mode === 'live-preview'
        ? 'https://reflection-preview.example.com'
        : readingBindings.IDENTITY_ORIGIN!,
    IDENTITY_SECRETS: JSON.stringify({ ...IDENTITY_SECRETS, environment: mode }),
    READING_MODE: mode as string,
    OPENAI_API_KEY: 'synthetic-test-key',
    OPENAI_PROJECT_ID: 'proj_synthetic',
  };
  let calls = 0;
  let beforeReturn = async () => {};
  const factory = mode === 'live-preview' ? createHostedPreviewWorker : createLocalLiveWorker;
  const worker = factory(async (url, init) => {
    // Exercise workerd's Request validation as well as the response adapter.
    const request = new Request(url, init);
    calls++;
    const payload = new Uint8Array(await request.arrayBuffer());
    expect(new Headers(init!.headers).get('OpenAI-Project')).toBe('proj_synthetic');
    await beforeReturn();
    return Response.json({
      id: 'resp_local_test',
      object: 'response',
      status: 'completed',
      error: null,
      model: 'gpt-6.1-terra',
      service_tier: 'fast',
      usage: {
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
          status: 'completed',
          content: [{ type: 'output_text', text: JSON.stringify(candidateFromRequest(payload)) }],
        },
      ],
    });
  });
  let deferred = 0;
  const client = new ReadingClient(bindings, {
    fetch: (request, env) =>
      worker.fetch(
        request,
        env,
        mode === 'live-preview'
          ? ({
              waitUntil: () => {
                deferred++;
              },
            } as unknown as ExecutionContext)
          : undefined,
      ),
  });
  await readingAccount(true, true, client);
  return {
    bindings,
    worker,
    client,
    calls: () => calls,
    deferred: () => deferred,
    beforeReturn: (f: () => Promise<void>) => {
      beforeReturn = f;
    },
  };
}

test.each(['live-local', 'live-preview'] as const)(
  '%s Start uses the provider and saves exact output',
  async (mode) => {
    const f = await setup(mode);
    const created = await f.client.create('My work is manageable. How can I compare formats?');
    const reading = AcceptedReadingV2.parse(created.reading);
    expect(reading.mode).toBe('model');
    expect(reading.provenance.provider).toBe('openai');
    expect(reading.provenance.returnedModel).toBe('gpt-6.1-terra');
    expect(reading.kind === 'tarot.accepted.v2' && reading.contextReceipt?.diagnosticOnly).toBe(
      true,
    );
    expect(
      await env.DB.prepare(
        'SELECT state,reviewer_kind,rights_status,approval_json FROM content_editions',
      ).first(),
    ).toEqual({
      state: 'staged',
      reviewer_kind: 'agent_reviewed',
      rights_status: 'unknown',
      approval_json: null,
    });
    expect(f.calls()).toBe(1);
    expect(f.deferred()).toBe(0);
    expect(
      (
        await f.client.request(
          `/sessions/${reading.sessionId}/save`,
          { saved: true },
          { method: 'PUT', revision: 1 },
        )
      ).status,
    ).toBe(200);
    f.bindings.OPENAI_API_KEY = '';
    await f.client.permission(false);
    expect(await (await f.client.request(`/readings/${reading.editionId}`)).json()).toEqual(
      reading,
    );
    const ticket = apiSchemas.ExportTicket.parse(
      await (await f.client.request('/exports', {})).json(),
    );
    const exported = apiSchemas.ExportPage.parse(
      await (await f.client.request(`/exports/${ticket.id}`)).json(),
    );
    expect(exported.records.some((r) => r.kind === 'generation_receipt')).toBe(true);
    expect(f.calls()).toBe(1);
  },
);

test('hosted preview requires HTTPS and its configured origin', async () => {
  const f = await setup('live-preview');
  const health = await f.worker.fetch(
    new Request(`${f.bindings.IDENTITY_ORIGIN}/health`),
    f.bindings,
  );
  expect(await health.json()).toMatchObject({ mode: 'live-preview', provider: 'openai' });
  expect(
    (await f.worker.fetch(new Request('https://unrelated.example.com/health'), f.bindings)).status,
  ).toBe(403);
  f.bindings.IDENTITY_ORIGIN = 'http://reflection-preview.example.com';
  expect(
    (await f.worker.fetch(new Request(`${f.bindings.IDENTITY_ORIGIN}/health`), f.bindings)).status,
  ).toBe(503);
  expect(f.calls()).toBe(0);
});

test.each(['key', 'disabled', 'content-edit', 'wrong-origin', 'qualified-mode'])(
  'local live refuses %s before a provider call',
  async (failure) => {
    const f = await setup();
    const me = await f.client.me();
    if (failure === 'key') f.bindings.OPENAI_API_KEY = '';
    if (failure === 'disabled')
      await env.DB.prepare('UPDATE system_state SET generation_enabled=0').run();
    if (failure === 'content-edit')
      await env.DB.prepare("UPDATE content_editions SET bundle_json='{}'").run();
    if (failure === 'wrong-origin') f.bindings.IDENTITY_ORIGIN = 'https://example.com';
    if (failure === 'qualified-mode') f.bindings.READING_MODE = 'qualified';
    const response = await f.client.request('/requests', {
      clientIntentId: crypto.randomUUID(),
      question: 'How can I compare formats?',
      languageConfirmed: 'en',
      reversals: true,
      permissionRevision: me.permission.revision,
      parentEditionId: null,
      selection: [],
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(f.calls()).toBe(0);
  },
);

test('withdrawal during a live call prevents publication and releases the reading allowance', async () => {
  const f = await setup();
  f.beforeReturn(async () => {
    await env.DB.prepare("UPDATE content_editions SET state='withdrawn'").run();
  });
  const response = await f.client.start();
  const start = apiSchemas.StartResponse.parse(await response.json());
  expect(start.status.state).toBe('blocked');
  expect(await env.DB.prepare('SELECT count(*) AS n FROM reading_editions').first('n')).toBe(0);
  expect((await f.client.me()).remainingDay).toBe(3);
  expect(f.calls()).toBe(1);
});

test('the normal Worker cannot activate local live mode by an environment switch alone', async () => {
  const f = await setup();
  const client = new ReadingClient(f.bindings, createWorker());
  client.cookies = f.client.cookies;
  client.csrf = f.client.csrf;
  expect((await client.start()).status).toBe(503);
  expect(f.calls()).toBe(0);
});

test('health identifies live readings without exposing server credentials', async () => {
  const f = await setup();
  const response = await f.worker.fetch(new Request('http://localhost:8787/health'), f.bindings);
  const body = await response.text();
  expect(JSON.parse(body)).toMatchObject({ mode: 'live-local', provider: 'openai' });
  expect(body).not.toContain(f.bindings.OPENAI_API_KEY);
  expect(body).not.toContain(f.bindings.OPENAI_PROJECT_ID);
});

test('local bootstrap upgrades its prior development policy without enabling a stopped service', async () => {
  const f = await setup();
  await env.DB.prepare('UPDATE system_state SET provider_policy_hash=?,generation_enabled=0')
    .bind(await providerPolicyHash(READING_V2_EDITORIAL_EVALUATION_POLICY))
    .run();
  expect(
    (await f.worker.fetch(new Request('http://localhost:8787/health'), f.bindings)).status,
  ).toBe(200);
  expect(
    await env.DB.prepare(
      'SELECT provider_policy_hash,generation_enabled FROM system_state',
    ).first(),
  ).toEqual({
    provider_policy_hash: await providerPolicyHash(LOCAL_LIVE_READING_POLICY),
    generation_enabled: 0,
  });
  expect(f.calls()).toBe(0);
});
