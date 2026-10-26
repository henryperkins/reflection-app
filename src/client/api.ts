import type { z } from 'zod';
import { apiSchemas } from '../contracts/index.ts';
export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  schema: z.ZodType<T>,
  body?: unknown,
  csrfToken?: string,
): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const parsed = apiSchemas.ErrorEnvelope.safeParse(await response.json().catch(() => null));
    throw new ApiFailure(
      response.status,
      parsed.success
        ? parsed.data.error.message
        : 'The account service is unavailable. Please try again.',
    );
  }
  return schema.parse(response.status === 204 ? {} : await response.json());
}
