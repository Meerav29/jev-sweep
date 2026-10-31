import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { expect, test, vi } from 'vitest';
import { loadConfig } from '../../../server/config';
import { loadAuth, oauthRoutes } from '../../../server/mail/oauth';

const cfg = loadConfig({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'sec', PORT: '9999' });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'jev-oauth-'));
  const tokenPath = join(dir, 'sub', 'google-token.json');
  const client = Object.assign(new EventEmitter(), {
    generateAuthUrl: vi.fn((o: { state: string }) => `https://accounts.example.com/auth?state=${o.state}`),
    getToken: vi.fn(async (_code: string) => ({ tokens: { access_token: 'a', refresh_token: 'r' } })),
    setCredentials: vi.fn(),
  });
  const app = oauthRoutes(cfg, tokenPath, client as never);
  return { app, client, tokenPath };
}
const stateOf = (loc: string | null) => new URL(loc!).searchParams.get('state')!;

test('start redirects to Google with scope, offline access, consent prompt and a state', async () => {
  const { app, client } = setup();
  const res = await app.request('/api/auth/google');
  expect(res.status).toBe(302);
  expect(stateOf(res.headers.get('location'))).toMatch(/^[A-Za-z0-9_-]{16,}$/);
  expect(client.generateAuthUrl).toHaveBeenCalledWith(expect.objectContaining({ access_type: 'offline', prompt: 'consent', scope: ['https://www.googleapis.com/auth/gmail.modify'] }));
});
test('callback with a missing or wrong state is rejected and writes nothing', async () => {
  const { app, tokenPath, client } = setup();
  await app.request('/api/auth/google');
  expect((await app.request('/api/auth/google/callback?code=c')).status).toBe(400);
  expect((await app.request('/api/auth/google/callback?code=c&state=bad')).status).toBe(400);
  expect(client.getToken).not.toHaveBeenCalled();
  expect(existsSync(tokenPath)).toBe(false);
});
test('callback with a valid state stores the token and redirects home; state is single use', async () => {
  const { app, tokenPath, client } = setup();
  const state = stateOf((await app.request('/api/auth/google')).headers.get('location'));
  const res = await app.request(`/api/auth/google/callback?code=c&state=${state}`);
  expect(res.status).toBe(302);
  expect(res.headers.get('location')).toBe('http://localhost:5173/');
  expect(JSON.parse(readFileSync(tokenPath, 'utf8'))).toEqual({ access_token: 'a', refresh_token: 'r' });
  expect((await app.request(`/api/auth/google/callback?code=c&state=${state}`)).status).toBe(400);
  expect(client.setCredentials).toHaveBeenCalled();
});
test('google error param redirects to the web app with ?auth=error', async () => {
  const { app } = setup();
  const res = await app.request('/api/auth/google/callback?error=access_denied');
  expect(res.status).toBe(302);
  expect(res.headers.get('location')).toBe('http://localhost:5173/?auth=error');
});
test('refreshed tokens are merged into the saved file', async () => {
  const { app, tokenPath, client } = setup();
  const state = stateOf((await app.request('/api/auth/google')).headers.get('location'));
  await app.request(`/api/auth/google/callback?code=c&state=${state}`);
  client.emit('tokens', { access_token: 'a2', expiry_date: 5 });
  expect(JSON.parse(readFileSync(tokenPath, 'utf8'))).toEqual({ access_token: 'a2', refresh_token: 'r', expiry_date: 5 });
});
test('loadAuth returns null without keys or without a token file', () => {
  const { tokenPath } = setup();
  expect(loadAuth(cfg, tokenPath)).toBeNull();
  expect(loadAuth(loadConfig({}), tokenPath)).toBeNull();
});
test('loadAuth returns a client when keys and token exist', async () => {
  const { app, tokenPath } = setup();
  const state = stateOf((await app.request('/api/auth/google')).headers.get('location'));
  await app.request(`/api/auth/google/callback?code=c&state=${state}`);
  expect(loadAuth(cfg, tokenPath)).not.toBeNull();
});
