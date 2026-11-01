import { expect, test } from 'vitest';
import { reduceBatch } from '../../web/useBatch';
import type { BatchView, CardSpec, Decision } from '../../shared/types';

const card = (threadId: string): CardSpec => ({
  kind: 'filing', threadId, n: 1, fromName: 'A', fromAddress: 'a@x.com', subject: 's', body: 'b',
  options: [], suggestKeep: false, gmailUrl: 'u',
});
const dec = (threadId: string, dest: Decision['dest'], extra: Partial<Decision> = {}): Decision => ({
  threadId, n: 1, subject: 's', fromName: 'A', dest, who: 'jev', important: false, star: false, opened: false,
  status: 'proposed', ...extra,
});
const view = (extra: Partial<BatchView> = {}): BatchView => ({
  sessionId: 's', batchId: 'b', batchNo: 1, total: 10, read: 0, fetched: 10, status: 'running', paused: false, dryRun: false,
  decisions: [], queue: [], current: null, ...extra,
});

test('snapshot returns the snapshot view, whatever came before', () => {
  const v = view({ read: 4 });
  expect(reduceBatch(null, { type: 'snapshot', view: v })).toEqual(v);
  expect(reduceBatch(view({ read: 1 }), { type: 'snapshot', view: v })).toEqual(v);
});

test('events before a snapshot are ignored', () => {
  expect(reduceBatch(null, { type: 'status', status: 'reviewing' })).toBeNull();
});

test('decided replaces an existing decision by threadId instead of duplicating', () => {
  const v = view({ decisions: [dec('t1', 'archive'), dec('t2', 'keep')] });
  const next = reduceBatch(v, { type: 'decided', decision: dec('t1', 'label:Work', { who: 'you' }) })!;
  expect(next.decisions).toHaveLength(2);
  expect(next.decisions.find((d) => d.threadId === 't1')).toMatchObject({ dest: 'label:Work', who: 'you' });
  const added = reduceBatch(next, { type: 'decided', decision: dec('t3', 'archive') })!;
  expect(added.decisions.map((d) => d.threadId)).toEqual(['t1', 't2', 't3']);
});

test('queued upserts into the queue', () => {
  const item = { threadId: 'q1', n: 2, subject: 'x', important: false };
  const v = reduceBatch(view(), { type: 'queued', item })!;
  expect(v.queue).toEqual([item]);
  expect(reduceBatch(v, { type: 'queued', item: { ...item, important: true } })!.queue).toEqual([{ ...item, important: true }]);
});

test('current removes its thread from the queue', () => {
  const v = view({ queue: [
    { threadId: 'a', n: 1, subject: '', important: false },
    { threadId: 'b', n: 2, subject: '', important: false },
  ] });
  const next = reduceBatch(v, { type: 'current', card: card('a') })!;
  expect(next.current?.threadId).toBe('a');
  expect(next.queue.map((q) => q.threadId)).toEqual(['b']);
  const cleared = reduceBatch(next, { type: 'current', card: null })!;
  expect(cleared.current).toBeNull();
  expect(cleared.queue.map((q) => q.threadId)).toEqual(['b']);
});

test('card_text patches the current card only when the thread matches', () => {
  const v = view({ current: card('a') });
  expect(reduceBatch(v, { type: 'card_text', threadId: 'a', why: 'because', summary: ['x'] })!.current)
    .toMatchObject({ why: 'because', summary: ['x'] });
  const other = reduceBatch(v, { type: 'card_text', threadId: 'zzz', why: 'nope' })!;
  expect(other.current?.why).toBeUndefined();
  expect(reduceBatch(view(), { type: 'card_text', threadId: 'a', why: 'w' })!.current).toBeNull();
});

test('progress and status patch their fields', () => {
  const v = reduceBatch(view({ fetched: 2 }), { type: 'progress', read: 3, fetched: 7, total: 10, paused: true })!;
  expect(v).toMatchObject({ read: 3, fetched: 7, total: 10, paused: true });
  expect(reduceBatch(v, { type: 'status', status: 'reviewing' })!.status).toBe('reviewing');
});

test('does not mutate the previous view', () => {
  const v = view({ decisions: [dec('t1', 'archive')] });
  const frozen = JSON.stringify(v);
  reduceBatch(v, { type: 'decided', decision: dec('t1', 'keep') });
  expect(JSON.stringify(v)).toBe(frozen);
});
