import type { gmail_v1 } from 'googleapis';
import { expect, test, vi } from 'vitest';
import { google } from 'googleapis';
import { GmailProvider, RETRY_CONFIG } from '../../../server/mail/gmail';

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
test('listCandidates pages the list, walks oldest first, skips same-message exclusions', async () => {
  // Gmail lists newest first: t5 newest ... t1 oldest
  const ids = ['t5', 't4', 't3', 't2', 't1'];
  const threads = Object.fromEntries(ids.map(id => [id, thread(id, String(Number(id.slice(1)) * 1000))]));
  const api = mockGmail({ ids, threads });
  const g = new GmailProvider(api.auth, api.client);
  const b = await g.listCandidates('in:inbox', 2, new Map([['t1', 't1b']]));
  expect(api.threadsList).toHaveBeenCalledTimes(2);
  expect(api.threadsList).toHaveBeenCalledWith(expect.objectContaining({ q: 'in:inbox', maxResults: 500 }));
  expect(b).toEqual([{ threadId: 't2', latestMessageId: 't2b' }, { threadId: 't3', latestMessageId: 't3b' }]);
  // message ids only: the excluded thread (and every other) is never fetched in full
  expect(api.threadsGet).toHaveBeenCalledWith(expect.objectContaining({ id: 't1', format: 'minimal' }));
  expect(api.threadsGet.mock.calls.every(c => (c[0] as { id: string; format?: string }).format === 'minimal')).toBe(true);
  // a changed latest message is not excluded
  const again = await g.listCandidates('', 1, new Map([['t1', 'older-id']]));
  expect(again).toEqual([{ threadId: 't1', latestMessageId: 't1b' }]);
});
test('listCandidates keeps at most 8 gets in flight, keeps oldest-first order, and stops near n', async () => {
  const ids = Array.from({ length: 30 }, (_, i) => `t${30 - i}`); // newest first
  const threads = Object.fromEntries(ids.map(id => [id, thread(id, String(Number(id.slice(1)) * 1000))]));
  const api = mockGmail({ ids, threads });
  let inFlight = 0; let max = 0;
  api.threadsGet.mockImplementation(async (req: { id: string }) => {
    inFlight++; max = Math.max(max, inFlight);
    // later threads answer first, so order must come from the walk, not from arrival
    for (let i = 0; i < 40 - Number(req.id.slice(1)); i++) await new Promise(r => setImmediate(r));
    inFlight--;
    return { data: threads[req.id] };
  });
  const g = new GmailProvider(api.auth, api.client);
  const b = await g.listCandidates('', 20, new Map([['t3', 't3b']]));
  expect(max).toBe(8);
  expect(b.map(c => c.threadId)).toEqual(Array.from({ length: 21 }, (_, i) => `t${i + 1}`).filter(t => t !== 't3'));
  expect(api.threadsGet.mock.calls.length).toBeLessThan(30);
});
test('concurrent getThread calls share one labels.list; creating a label refreshes it', async () => {
  const api = mockGmail({ threads: { a: thread('a', '1000'), b: thread('b', '2000') } });
  const listLabels = api.client.users.labels.list as unknown as ReturnType<typeof vi.fn>;
  const g = new GmailProvider(api.auth, api.client);
  await Promise.all([g.getThread('a'), g.getThread('b'), g.getThread('a')]);
  expect(listLabels).toHaveBeenCalledTimes(1);
  await g.addLabel('a', 'Fresh'); // lists once to look for it, then creates it
  const before = listLabels.mock.calls.length;
  await g.getThread('a');
  expect(listLabels.mock.calls.length).toBe(before + 1);
});
test('provider never touches trash, delete or spam', () => {
  const src = Object.getOwnPropertyNames(GmailProvider.prototype).join(',');
  expect(src).not.toMatch(/trash|delete|spam/i);
});

test('client is built with retries for rate limits, 5xx and POST writes', () => {
  expect(RETRY_CONFIG).toEqual({ retry: 4, statusCodesToRetry: [[429, 429], [500, 599]], httpMethodsToRetry: ['GET', 'HEAD', 'PUT', 'OPTIONS', 'DELETE', 'POST'] });
  const spy = vi.spyOn(google, 'gmail').mockReturnValue({} as never);
  new GmailProvider({} as never);
  expect(spy).toHaveBeenCalledWith(expect.objectContaining({ version: 'v1', retryConfig: RETRY_CONFIG }));
  spy.mockRestore();
});
test('addLabel recovers from a 409 on create by re-listing labels', async () => {
  const api = mockGmail();
  (api.client.users.labels.list as unknown as ReturnType<typeof vi.fn>)
    .mockResolvedValueOnce({ data: { labels: [] } })
    .mockResolvedValueOnce({ data: { labels: [{ id: 'L9', name: 'Work/Acme', type: 'user' }] } });
  api.labelsCreate.mockRejectedValueOnce(Object.assign(new Error('exists'), { status: 409 }));
  await new GmailProvider(api.auth, api.client).addLabel('t1', 'work/acme');
  expect(api.threadsModify).toHaveBeenCalledWith(expect.objectContaining({ id: 't1', requestBody: { addLabelIds: ['L9'] } }));
});
test('getThread returns null on a 404 (status, code or response.status)', async () => {
  for (const err of [{ status: 404 }, { code: 404 }, { response: { status: 404 } }]) {
    const api = mockGmail();
    api.threadsGet.mockRejectedValueOnce(Object.assign(new Error('nf'), err));
    expect(await new GmailProvider(api.auth, api.client).getThread('x')).toBeNull();
  }
  const api = mockGmail();
  api.threadsGet.mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500 }));
  await expect(new GmailProvider(api.auth, api.client).getThread('x')).rejects.toThrow('boom');
});
test('labels and unread are the union across the thread; other fields come from the latest message', async () => {
  const t = thread('t9', '5000', ['SENT']);
  const api = mockGmail({ threads: { t9: t } });
  const e = await new GmailProvider(api.auth, api.client).getThread('t9');
  expect(e).toMatchObject({ subject: 'Hi t9', latestMessageId: 't9b', unread: false });
  // earlier message has INBOX only; add UNREAD to it
  (t.messages[0] as { labelIds: string[] }).labelIds = ['INBOX', 'UNREAD'];
  const e2 = await new GmailProvider(api.auth, api.client).getThread('t9');
  expect(e2!.labels).toEqual(expect.arrayContaining(['INBOX', 'UNREAD', 'SENT']));
  expect(e2!.unread).toBe(true);
  expect(e2!.subject).toBe('Hi t9');
});

const SYS = [{ id: 'INBOX', name: 'INBOX', type: 'system' }, { id: 'SPAM', name: 'SPAM', type: 'system' }, { id: 'TRASH', name: 'TRASH', type: 'system' }];
test('addLabel never resolves a folder name to a system label', async () => {
  for (const name of ['spam', 'Trash', 'INBOX']) {
    const api = mockGmail({ labels: SYS });
    await new GmailProvider(api.auth, api.client).addLabel('t', name);
    expect(api.labelsCreate).toHaveBeenCalledTimes(1);
    expect(api.threadsModify).toHaveBeenCalledWith(expect.objectContaining({ requestBody: { addLabelIds: ['NEW'] } }));
  }
});
test('addLabel throws if create hands back a system label, and 409 fallback ignores system labels', async () => {
  const api = mockGmail({ labels: SYS });
  api.labelsCreate.mockResolvedValueOnce({ data: { id: 'SPAM', name: 'spam' } });
  await expect(new GmailProvider(api.auth, api.client).addLabel('t', 'spam')).rejects.toThrow(/system label/);
  expect(api.threadsModify).not.toHaveBeenCalled();
  const api2 = mockGmail({ labels: SYS });
  api2.labelsCreate.mockRejectedValueOnce(Object.assign(new Error('exists'), { status: 409 }));
  await expect(new GmailProvider(api2.auth, api2.client).addLabel('t', 'trash')).rejects.toThrow('exists');
  expect(api2.threadsModify).not.toHaveBeenCalled();
});
test('modify refuses SPAM or TRASH in addLabelIds', async () => {
  const api = mockGmail();
  const g = new GmailProvider(api.auth, api.client) as unknown as { modify(id: string, b: object): Promise<void> };
  await expect(g.modify('t', { addLabelIds: ['TRASH'] })).rejects.toThrow();
  expect(api.threadsModify).not.toHaveBeenCalled();
});
test('listCandidates skips a thread that 404s or has no messages', async () => {
  const ids = ['t4', 't3', 't2', 't1'];
  const threads: Record<string, unknown> = Object.fromEntries(ids.map(id => [id, thread(id, String(Number(id.slice(1)) * 1000))]));
  threads.t2 = { id: 't2', messages: [] };
  const api = mockGmail({ ids, threads });
  api.threadsGet.mockRejectedValueOnce(Object.assign(new Error('gone'), { status: 404 })); // t1 is walked first
  const b = await new GmailProvider(api.auth, api.client).listCandidates('', 2, new Map());
  expect(b.map(c => c.threadId)).toEqual(['t3', 't4']);
  const api2 = mockGmail({ ids, threads });
  api2.threadsGet.mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500 }));
  await expect(new GmailProvider(api2.auth, api2.client).listCandidates('', 2, new Map())).rejects.toThrow('boom');
});
