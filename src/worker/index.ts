import { Hono } from 'hono';
import { identityRoute, localIdentity, type IdentityBindings } from './identity/routes.ts';

export interface Env extends IdentityBindings {
  ASSETS?: Fetcher;
}

const app = new Hono<{ Bindings: Env }>();
app.get('/health', (c) => c.json({ status: 'ok', milestone: 1, mode: 'synthetic-only' }));
app.all('/api/v1/*', async (c, next) => {
  const response = await identityRoute(c.req.raw, c.env);
  if (response) return response;
  await next();
});
app.all('/api/*', (c) => c.json({ error: 'Private application routes are not enabled.' }, 503));
app.get('*', (c) =>
  c.env.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : c.text('Reflection local foundation'),
);

export default {
  fetch: app.fetch,
  async scheduled(_controller, env) {
    await localIdentity(env)?.checkpoints.resumePending();
  },
} satisfies ExportedHandler<Env>;
