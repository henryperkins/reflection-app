import { READING_PRODUCT_COPY } from '../../contracts/product-copy.ts';
import { z } from 'zod';
import { apiSchemas, Id } from '../../contracts/index.ts';
import { IdentityError } from '../identity/types.ts';
import { localIdentity, type IdentityBindings } from '../identity/routes.ts';
import { RequestState } from './request-state.ts';
import { generationService, type GenerationFactory } from './runtime.ts';
import { RecordBase, RecordError } from './base.ts';
import { ReadingRecords } from './records.ts';
import { Reflections } from './reflections.ts';
import { ReadingExports } from './export.ts';
import { SessionErasure } from './erasure.ts';

export interface ReadingBindings extends IdentityBindings {
  READING_MODE?: string;
}
const messages: Record<string, string> = {
  UNSUPPORTED_LANGUAGE: READING_PRODUCT_COPY.unsupportedLanguage,
  PROVIDER_REFUSAL: READING_PRODUCT_COPY.providerRefusal,
  SAFETY_REVIEW: READING_PRODUCT_COPY.uncertainSafety,
  UNAUTHENTICATED: 'Please sign in again to continue.',
  CONSENT_REQUIRED: 'AI readings are off. Your saved readings and reflections remain available.',
  FORBIDDEN: 'Save and acknowledge your complete recovery kit before starting a reading.',
  NOT_FOUND: 'This record was not found.',
  CONTENT_UNAVAILABLE: 'This reading is no longer available.',
  CONFLICT: 'This record changed. Refresh it before trying again; keep your unsaved text.',
  PRECONDITION_REQUIRED: 'Refresh this record before making a change.',
  IDEMPOTENCY_MISMATCH: 'This action identifier was already used for different content.',
  QUOTA_EXCEEDED: 'Your reading allowance has been used. Saved readings remain available.',
  RATE_LIMITED: 'Too many requests. Please try again later.',
  KEY_UNAVAILABLE: 'This encrypted record could not be opened. It has not been replaced or erased.',
  EXPORT_CHANGED: 'Your records changed during export. Start a new export.',
};
export function recordResponse(body: unknown, status = 200, revision?: number) {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'private, no-store',
      ...(revision ? { ETag: `"${revision}"` } : {}),
    },
  });
}
async function readBody(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new RecordError(400, 'BAD_INPUT');
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > 256 * 1024) {
      await reader.cancel();
      throw new RecordError(413, 'INPUT_TOO_LARGE');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new RecordError(400, 'BAD_INPUT');
  }
}
export async function readingRoute(
  request: Request,
  env: ReadingBindings,
  defer?: (work: Promise<void>) => void,
  factory?: GenerationFactory,
): Promise<Response | null> {
  if (
    !['synthetic-local', 'qualified', 'live-local', 'live-preview'].includes(env.READING_MODE ?? '')
  )
    return null;
  const url = new URL(request.url),
    path = url.pathname.replace('/api/v1', ''),
    method = request.method;
  if (path === '/me' || path.startsWith('/auth/')) return null;
  let base: RecordBase | undefined, token: string | undefined;
  try {
    const identity = localIdentity(env);
    if (!identity || url.origin !== identity.origin)
      throw new RecordError(503, 'DEPENDENCY_UNAVAILABLE');
    if (request.headers.get('Sec-Fetch-Site') === 'cross-site')
      throw new RecordError(403, 'FORBIDDEN');
    base = new RecordBase(env.DB, identity);
    const erasure = new SessionErasure(base, env.RECOVERY!);
    const deletionMatch = path.match(/^\/deletions\/([^/]+)$/);
    if (method === 'GET' && deletionMatch) {
      const id = Id.parse(deletionMatch[1]);
      await identity.rate('deletion-status', id, 10, 60_000);
      return recordResponse(await erasure.status(id, request.headers.get('X-Deletion-Token')));
    }
    token = (request.headers.get('Cookie') ?? '')
      .split(';')
      .map((x) => x.trim())
      .find((x) => x.startsWith('__Host-session='))
      ?.slice('__Host-session='.length);
    const session = await identity.sessions.get(token);
    const records = new ReadingRecords(base),
      generation = new RequestState(base);
    const reflections = new Reflections(base),
      exports = new ReadingExports(base);
    const mutate = method !== 'GET';
    if (
      mutate &&
      (request.headers.get('Origin') !== identity.origin ||
        request.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !==
          'application/json' ||
        request.headers.get('X-CSRF-Token') !== session.csrfToken)
    )
      throw new RecordError(403, 'FORBIDDEN');
    if (mutate && session.writeFence) throw new RecordError(503, 'DEPENDENCY_UNAVAILABLE');
    await identity.rate(
      mutate ? 'record-write' : 'record-read',
      session.subjectId,
      mutate ? 30 : 120,
      60_000,
    );
    const body = mutate ? await readBody(request) : undefined;
    const key = () => Id.parse(request.headers.get('Idempotency-Key'));
    const revision = () => {
      const value = request.headers.get('If-Match');
      if (!value) throw new RecordError(428, 'PRECONDITION_REQUIRED');
      if (!/^"[1-9][0-9]*"$/.test(value)) throw new RecordError(400, 'BAD_INPUT');
      return z
        .number()
        .int()
        .positive()
        .max(Number.MAX_SAFE_INTEGER)
        .parse(Number(value.slice(1, -1)));
    };
    const match = (pattern: RegExp) => path.match(pattern);
    if (method === 'PUT' && path === '/permissions/model') {
      const input = apiSchemas.PermissionWrite.parse(body),
        value = await records.permission(session, input.modelAllowed, revision(), key());
      return recordResponse(value, 200, value.revision);
    }
    if (method === 'POST' && path === '/requests') {
      const service = generationService(base, env.READING_MODE, factory);
      if (!service) throw new RecordError(503, 'DEPENDENCY_UNAVAILABLE');
      await identity.rate('reading-start-minute', session.subjectId, 5, 60_000);
      await identity.rate('reading-start-day', session.subjectId, 20, 86_400_000);
      return recordResponse(
        await service.start(session, apiSchemas.StartRequest.parse(body), key(), defer),
        202,
      );
    }
    const after = () =>
      z.coerce
        .number()
        .int()
        .min(0)
        .max(Number.MAX_SAFE_INTEGER)
        .parse(url.searchParams.get('after') ?? 0);
    if (method === 'GET' && path === '/requests')
      return recordResponse(
        await generation.resolveIntent(
          session,
          Id.parse(url.searchParams.get('intentId')),
          after(),
        ),
      );
    const cancelMatch = match(/^\/requests\/([^/]+)\/cancel$/);
    if (method === 'POST' && cancelMatch) {
      apiSchemas.Empty.parse(body);
      const value = await generation.cancel(session, Id.parse(cancelMatch[1]), revision(), key());
      return recordResponse(value, 200, value.revision);
    }
    const requestMatch = match(/^\/requests\/([^/]+)$/);
    if (method === 'GET' && requestMatch)
      return recordResponse(await generation.status(session, Id.parse(requestMatch[1]), after()));
    if (method === 'GET' && path === '/sessions')
      return recordResponse(
        await records.history(
          session,
          url.searchParams.get('status') ?? 'saved',
          Number(url.searchParams.get('limit') ?? 20),
          url.searchParams.get('cursor'),
        ),
      );
    const sessionMatch = match(/^\/sessions\/([^/]+)$/);
    if (method === 'GET' && sessionMatch) {
      const value = await records.session(session, Id.parse(sessionMatch[1]));
      return recordResponse(value, 200, value.revision);
    }
    const saveMatch = match(/^\/sessions\/([^/]+)\/save$/);
    if (method === 'PUT' && saveMatch) {
      const value = await records.save(
        session,
        Id.parse(saveMatch[1]),
        revision(),
        key(),
        apiSchemas.SaveWrite.parse(body).saved,
      );
      return recordResponse(value, 200, value.revision);
    }
    const readingMatch = match(/^\/readings\/([^/]+)$/);
    if (method === 'GET' && readingMatch)
      return recordResponse(await records.reading(session, Id.parse(readingMatch[1])));
    const createReflection = match(/^\/sessions\/([^/]+)\/reflections$/);
    if (method === 'POST' && createReflection) {
      const value = await reflections.write(
        session,
        Id.parse(createReflection[1]),
        apiSchemas.ReflectionWrite.parse(body),
        key(),
      );
      return recordResponse(value, 201, value.revision);
    }
    const reflectionMatch = match(/^\/reflections\/([^/]+)$/);
    if (reflectionMatch && method === 'GET') {
      const wanted = url.searchParams.get('revision');
      const value = await reflections.read(
        session,
        Id.parse(reflectionMatch[1]),
        wanted === null ? undefined : z.coerce.number().int().min(1).max(100).parse(wanted),
      );
      return recordResponse(value, 200, value.revision);
    }
    if (reflectionMatch && method === 'PUT') {
      const value = await reflections.update(
        session,
        Id.parse(reflectionMatch[1]),
        revision(),
        key(),
        apiSchemas.ReflectionWrite.parse(body),
      );
      return recordResponse(value, 200, value.revision);
    }
    if (method === 'POST' && path === '/exports') {
      apiSchemas.Empty.parse(body);
      return recordResponse(await exports.create(session, key()), 201);
    }
    const exportMatch = match(/^\/exports\/([^/]+)$/);
    if (method === 'GET' && exportMatch)
      return recordResponse(
        await exports.page(session, Id.parse(exportMatch[1]), url.searchParams.get('cursor')),
      );
    if (method === 'DELETE' && sessionMatch)
      return recordResponse(
        await erasure.remove(
          session,
          Id.parse(sessionMatch[1]),
          revision(),
          key(),
          apiSchemas.DeleteRequest.parse(body),
        ),
        202,
      );
    const eraseRevision = match(/^\/reflections\/([^/]+)\/revisions\/([1-9][0-9]*)$/);
    if (method === 'DELETE' && eraseRevision)
      return recordResponse(
        await erasure.removeReflection(
          session,
          Id.parse(eraseRevision[1]),
          z.coerce.number().int().min(1).max(100).parse(eraseRevision[2]),
          revision(),
          key(),
          apiSchemas.DeleteRequest.parse(body),
        ),
        202,
      );
    if (method === 'DELETE' && path === '/account')
      return recordResponse(
        await erasure.removeAccount(session, key(), apiSchemas.DeleteRequest.parse(body)),
        202,
      );
    throw new RecordError(503, 'DEPENDENCY_UNAVAILABLE');
  } catch (error) {
    let failure =
      error instanceof RecordError
        ? error
        : error instanceof IdentityError
          ? new RecordError(
              error.status,
              error.status === 401
                ? 'UNAUTHENTICATED'
                : error.status === 429
                  ? 'RATE_LIMITED'
                  : 'FORBIDDEN',
            )
          : error instanceof z.ZodError
            ? new RecordError(400, 'BAD_INPUT')
            : new RecordError(503, 'DEPENDENCY_UNAVAILABLE');
    if (error instanceof Error && /CHECK constraint|UNIQUE constraint/.test(error.message)) {
      failure = new RecordError(409, 'CONFLICT');
      try {
        await base?.identity.sessions.get(token);
      } catch {
        failure = new RecordError(401, 'UNAUTHENTICATED');
      }
    }
    return recordResponse(
      apiSchemas.ErrorEnvelope.parse({
        error: {
          code: failure.code,
          message:
            messages[failure.code] ?? 'This action could not be completed. Please try again.',
          correlationId: crypto.randomUUID(),
          retry:
            failure.status === 409
              ? 'refresh_then_retry'
              : failure.status >= 429
                ? 'after_delay'
                : 'never',
          retryAfterSeconds: failure.status === 429 ? 60 : null,
          currentRevision: failure.revision,
        },
      }),
      failure.status,
    );
  }
}
