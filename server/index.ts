import { existsSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { loadConfig } from './config';
import { createApp } from './app';

if (existsSync('.env')) process.loadEnvFile('.env');

const config = loadConfig(process.env);
const app = createApp();

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`jev-sweep server listening on http://localhost:${info.port}${config.fake ? ' (fake mode)' : ''}`);
});
