import { Hono } from 'hono';

/** Dependencies injected into the app; later tasks add fields. */
export type AppDeps = Record<string, never>;

export function createApp(_deps: AppDeps = {}): Hono {
  const app = new Hono();
  app.get('/api/health', (c) => c.json({ ok: true }));
  return app;
}
