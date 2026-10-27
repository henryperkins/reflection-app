import { Hono } from 'hono';
import { identityRoute, localIdentity, type IdentityBindings } from './identity/routes.ts';
import { readingRoute, type ReadingBindings } from './readings/routes.ts';
import { RecordBase } from './readings/base.ts';
import { SessionErasure } from './readings/erasure.ts';
import { generationService, type GenerationFactory } from './readings/runtime.ts';
import { RetentionMaintenance } from './maintenance/retention.ts';
import { maintenanceHealth } from './maintenance/health.ts';

export interface Env extends IdentityBindings, ReadingBindings {
  ASSETS?: Fetcher;
  RESTORE_MODE?: string;
}

/** Protected bootstrap seam. The default export still has no live factory or secrets. */
export function createWorker(factory?: GenerationFactory) {
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
  app.get('/health', (c) =>
    c.json({
      status: 'ok',
      milestone: 1,
      mode: factory && c.env.READING_MODE === 'live-local' ? 'live-local' : 'synthetic-only',
      ...(factory && c.env.READING_MODE === 'live-local' ? { provider: 'openai' } : {}),
    }),
  );
  app.all('/api/v1/*', async (c, next) => {
    if (
      c.env.RESTORE_MODE === 'offline' ||
      (['synthetic-local', 'live-local'].includes(c.env.IDENTITY_MODE ?? '') &&
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
    // Direct service/in-process callers may await completion; Worker requests acknowledge admission.
    let defer: ((work: Promise<void>) => void) | undefined;
    try {
      const ctx = c.executionCtx;
      defer = (work) => ctx.waitUntil(work);
    } catch {
      /* No execution context for direct application calls. */
    }
    const reading = await readingRoute(c.req.raw, c.env, defer, factory);
    if (reading) return reading;
    await next();
  });
  app.all('/api/*', (c) => c.json({ error: 'Private application routes are not enabled.' }, 503));
  app.get('*', (c) =>
    c.env.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : c.text('Reflection local foundation'),
  );

  return {
    fetch: app.fetch,
    async scheduled(_controller, env, _ctx) {
      if (
        env.RESTORE_MODE === 'offline' ||
        (['synthetic-local', 'live-local'].includes(env.IDENTITY_MODE ?? '') &&
          (await env.DB.prepare(
            'SELECT restore_in_progress FROM system_state WHERE id=1',
          ).first<number>('restore_in_progress')))
      )
        return;
      const identity = localIdentity(env);
      try {
        await identity?.maintenance();
        if (
          identity &&
          ['synthetic-local', 'qualified', 'live-local'].includes(env.READING_MODE ?? '') &&
          env.RECOVERY
        ) {
          const base = new RecordBase(env.DB, identity);
          await generationService(base, env.READING_MODE, factory)?.maintenance();
          await new SessionErasure(base, env.RECOVERY).maintenance();
        }
        if (identity) {
          await new RetentionMaintenance(env.DB).run();
          console.info(JSON.stringify(await maintenanceHealth(env.DB)));
        }
      } catch {
        // Never log a caught D1/provider exception, which may embed private query data.
        console.error(JSON.stringify({ event: 'maintenance_failed' }));
        throw new Error('Scheduled maintenance failed');
      }
    },
  } satisfies ExportedHandler<Env>;
}
export default createWorker();
