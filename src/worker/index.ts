import { Hono } from 'hono';
import { identityRoute, localIdentity, type IdentityBindings } from './identity/routes.ts';
import { readingRoute, type ReadingBindings } from './readings/routes.ts';
import { RecordBase } from './readings/base.ts';
import { SessionErasure } from './readings/erasure.ts';
import { LocalGeneration } from './readings/generation.ts';

export interface Env extends IdentityBindings, ReadingBindings {
  ASSETS?: Fetcher;
  RESTORE_MODE?: string;
}

const app = new Hono<{ Bindings: Env }>();
app.use('*', async (c, next) => {
  await next();
  c.header(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
});
app.get('/health', (c) => c.json({ status: 'ok', milestone: 1, mode: 'synthetic-only' }));
app.all('/api/v1/*', async (c, next) => {
  if (
    c.env.RESTORE_MODE === 'offline' ||
    (c.env.IDENTITY_MODE === 'synthetic-local' &&
      (await c.env.DB.prepare(
        'SELECT restore_in_progress FROM system_state WHERE id=1',
      ).first<number>('restore_in_progress')))
  ) {
    return c.json(
      {
        error: {
          code: 'DEPENDENCY_UNAVAILABLE',
          message: 'The service is offline for recovery.',
          correlationId: crypto.randomUUID(),
          retry: 'after_delay',
          retryAfterSeconds: 60,
          currentRevision: null,
        },
      },
      503,
      { 'Cache-Control': 'private, no-store' },
    );
  }
  const response = await identityRoute(c.req.raw, c.env);
  if (response) return response;
  const reading = await readingRoute(c.req.raw, c.env);
  if (reading) return reading;
  await next();
});
app.all('/api/*', (c) => c.json({ error: 'Private application routes are not enabled.' }, 503));
app.get('*', (c) =>
  c.env.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : c.text('Reflection local foundation'),
);

export default {
  fetch: app.fetch,
  async scheduled(_controller, env, _ctx) {
    if (
      env.RESTORE_MODE === 'offline' ||
      (env.IDENTITY_MODE === 'synthetic-local' &&
        (await env.DB.prepare(
          'SELECT restore_in_progress FROM system_state WHERE id=1',
        ).first<number>('restore_in_progress')))
    )
      return;
    const identity = localIdentity(env);
    await identity?.maintenance();
    if (identity && env.READING_MODE === 'synthetic-local' && env.RECOVERY) {
      const base = new RecordBase(env.DB, identity);
      await new LocalGeneration(base).maintenance();
      await new SessionErasure(base, env.RECOVERY).maintenance();
    }
  },
} satisfies ExportedHandler<Env>;
