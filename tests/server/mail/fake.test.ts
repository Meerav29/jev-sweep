import { readFileSync } from 'node:fs';
import { beforeEach, expect, test } from 'vitest';
import { FakeMail, loadFakeInbox, type FakeEmail } from '../../../server/mail/fake';

const now = new Date('2026-10-31T12:00:00Z');
const fixture: FakeEmail[] = loadFakeInbox(JSON.parse(readFileSync('fixtures/fake-inbox.json', 'utf8')), now);
let m: FakeMail;
beforeEach(() => { m = new FakeMail(fixture); });

test('loadFakeInbox converts daysAgo to an ISO date', () => {
  const [r] = loadFakeInbox([{ ...fixture[0], daysAgo: 2 }], now);
  expect(r.date).toBe('2026-10-29T12:00:00.000Z');
});
test('fake listCandidates is oldest first and honours exclusions', async () => {
  const ex = new Map([[fixture[0].threadId, fixture[0].latestMessageId]]);
  const b = await m.listCandidates('', 5, ex);
  expect(b.map(c => c.threadId)).not.toContain(fixture[0].threadId);
  const dates = b.map(c => fixture.find(f => f.threadId === c.threadId)!.date);
  expect([...dates].sort()).toEqual(dates);
  expect(b).toHaveLength(5);
  expect(b[0]).toEqual({ threadId: b[0].threadId, latestMessageId: fixture.find(f => f.threadId === b[0].threadId)!.latestMessageId });
});
test('excluded thread comes back when a new message arrives', async () => {
  const ex = new Map([[fixture[0].threadId, 'old-message-id']]);
  expect((await m.listCandidates('', 50, ex)).map(c => c.threadId)).toContain(fixture[0].threadId);
});
test('archive removes INBOX and logs; unarchive restores', async () => {
  const id = fixture[0].threadId;
  await m.archive(id);
  expect((await m.getThread(id))!.labels).not.toContain('INBOX');
  expect((await m.listCandidates('', 100, new Map())).map(c => c.threadId)).not.toContain(id);
  await m.unarchive(id);
  expect((await m.getThread(id))!.labels).toContain('INBOX');
  expect(m.log).toEqual([`archive:${id}`, `unarchive:${id}`]);
});
test('addLabel, star and markRead update state', async () => {
  const id = fixture[0].threadId;
  await m.addLabel(id, 'Travel'); await m.star(id); await m.markRead(id);
  const t = (await m.getThread(id))!;
  expect(t.labels).toEqual(expect.arrayContaining(['Travel', 'STARRED']));
  expect(t.labels).not.toContain('UNREAD');
  expect(t.unread).toBe(false);
  expect(m.log).toEqual([`label:${id}:Travel`, `star:${id}`, `read:${id}`]);
});
test('getThread returns null for unknown ids; listLabels lists fixture folders', async () => {
  expect(await m.getThread('nope')).toBeNull();
  expect(await m.listLabels()).toEqual(expect.arrayContaining(['Travel', 'Receipts']));
});
test('FakeMail does not mutate the fixture it was given', async () => {
  const before = JSON.stringify(fixture);
  await m.archive(fixture[0].threadId);
  expect(JSON.stringify(fixture)).toBe(before);
});
test('addLabel refuses system label names and logs nothing', async () => {
  for (const name of ['spam', 'Trash', 'INBOX']) await expect(m.addLabel(fixture[0].threadId, name)).rejects.toThrow(/system label/);
  expect(m.log).toEqual([]);
  expect((await m.getThread(fixture[0].threadId))!.labels).not.toContain('spam');
});
