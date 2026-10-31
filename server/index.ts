import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { loadConfig } from './config';
import { createApp } from './app';
import { Repo } from './db/repo';
import { EventHub } from './events';
import { oauthRoutes } from './mail/oauth';
import { fakeServices, realServices } from './services';

if (existsSync('.env')) process.loadEnvFile('.env');

const config = loadConfig(process.env);
const hub = new EventHub((e) => console.error('event subscriber failed:', e));
const tokenPath = join(config.dataDir, 'google-token.json');

/** Fake mode answers each email after this long, so a batch plays out live instead of finishing instantly. */
const FAKE_JEV_DELAY_MS = 250;

const repo = new Repo(join(config.dataDir, config.fake ? 'fake.db' : 'jev-sweep.db'));
const services = config.fake
  ? fakeServices({
    repo, hub, concurrency: config.concurrency, cardTextTimeoutMs: config.cardTextTimeoutMs,
    fixture: JSON.parse(readFileSync(new URL('../fixtures/fake-inbox.json', import.meta.url), 'utf8')),
    now: new Date(), jevDelayMs: FAKE_JEV_DELAY_MS,
  })
  : realServices({ repo, hub, config, tokenPath });

const app = createApp({ repo, hub, services, port: config.port, oauth: oauthRoutes(config, tokenPath) });

// Loopback only: this process holds a Gmail token.
serve({ fetch: app.fetch, port: config.port, hostname: '127.0.0.1' }, (info) => {
  console.log(`jev-sweep server listening on http://localhost:${info.port}${config.fake ? ' (fake mode)' : ''}`);
});
