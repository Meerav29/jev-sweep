import type { gmail_v1 } from 'googleapis';
import { expect, test, vi } from 'vitest';
import { GmailProvider } from '../../../server/mail/gmail';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
interface Opts { labels?: Array<{ id: string; name: string; type: string }>; ids?: string[]; threads?: Record<string, unknown> }
function mockGmail(o: Opts = {}) {
  const labelsCreate = vi.fn(async (req: { requestBody: { name: string } }) => ({ data: { id: 'NEW', name: req.requestBody.name } }));
  const threadsModify = vi.fn(async (_req: unknown) => ({ data: {} }));
  const threadsGet = vi.fn(async (req: { id: string }) => ({ data: o.threads?.[req.id] }));
  const threadsList = vi.fn(async (req: { pageToken?: string }) => {
    const ids = o.ids ?? [];
    const pages = [ids.slice(0, 2), ids.slice(2)];
    const i = req.pageToken ? 1 : 0;
    return { data: { threads: pages[i].map(id => ({ id })), nextPageToken: i === 0 && pages[1].length ? 'p2' : undefined } };
  });
  const client = { users: { labels: { list: vi.fn(async () => ({ data: { labels: o.labels ?? [] } })), create: labelsCreate }, threads: { list: threadsList, get: threadsGet, modify: threadsModify } } } as unknown as gmail_v1.Gmail;
  return { auth: {} as never, client, labelsCreate, threadsModify, threadsGet, threadsList };
}
const thread = (id: string, date: string, labels: string[] = ['INBOX', 'UNREAD']) => ({
  id, messages: [
    { id: id + 'a', internalDate: '1', labelIds: ['INBOX'], payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'old@example.com' }], body: { data: b64('old') } } },
    { id: id + 'b', internalDate: date, labelIds: labels, payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: '"Ann Lee" <ann@example.com>' }, { name: 'Subject', value: 'Hi ' + id }], body: { data: b64('latest body') } } },
  ],
});

test('gmail addLabel reuses an existing label regardless of case', async () => {
  const api = mockGmail({ labels: [{ id: 'L1', name: 'Finance/Tax', type: 'user' }] });
  await new GmailProvider(api.auth, api.client).addLabel('t1', 'finance/tax');
  expect(api.labelsCreate).not.toHaveBeenCalled();
  expect(api.threadsModify).toHaveBeenCalledWith(expect.objectContaining({ id: 't1', requestBody: { addLabelIds: ['L1'] } }));
});
test('gmail addLabel creates a missing label', async () => {
  const api = mockGmail();
  await new GmailProvider(api.auth, api.client).addLabel('t1', 'Work/Acme');
  expect(api.labelsCreate).toHaveBeenCalledWith(expect.objectContaining({ requestBody: expect.objectContaining({ name: 'Work/Acme' }) }));
  expect(api.threadsModify).toHaveBeenCalledWith(expect.objectContaining({ requestBody: { addLabelIds: ['NEW'] } }));
});
test('gmail listLabels hides system and category labels', async () => {
  const api = mockGmail({ labels: [{ id: 'INBOX', name: 'INBOX', type: 'system' }, { id: 'L', name: 'Travel', type: 'user' }, { id: 'C', name: 'CATEGORY_PROMOTIONS', type: 'user' }, { id: 'B', name: '[Imap]/Sent', type: 'user' }] });
  expect(await new GmailProvider(api.auth, api.client).listLabels()).toEqual(['Travel']);
});
test('archive, unarchive, markRead and star modify labels only', async () => {
  const api = mockGmail(); const g = new GmailProvider(api.auth, api.client);
  await g.archive('t'); await g.unarchive('t'); await g.markRead('t'); await g.star('t');
  expect(api.threadsModify.mock.calls.map(c => (c[0] as { requestBody: unknown }).requestBody)).toEqual([
    { removeLabelIds: ['INBOX'] }, { addLabelIds: ['INBOX'] }, { removeLabelIds: ['UNREAD'] }, { addLabelIds: ['STARRED'] }]);
});
test('fetchBatch pages the list, walks oldest first, skips same-message exclusions', async () => {
  // Gmail lists newest first: t5 newest ... t1 oldest
  const ids = ['t5', 't4', 't3', 't2', 't1'];
  const threads = Object.fromEntries(ids.map(id => [id, thread(id, String(Number(id.slice(1)) * 1000))]));
  const api = mockGmail({ ids, threads });
  const g = new GmailProvider(api.auth, api.client);
  const b = await g.fetchBatch('in:inbox', 2, new Map([['t1', 't1b']]));
  expect(api.threadsList).toHaveBeenCalledTimes(2);
  expect(api.threadsList).toHaveBeenCalledWith(expect.objectContaining({ q: 'in:inbox', maxResults: 500 }));
  expect(b.map(e => e.threadId)).toEqual(['t2', 't3']);
  expect(api.threadsGet).toHaveBeenCalledWith(expect.objectContaining({ format: 'full' }));
  expect(b[0]).toMatchObject({ latestMessageId: 't2b', fromName: 'Ann Lee', fromAddress: 'ann@example.com', subject: 'Hi t2', body: 'latest body', unread: true });
  // a changed latest message is not excluded
  const again = await g.fetchBatch('', 1, new Map([['t1', 'older-id']]));
  expect(again[0].threadId).toBe('t1');
});
test('provider never touches trash, delete or spam', () => {
  const src = Object.getOwnPropertyNames(GmailProvider.prototype).join(',');
  expect(src).not.toMatch(/trash|delete|spam/i);
});
