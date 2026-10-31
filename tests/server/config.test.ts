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
