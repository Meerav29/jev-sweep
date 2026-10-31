import { expect, test } from 'vitest';
import { createApp } from '../../server/app';

test('GET /api/health', async () => {
  const res = await createApp().request('/api/health');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});
