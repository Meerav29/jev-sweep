import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { loadFakeInbox } from '../../../server/mail/fake';
import { decide } from '../../../server/policy/decide';
import { ageDays } from '../../../server/jev/questions';
import { DEFAULT_SETTINGS, NOUL_IDS } from '../../../shared/types';

const now = new Date('2026-10-31T12:00:00Z');
const raw: unknown = JSON.parse(readFileSync('fixtures/fake-inbox.json', 'utf8'));
const items = loadFakeInbox(raw, now);

test('fixture has about 40 items covering every branch', () => {
  expect(items.length).toBeGreaterThanOrEqual(38);
  expect(new Set(items.map(i => i.expect))).toEqual(new Set(['auto_archive', 'proposed', 'queue_filing', 'queue_important']));
});
test('thread ids are unique and dates fall in the last 60 days', () => {
  expect(new Set(items.map(i => i.threadId)).size).toBe(items.length);
  for (const i of items) expect(ageDays(i.date, now)).toBeLessThanOrEqual(60);
});
test('every item has all 11 nouls and decides as expected', () => {
  for (const item of items) {
    for (const id of NOUL_IDS) expect(typeof item.jev.nouls[id], `${item.threadId} ${id}`).toBe('number');
    const o = decide(item.jev, ageDays(item.date, now), DEFAULT_SETTINGS.thresholds);
    const got = o.kind === 'queue' ? (o.card === 'important' ? 'queue_important' : 'queue_filing') : o.kind;
    expect(got, `${item.threadId} ${item.subject}`).toBe(item.expect);
  }
});
test('fixture is generic: example domains only and consistent folders', () => {
  const folders = new Set<string>();
  for (const i of items) {
    expect(i.fromAddress).toMatch(/@([a-z0-9-]+\.)*example\.(com|org)$/);
    for (const k of Object.keys(i.jev.destination.probabilities)) {
      if (k === 'archive' || k === 'keep') continue;
      expect(k.startsWith('label:')).toBe(true);
      folders.add(k.slice(6));
    }
  }
  expect([...folders].sort()).toEqual(['Finance/Bills due', 'Finance/Statements', 'Home', 'Newsletters worth reading', 'Receipts', 'Travel', 'Work']);
});
