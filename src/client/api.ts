import type { z } from 'zod';
import { apiSchemas } from '../contracts/index.ts';
export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string | null = null,
    readonly currentRevision: number | null = null,
    readonly correlationId: string | null = null,
    readonly retry: string | null = null,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  schema: z.ZodType<T>,
  body?: unknown,
  csrfToken?: string,
  options: { method?: string; revision?: number; key?: string; signal?: AbortSignal } = {},
): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    method: options.method ?? (body === undefined ? 'GET' : 'POST'),
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
      ...(options.revision ? { 'If-Match': `"${options.revision}"` } : {}),
      ...(options.key ? { 'Idempotency-Key': options.key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) {
    const parsed = apiSchemas.ErrorEnvelope.safeParse(await response.json().catch(() => null));
    throw new ApiFailure(
      response.status,
      parsed.success
        ? parsed.data.error.message
        : 'The account service is unavailable. Please try again.',
      parsed.success ? parsed.data.error.code : null,
      parsed.success ? parsed.data.error.currentRevision : null,
      parsed.success ? parsed.data.error.correlationId : null,
      parsed.success ? parsed.data.error.retry : null,
      parsed.success ? parsed.data.error.retryAfterSeconds : null,
    );
  }
  return schema.parse(response.status === 204 ? {} : await response.json());
}
