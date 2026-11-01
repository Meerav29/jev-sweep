import { expect, test } from 'vitest';
import { loadConfig } from '../../server/config';
import { DEFAULT_SETTINGS } from '../../shared/types';

test('defaults', () => {
  const c = loadConfig({});
  expect(c).toMatchObject({ jevModel: 'jev-1.14.0', claudeModel: 'claude-haiku-5-5', port: 8787, fake: false, concurrency: 6, cardTextTimeoutMs: 4000 });
});
test('fake mode + keys from env', () => {
  const c = loadConfig({ JEV_SWEEP_FAKE: '1', TYPESAFE_API_KEY: 'k' });
  expect(c.fake).toBe(true); expect(c.keys.typesafe).toBe('k');
});
test('default settings', () => {
  expect(DEFAULT_SETTINGS).toMatchObject({ query: 'in:inbox is:unread -category:promotions -category:social', batchSize: 20, dryRun: false,
    thresholds: { guardNoul: 0.5, importantQueue: 0.7, needsReplyQueue: 0.7, autoArchiveConfidence: 0.85, proposeConfidence: 0.6, recentDays: 7 } });
});
test('webOrigin defaults to the Vite port and trims a trailing slash', () => {
  expect(loadConfig({}).webOrigin).toBe('http://localhost:5173');
  expect(loadConfig({ WEB_ORIGIN: 'http://localhost:3000/' }).webOrigin).toBe('http://localhost:3000');
});

test('the server port comes from JEV_SWEEP_PORT, never the generic PORT', () => {
  expect(loadConfig({ JEV_SWEEP_PORT: '9001' }).port).toBe(9001);
  // Tools set PORT for the web dev server; reading it made the API collide with Vite.
  expect(loadConfig({ PORT: '5173' }).port).toBe(8787);
  expect(loadConfig({ JEV_SWEEP_PORT: '9001', PORT: '5173' }).port).toBe(9001);
});

test('a JEV_SWEEP_PORT that is not a valid port falls back to 8787', () => {
  for (const v of ['', 'abc', '80x', '1.5', '0', '-1', '65536']) {
    expect(loadConfig({ JEV_SWEEP_PORT: v }).port).toBe(8787);
  }
  expect(loadConfig({ JEV_SWEEP_PORT: ' 65535 ' }).port).toBe(65535);
});
