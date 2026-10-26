import { Hono } from 'hono';
import { identityRoute, localIdentity, type IdentityBindings } from './identity/routes.ts';
import { readingRoute, type ReadingBindings } from './readings/routes.ts';

export interface Env extends IdentityBindings, ReadingBindings {
  ASSETS?: Fetcher;
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
    await localIdentity(env)?.maintenance();
  },
} satisfies ExportedHandler<Env>;
