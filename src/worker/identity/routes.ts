import { z } from 'zod';
import { apiSchemas, Base64url } from '../../contracts/index.ts';
import { IdentityCrypto, parseIdentitySecrets } from './crypto.ts';
import { IdentityService } from './service.ts';
import { IdentityError } from './types.ts';

export interface IdentityBindings {
  DB: D1Database;
  RECOVERY?: R2Bucket;
  IDENTITY_MODE?: string;
  IDENTITY_ORIGIN?: string;
  IDENTITY_SECRETS?: string;
}
export function localIdentity(env: IdentityBindings): IdentityService | null {
  if (
    !['synthetic-local', 'live-local', 'live-preview'].includes(env.IDENTITY_MODE ?? '') ||
    !env.RECOVERY ||
    !env.IDENTITY_ORIGIN ||
    !env.IDENTITY_SECRETS
  )
    return null;
  const origin = new URL(env.IDENTITY_ORIGIN);
  if (
    origin.origin !== env.IDENTITY_ORIGIN ||
    (env.IDENTITY_MODE === 'live-preview'
      ? origin.protocol !== 'https:' || origin.hostname === 'localhost'
      : origin.hostname !== 'localhost') ||
    !['http:', 'https:'].includes(origin.protocol)
  )
    return null;
  const secrets = parseIdentitySecrets(env.IDENTITY_SECRETS);
  if (secrets.environment !== env.IDENTITY_MODE) return null;
  return new IdentityService(
    env.DB,
    env.RECOVERY,
    new IdentityCrypto(secrets),
    env.IDENTITY_ORIGIN,
  );
}
function cookies(request: Request) {
  return new Map(
    (request.headers.get('Cookie') ?? '')
      .split(';')
      .filter(Boolean)
      .map((value) => {
        const at = value.indexOf('=');
        return [value.slice(0, at).trim(), value.slice(at + 1)];
      }),
  );
}
const cookie = (name: string, value: string, seconds: number) =>
  `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=${name === '__Host-challenge' ? 'Strict' : 'Lax'}; Max-Age=${seconds}`;
export async function identityRoute(
  request: Request,
  env: IdentityBindings,
): Promise<Response | null> {
  const path = new URL(request.url).pathname.replace('/api/v1', '');
  if (path !== '/me' && !path.startsWith('/auth/')) return null;
  const headers = new Headers({
    'Cache-Control': 'private, no-store',
    'Content-Type': 'application/json',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  const reply = (body: unknown, status = 200) => {
    if (status >= 400) {
      const code =
        status === 401
          ? 'UNAUTHENTICATED'
          : status === 403
            ? 'FORBIDDEN'
            : status === 429
              ? 'RATE_LIMITED'
              : status === 503
                ? 'DEPENDENCY_UNAVAILABLE'
                : status === 404
                  ? 'NOT_FOUND'
                  : status === 409
                    ? 'CONFLICT'
                    : 'BAD_INPUT';
      body = apiSchemas.ErrorEnvelope.parse({
        error: {
          code,
          message:
            status === 401
              ? 'Sign-in or recovery could not be verified.'
              : status === 429
                ? 'Too many attempts. Please try again later.'
                : status === 503
                  ? 'The account service is temporarily unavailable.'
                  : 'This request could not be accepted.',
          correlationId: crypto.randomUUID(),
          retry: status === 429 ? 'after_delay' : status === 503 ? 'refresh_then_retry' : 'never',
          retryAfterSeconds: status === 429 ? 3600 : null,
          currentRevision: null,
        },
      });
    }
    return new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
  };
  try {
    const service = localIdentity(env);
    if (!service || new URL(request.url).origin !== service.origin)
      throw new IdentityError(503, 'NOT_AVAILABLE');
    if (request.headers.get('Sec-Fetch-Site') === 'cross-site')
      throw new IdentityError(403, 'FORBIDDEN');
    if (request.method !== 'GET' && request.method !== 'POST' && request.method !== 'DELETE')
      return reply({ error: 'METHOD_NOT_ALLOWED' }, 405);
    const jar = cookies(request),
      sessionToken = jar.get('__Host-session');
    const session = () => service.sessions.get(sessionToken);
    if (request.method === 'GET') {
      if (path === '/me') return reply(await service.sessions.view(await session()));
      if (path === '/auth/credentials') return reply(await service.credentials(await session()));
      return reply({ error: 'NOT_FOUND' }, 404);
    }
    const removingCredential = request.method === 'DELETE' && path.startsWith('/auth/credentials/');
    if (request.method === 'DELETE' && !removingCredential)
      return reply({ error: 'NOT_FOUND' }, 404);
    if (
      request.headers.get('Origin') !== service.origin ||
      request.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !==
        'application/json'
    )
      throw new IdentityError(403, 'FORBIDDEN');
    const reader = request.body?.getReader();
    if (!reader && !removingCredential) throw new IdentityError(400, 'BAD_INPUT');
    let total = 0;
    const chunks: Uint8Array[] = [];
    while (reader) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.length;
      if (total > 256 * 1024) {
        await reader.cancel();
        throw new IdentityError(400, 'BAD_INPUT');
      }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    let body: unknown;
    try {
      body =
        removingCredential && total === 0
          ? {}
          : JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      throw new IdentityError(400, 'BAD_INPUT');
    }
    const csrf = async (recent = false) => {
      const current = await session();
      if (request.headers.get('X-CSRF-Token') !== current.csrfToken)
        throw new IdentityError(403, 'FORBIDDEN');
      if (current.writeFence) throw new IdentityError(503, 'DEPENDENCY_UNAVAILABLE');
      if (recent && current.authenticatedAt <= Date.now() - 300_000)
        throw new IdentityError(401, 'REAUTH_REQUIRED');
      return current;
    };
    const ip = request.headers.get('CF-Connecting-IP') ?? 'loopback';
    const setSession = (token: string) =>
      headers.append('Set-Cookie', cookie('__Host-session', token, 604800));
    const clearChallenge = () => headers.append('Set-Cookie', cookie('__Host-challenge', '', 0));
    if (removingCredential) {
      apiSchemas.Empty.parse(body);
      const id = Base64url.parse(path.slice('/auth/credentials/'.length));
      const issued = await service.removeCredential(await csrf(true), id);
      setSession(issued.token);
      clearChallenge();
      return reply(null, 204);
    }
    if (path === '/auth/options') {
      const input = apiSchemas.AuthBegin.parse(body);
      await service.rate('challenge', ip, 10, 600_000);
      const current =
        input.purpose === 'add' || input.purpose === 'reauthenticate'
          ? await csrf(input.purpose === 'add')
          : undefined;
      const result = await service.begin(input.purpose, current);
      headers.append('Set-Cookie', cookie('__Host-challenge', result.browser, 300));
      return reply(result.options);
    }
    if (path === '/auth/register') {
      const input = apiSchemas.RegisterFinish.parse(body);
      const current = sessionToken
        ? await service.sessions.get(sessionToken).catch(() => undefined)
        : undefined;
      const issued = await service.register(
        input,
        jar.get('__Host-challenge'),
        ip,
        current,
        request.headers.get('X-CSRF-Token') ?? undefined,
      );
      setSession(issued.token);
      clearChallenge();
      return reply(issued.result);
    }
    if (path === '/auth/authenticate') {
      const input = apiSchemas.AuthenticateFinish.parse(body);
      await service.rate('authentication', ip, 10, 600_000);
      const current = sessionToken
        ? await service.sessions.get(sessionToken).catch(() => undefined)
        : undefined;
      const issued = await service.authenticate(input, jar.get('__Host-challenge'), current);
      setSession(issued.token);
      clearChallenge();
      return reply(issued.result);
    }
    if (path === '/auth/recover') {
      const input = apiSchemas.Recover.parse(body);
      const recovered = await service.recover(input, ip);
      headers.append('Set-Cookie', cookie('__Host-challenge', recovered.browser, 300));
      headers.append('Set-Cookie', cookie('__Host-session', '', 0));
      return reply(recovered.result);
    }
    if (path === '/auth/recovery/ack') {
      apiSchemas.Empty.parse(body);
      const issued = await service.acknowledge(await csrf());
      if (issued) setSession(issued.token);
      return reply(null, 204);
    }
    if (path === '/auth/recovery-codes') {
      apiSchemas.Empty.parse(body);
      const issued = await service.rotate(await csrf(true));
      setSession(issued.token);
      return reply(issued.kit);
    }
    if (path === '/auth/logout' || path === '/auth/logout-all') {
      apiSchemas.Empty.parse(body);
      const current = await csrf();
      if (path === '/auth/logout-all') await service.logoutAll(current);
      else await service.sessions.logout(current);
      headers.append('Set-Cookie', cookie('__Host-session', '', 0));
      clearChallenge();
      return reply(null, 204);
    }
    return reply({ error: 'NOT_AVAILABLE' }, 503);
  } catch (error) {
    if (error instanceof IdentityError) return reply({ error: error.code }, error.status);
    if (error instanceof z.ZodError) return reply({ error: 'BAD_INPUT' }, 400);
    // Constraint races are generic authentication failures; dependency details never leave the server.
    if (
      error instanceof Error &&
      /D1_ERROR:.*(CHECK|UNIQUE)|CHECK constraint failed|UNIQUE constraint failed/.test(
        error.message,
      )
    )
      return reply({ error: 'AUTH_FAILED' }, 401);
    return reply({ error: 'DEPENDENCY_UNAVAILABLE' }, 503);
  }
}
