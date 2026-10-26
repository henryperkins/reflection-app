import { env } from 'cloudflare:workers';
import { expect } from 'vitest';
import { apiSchemas, AuthOptions, AuthResult } from '../../src/contracts/index.ts';
import worker, { type Env } from '../../src/worker/index.ts';
import { encode, uuidBytes } from '../../src/worker/identity/crypto.ts';
import { IDENTITY_ORIGIN, IDENTITY_SECRETS } from './identity.ts';
import { syntheticPasskey } from './passkeys.ts';

export const readingBindings = {
  DB: env.DB,
  RECOVERY: env.RECOVERY,
  IDENTITY_MODE: 'synthetic-local',
  READING_MODE: 'synthetic-local',
  IDENTITY_ORIGIN,
  IDENTITY_SECRETS: JSON.stringify(IDENTITY_SECRETS),
} as Env;
export class ReadingClient {
  cookies = new Map<string, string>();
  csrf = '';
  ip = crypto.randomUUID();
  constructor(readonly bindings = readingBindings) {}
  async request(
    path: string,
    body?: unknown,
    options: {
      method?: string;
      revision?: number;
      key?: string;
      headers?: Record<string, string>;
    } = {},
  ) {
    const response = await worker.fetch(
      new Request(IDENTITY_ORIGIN + '/api/v1' + path, {
        method: options.method ?? (body === undefined ? 'GET' : 'POST'),
        headers: {
          Origin: IDENTITY_ORIGIN,
          'Content-Type': 'application/json',
          Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
          'X-CSRF-Token': this.csrf,
          'CF-Connecting-IP': this.ip,
          ...(options.revision ? { 'If-Match': `"${options.revision}"` } : {}),
          ...(body === undefined ? {} : { 'Idempotency-Key': options.key ?? crypto.randomUUID() }),
          ...options.headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      this.bindings,
    );
    for (const cookie of response.headers.getSetCookie()) {
      const [name, ...value] = cookie.split(';')[0]!.split('=');
      this.cookies.set(name!, value.join('='));
    }
    return response;
  }
  async me() {
    const value = apiSchemas.SessionView.parse(await (await this.request('/me')).json());
    this.csrf = value.csrfToken;
    return value;
  }
  async permission(allowed: boolean) {
    const current = await this.me();
    const response = await this.request(
      '/permissions/model',
      { modelAllowed: allowed, policyVersion: 'egress.v1' },
      { method: 'PUT', revision: current.permission.revision },
    );
    expect(response.status, await response.clone().text()).toBe(200);
    return apiSchemas.Permission.parse(await response.json());
  }
  async acknowledge() {
    expect((await this.request('/auth/recovery/ack', {})).status).toBe(204);
    await this.me();
  }
  async start(
    question = 'Synthetic question for a saved return journey',
    intent = crypto.randomUUID(),
    key = crypto.randomUUID(),
  ) {
    const me = await this.me();
    return this.request(
      '/requests',
      {
        clientIntentId: intent,
        question,
        languageConfirmed: 'en',
        reversals: true,
        permissionRevision: me.permission.revision,
        parentEditionId: null,
        selection: [],
      },
      { key },
    );
  }
  async create(question?: string) {
    const response = await this.start(question);
    expect(response.status, await response.clone().text()).toBe(202);
    const started = apiSchemas.StartResponse.parse(await response.json());
    const status = apiSchemas.RequestStatus.parse(
      await (await this.request(`/requests/${started.requestId}`)).json(),
    );
    expect(status.state).toBe('published');
    const reading = apiSchemas.Reading.parse(
      await (await this.request(`/readings/${status.editionId}`)).json(),
    );
    return { started, status, reading };
  }
}
export async function readingAccount(ack = true, allowed = true) {
  const client = new ReadingClient(),
    passkey = await syntheticPasskey();
  const options = AuthOptions.parse(
    await (await client.request('/auth/options', { purpose: 'register' })).json(),
  );
  const reply = await client.request('/auth/register', {
    challengeId: options.challengeId,
    credential: await passkey.register(options),
  });
  expect(reply.status).toBe(200);
  const kit = AuthResult.parse(await reply.json());
  client.csrf = kit.csrfToken;
  if (ack) await client.acknowledge();
  if (allowed) await client.permission(true);
  return { client, passkey, kit };
}
export async function login(
  client: ReadingClient,
  passkey: Awaited<ReturnType<typeof syntheticPasskey>>,
  subjectId: string,
) {
  const options = AuthOptions.parse(
    await (await client.request('/auth/options', { purpose: 'authenticate' })).json(),
  );
  const response = await client.request('/auth/authenticate', {
    challengeId: options.challengeId,
    credential: await passkey.authenticate(options, encode(uuidBytes(subjectId))),
  });
  expect(response.status).toBe(200);
  await client.me();
}
