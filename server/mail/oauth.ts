import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Hono } from 'hono';
import { OAuth2Client, type Credentials } from 'google-auth-library';
import type { Config } from '../config';

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
const MAX_PENDING_STATES = 20;

const redirectUri = (config: Config): string => `http://localhost:${config.port}/api/auth/google/callback`;

function makeClient(config: Config): OAuth2Client | null {
  const { googleId, googleSecret } = config.keys;
  if (!googleId || !googleSecret) return null;
  return new OAuth2Client(googleId, googleSecret, redirectUri(config));
}

function readTokens(tokenPath: string): Credentials | null {
  if (!existsSync(tokenPath)) return null;
  try {
    return JSON.parse(readFileSync(tokenPath, 'utf8')) as Credentials;
  } catch {
    return null;
  }
}

function writeTokens(tokenPath: string, tokens: Credentials): void {
  mkdirSync(dirname(tokenPath), { recursive: true });
  writeFileSync(tokenPath, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  try { chmodSync(tokenPath, 0o600); } catch { /* not supported on this platform */ }
}

/** Saves refreshed tokens on top of what is already on disk (a refresh omits the refresh_token). */
function persistRefreshes(client: OAuth2Client, tokenPath: string): void {
  client.on('tokens', (tokens: Credentials) => {
    writeTokens(tokenPath, { ...(readTokens(tokenPath) ?? {}), ...tokens });
  });
}

/** `client` is injectable for tests. */
export function oauthRoutes(config: Config, tokenPath: string, client: OAuth2Client | null = makeClient(config)): Hono {
  const app = new Hono();
  const pendingStates = new Set<string>();
  if (client) persistRefreshes(client, tokenPath);

  app.get('/api/auth/google', c => {
    if (!client) return c.json({ error: 'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first.' }, 400);
    const state = randomBytes(24).toString('base64url');
    if (pendingStates.size >= MAX_PENDING_STATES) pendingStates.delete(pendingStates.values().next().value as string);
    pendingStates.add(state);
    return c.redirect(client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: [GMAIL_SCOPE], state }));
  });

  app.get('/api/auth/google/callback', async c => {
    if (c.req.query('error')) return c.redirect(`${config.webOrigin}/?auth=error`);
    const state = c.req.query('state');
    if (!state || !pendingStates.delete(state)) return c.json({ error: 'Invalid or missing state.' }, 400);
    const code = c.req.query('code');
    if (!client || !code) return c.json({ error: 'Missing authorization code.' }, 400);
    try {
      const { tokens } = await client.getToken(code);
      client.setCredentials(tokens);
      writeTokens(tokenPath, tokens);
    } catch {
      return c.redirect(`${config.webOrigin}/?auth=error`);
    }
    return c.redirect(`${config.webOrigin}/`);
  });

  return app;
}

/** Null when the Google keys or the stored token are missing. */
export function loadAuth(config: Config, tokenPath: string): OAuth2Client | null {
  const client = makeClient(config);
  const tokens = readTokens(tokenPath);
  if (!client || !tokens) return null;
  client.setCredentials(tokens);
  persistRefreshes(client, tokenPath);
  return client;
}
