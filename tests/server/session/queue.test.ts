import { expect, test } from 'vitest';
import { ReviewQueue } from '../../../server/session/queue';
import type { QueueItem } from '../../../shared/types';

const item = (n: number, important = false, threadId = `t${n}`): QueueItem =>
  ({ threadId, n, subject: `s${n}`, important });

test('push orders important first, then older n first', () => {
  const q = new ReviewQueue();
  q.push(item(3));
  q.push(item(1));
  q.push(item(2, true));
  expect(q.list().map((i) => i.n)).toEqual([2, 1, 3]);
});

test('take removes from the middle and the rest keep their order', () => {
  const q = new ReviewQueue([item(1), item(2), item(3)]);
  expect(q.take('t2')?.n).toBe(2);
  expect(q.list().map((i) => i.n)).toEqual([1, 3]);
  expect(q.size).toBe(2);
});

test('take of an unknown threadId returns undefined', () => {
  const q = new ReviewQueue([item(1)]);
  expect(q.take('nope')).toBeUndefined();
  expect(q.size).toBe(1);
});

test('unshift places the item at the very front, ignoring priority', () => {
  const q = new ReviewQueue([item(1), item(2, true)]);
  q.unshift(item(9));
  expect(q.list()[0].n).toBe(9);
  expect(q.list().map((i) => i.n)).toEqual([9, 2, 1]);
});

test('later pushes, even important ones, stay behind an unshifted item', () => {
  const q = new ReviewQueue();
  q.unshift(item(9));
  q.push(item(1, true));
  q.push(item(2));
  expect(q.list().map((i) => i.n)).toEqual([9, 1, 2]);
});

test('the most recent unshift is first when several are unshifted', () => {
  const q = new ReviewQueue();
  q.unshift(item(5));
  q.unshift(item(6));
  expect(q.list().map((i) => i.n)).toEqual([6, 5]);
});

test('shift returns the front item and undefined when empty', () => {
  const q = new ReviewQueue([item(1), item(2, true)]);
  q.unshift(item(9));
  expect(q.shift()?.n).toBe(9);
  expect(q.shift()?.n).toBe(2);
  expect(q.shift()?.n).toBe(1);
  expect(q.shift()).toBeUndefined();
});

test('push of a threadId already queued is a no-op', () => {
  const q = new ReviewQueue([item(1)]);
  q.push(item(1, true, 't1'));
  expect(q.size).toBe(1);
  expect(q.list()).toEqual([item(1)]);
});

test('constructor orders the given items by priority', () => {
  const q = new ReviewQueue([item(3), item(1), item(2, true)]);
  expect(q.list().map((i) => i.n)).toEqual([2, 1, 3]);
});

test('list returns a copy, not the internal array', () => {
  const q = new ReviewQueue([item(1)]);
  q.list().pop();
  expect(q.size).toBe(1);
});
