import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, expect, test } from 'vitest';
import {
  createRuntime,
  createRuntimeWorker,
  type RuntimeBindings,
} from '../../src/worker/runtime/application.ts';
import { clearDatabase } from '../fixtures/database.ts';
import { ReadingClient, readingAccount } from '../fixtures/reading-client.ts';
import { runtimeManifest, runtimeSecrets } from '../fixtures/runtime.ts';
import { IDENTITY_SECRETS } from '../fixtures/identity.ts';
import { apiSchemas } from '../../src/contracts/index.ts';
import { encode } from '../../src/worker/identity/crypto.ts';
import { canonicalJson } from '../../src/domain/json.ts';
import { failingDatabase } from '../fixtures/failing-generation-db.ts';
import { qualifiedFixture } from '../fixtures/qualified-generation.ts';

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(() => clearDatabase(env.DB));

function fixture() {
  const manifest = runtimeManifest();
  manifest.ingress = 'on';
  manifest.generation = 'intercepted';
  const bindings: RuntimeBindings = {
    DB: env.DB,
    OFFLINE_COORDINATOR: env.OFFLINE_COORDINATOR,
    RECOVERY_CONTROL_SECRET: 'synthetic-offline-control-token-not-a-deployed-secret',
    RECOVERY: env.RECOVERY,
    RUNTIME_MANIFEST: JSON.stringify(manifest),
    RUNTIME_RESOURCE_IDENTITIES: JSON.stringify(manifest.resources),
    IDENTITY_ORIGIN: manifest.origin,
    IDENTITY_SECRETS: JSON.stringify(runtimeSecrets(manifest.environmentId)),
  };
  return { manifest, bindings, worker: createRuntimeWorker() };
}

test('the hosted synthetic runtime uses intercepted generation and owns exact saved records without provider credentials', async () => {
  const f = fixture();
  let external = 0;
  const runtime = await createRuntime(f.bindings, async () => {
    external++;
    throw new Error('No egress');
  });
  expect(runtime.environmentId).toBe(f.manifest.environmentId);
  expect(runtime.health).toMatchObject({ mode: 'hosted-synthetic', generationReady: true });
  const client = new ReadingClient(f.bindings, f.worker);
  await readingAccount(true, true, client);
  const created = await client.create('Synthetic hosted runtime: compare two newsletter formats.');
  expect(created.reading).toMatchObject({
    kind: 'tarot.accepted.v2',
    provenance: { provider: null },
  });
  expect(external).toBe(0);
});

test('missing production provider artifacts stop new generation while owned record actions remain usable', async () => {
  const f = fixture(),
    client = new ReadingClient(f.bindings, f.worker);
  await readingAccount(true, true, client);
  const created = await client.create('Synthetic record to preserve across a provider outage.');
  await client.request(
    '/sessions/' + created.reading.sessionId + '/save',
    { saved: true },
    { method: 'PUT', revision: 1 },
  );
  f.manifest.mode = 'production';
  f.manifest.generation = 'qualified';
  f.manifest.qualificationEvidenceDigest = 'c'.repeat(64);
  f.bindings.RUNTIME_MANIFEST = JSON.stringify(f.manifest);
  const runtime = await createRuntime(f.bindings);
  expect(runtime.health).toMatchObject({ mode: 'production', generationReady: false });
  expect((await client.request('/me')).status).toBe(200);
  expect((await client.request('/sessions?status=saved')).status).toBe(200);
  expect(await (await client.request('/readings/' + created.reading.editionId)).json()).toEqual(
    created.reading,
  );
  expect(
    (
      await client.request('/sessions/' + created.reading.sessionId + '/reflections', {
        text: 'Synthetic saved thought during provider outage.',
        stance: 'unspecified',
        editionId: created.reading.editionId,
      })
    ).status,
  ).toBe(201);
  const ticket = apiSchemas.ExportTicket.parse(await (await client.request('/exports', {})).json());
  expect((await client.request('/exports/' + ticket.id)).status).toBe(200);
  const blocked = await client.request('/requests', {
    clientIntentId: crypto.randomUUID(),
    question: 'Synthetic new request must remain unpersisted.',
    languageConfirmed: 'en',
    reversals: false,
    permissionRevision: (await client.me()).permission.revision,
    parentEditionId: null,
    selection: [],
  });
  expect(blocked.status).toBe(503);
  expect(await env.DB.prepare('SELECT count(*) AS n FROM generation_requests').first('n')).toBe(1);
  await runtime.generation.maintenance();
  expect(await (await client.request('/readings/' + created.reading.editionId)).json()).toEqual(
    created.reading,
  );
  const current = apiSchemas.SessionRecord.parse(
    await (await client.request('/sessions/' + created.reading.sessionId)).json(),
  );
  expect(
    (
      await client.request(
        '/sessions/' + created.reading.sessionId,
        {
          receiptId: crypto.randomUUID(),
          receiptToken: encode(crypto.getRandomValues(new Uint8Array(32))),
        },
        { method: 'DELETE', revision: current.revision },
      )
    ).status,
  ).toBe(202);
});

test('hosted identity rejects public test keys, mismatched environments and resource binding declarations without leaking secrets', async () => {
  for (const failure of ['public', 'environment', 'resources']) {
    const f = fixture();
    if (failure === 'public')
      f.bindings.IDENTITY_SECRETS = JSON.stringify({
        ...IDENTITY_SECRETS,
        environment: f.manifest.environmentId,
      });
    if (failure === 'environment')
      f.bindings.IDENTITY_SECRETS = JSON.stringify(runtimeSecrets('wrong-environment'));
    if (failure === 'resources')
      f.bindings.RUNTIME_RESOURCE_IDENTITIES = JSON.stringify({
        ...f.manifest.resources,
        databaseId: 'unrelated-resource',
      });
    const response = await f.worker.fetch(
      new Request(f.manifest.origin + '/api/v1/me'),
      f.bindings,
    );
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).not.toContain('wrapKey');
    expect(body).not.toContain(f.bindings.IDENTITY_SECRETS!);
  }
});

test('default production ingress stays closed and cannot be opened by an HTTP header', async () => {
  const f = fixture();
  f.manifest.mode = 'production';
  f.manifest.ingress = 'off';
  f.manifest.generation = 'off';
  f.bindings.RUNTIME_MANIFEST = JSON.stringify(f.manifest);
  const response = await f.worker.fetch(
    new Request(f.manifest.origin + '/api/v1/me', {
      headers: { 'X-Runtime-Mode': 'synthetic-local', 'X-Enable-Production': 'true' },
    }),
    f.bindings,
  );
  expect(response.status).toBe(503);
});

test.each([
  'valid',
  'missing-key',
  'expired',
  'evidence-tamper',
  'blob-tamper',
  'wrong-project',
  'wrong-reviewer',
  'generation-disabled',
  'content-withdrawn',
])(
  'protected qualification bootstrap authenticates bytes and target identity: %s',
  async (failure) => {
    const f = fixture();
    f.manifest.environmentId = 'test-environment';
    f.manifest.mode = 'production';
    f.manifest.generation = 'qualified';
    f.bindings.IDENTITY_SECRETS = JSON.stringify(runtimeSecrets(f.manifest.environmentId));
    const q = await qualifiedFixture(env.DB, undefined, {
      projectId: 'proj_synthetic',
      environmentId: f.manifest.environmentId,
    });
    const source = q.qualificationSource;
    if (failure === 'expired') {
      source.signed.document.issuedAt = new Date(Date.now() - 7_200_000).toISOString();
      source.signed.document.expiresAt = new Date(Date.now() - 3_600_000).toISOString();
      source.signed.signature = encode(
        new Uint8Array(
          await crypto.subtle.sign(
            'Ed25519',
            source.keys.privateKey,
            new TextEncoder().encode(canonicalJson(source.signed.document)),
          ),
        ),
      );
    }
    const artifacts = {
      signedQualification: source.signed,
      evaluationManifest: encode(source.options.evaluationManifest),
      evidence: Object.fromEntries(
        Object.entries(source.options.evidence).map(([name, bytes]) => [name, encode(bytes)]),
      ),
    };
    if (failure === 'evidence-tamper')
      artifacts.evidence.retention = encode(new TextEncoder().encode('Changed evidence'));
    const bytes = new TextEncoder().encode(JSON.stringify(artifacts));
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
      b.toString(16).padStart(2, '0'),
    ).join('');
    f.manifest.policyHash = q.policyHash;
    f.manifest.contentHash = q.bundle.editionHash;
    f.manifest.qualificationEvidenceDigest = digest;
    f.bindings.RUNTIME_MANIFEST = JSON.stringify(f.manifest);
    f.bindings.OPENAI_API_KEY = failure === 'missing-key' ? '' : 'synthetic-key-never-sent';
    f.bindings.OPENAI_PROJECT_ID = failure === 'wrong-project' ? 'proj_other' : 'proj_synthetic';
    f.bindings.QUALIFICATION_ARTIFACTS = env.RECOVERY;
    f.bindings.QUALIFICATION_TRUST = JSON.stringify({
      providerPublicKey: await crypto.subtle.exportKey('jwk', source.keys.publicKey),
      providerReviewerId:
        failure === 'wrong-reviewer' ? 'wrong-reviewer' : source.options.reviewerId,
      contentPublicKey: await crypto.subtle.exportKey('jwk', q.contentTrust.publicKey),
      contentReviewerId: q.contentTrust.reviewerId,
    });
    await env.RECOVERY.put(
      'qualification/' + digest + '.json',
      failure === 'blob-tamper' ? JSON.stringify(artifacts) + ' ' : bytes,
    );
    if (failure === 'generation-disabled')
      await env.DB.prepare('UPDATE system_state SET generation_enabled=0').run();
    if (failure === 'content-withdrawn')
      await env.DB.prepare("UPDATE content_editions SET state='withdrawn'").run();
    const runtime = await createRuntime(f.bindings, q.config.fetch);
    expect(runtime.health.generationReady).toBe(failure === 'valid');
    if (failure === 'valid') {
      const client = new ReadingClient(f.bindings, createRuntimeWorker(q.config.fetch));
      await readingAccount(true, true, client);
      const created = await client.create(
        'Synthetic qualification: my work is manageable. How can I compare formats?',
      );
      expect(created.reading).toMatchObject({
        kind: 'tarot.accepted.v2',
        mode: 'model',
        provenance: { provider: 'openai' },
      });
      expect(q.calls()).toBe(1);
    } else {
      expect(runtime.identity).toBeDefined();
      expect(q.calls()).toBe(0);
    }
  },
);

test('disabled production maintenance expires authorized work without redispatch or losing unknown liability', async () => {
  const f = fixture();
  f.bindings.DB = failingDatabase('after-dispatch');
  const client = new ReadingClient(f.bindings, f.worker);
  await readingAccount(true, true, client);
  expect(
    (await client.start('Synthetic interrupted dispatch to preserve unknown liability.')).status,
  ).toBe(202);
  expect(await env.DB.prepare('SELECT count(*) n FROM provider_dispatches').first('n')).toBe(1);
  f.bindings.DB = env.DB;
  f.manifest.mode = 'production';
  f.manifest.generation = 'off';
  f.bindings.RUNTIME_MANIFEST = JSON.stringify(f.manifest);
  await env.DB.prepare('UPDATE generation_requests SET lease_expires_at=1,next_run_at=1').run();
  let calls = 0;
  const runtime = await createRuntime(f.bindings, async () => {
    calls++;
    throw new Error('No egress');
  });
  await runtime.generation.maintenance();
  await runtime.generation.maintenance();
  expect(calls).toBe(0);
  expect(await env.DB.prepare('SELECT state FROM generation_requests').first('state')).toBe(
    'blocked',
  );
  expect(await env.DB.prepare('SELECT state FROM cost_reservations').first('state')).toBe(
    'unknown',
  );
  expect(await env.DB.prepare('SELECT count(*) n FROM provider_dispatches').first('n')).toBe(1);
  expect(await env.DB.prepare('SELECT sum(held) n FROM quota_buckets').first('n')).toBe(0);
});
