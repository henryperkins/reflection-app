import { Hono } from 'hono';

export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
}

const app = new Hono<{ Bindings: Env }>();
app.get('/health', (c) => c.json({ status: 'ok', milestone: 1, mode: 'synthetic-only' }));
app.all('/api/*', (c) => c.json({ error: 'Private application routes are not enabled.' }, 503));
app.get('*', (c) => c.env.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : c.text('Reflection local foundation'));

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;
