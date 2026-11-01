// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Session } from '../../web/screens/Session';
import { DEFAULT_SETTINGS } from '../../shared/types';
import type { BatchView, CardSpec, Decision, SessionEvent } from '../../shared/types';

class FakeES {
  static last: FakeES | null = null;
  listeners: Record<string, ((m: MessageEvent) => void)[]> = {};
  onerror: (() => void) | null = null;
  constructor(public url: string) { FakeES.last = this; }
  addEventListener(t: string, fn: (m: MessageEvent) => void) { (this.listeners[t] ??= []).push(fn); }
  close() {}
  emit(e: SessionEvent) {
    act(() => { for (const fn of this.listeners[e.type] ?? []) fn(new MessageEvent(e.type, { data: JSON.stringify(e) })); });
  }
}

let calls: { url: string; method: string; body?: unknown }[] = [];
beforeEach(() => {
  calls = [];
  vi.stubGlobal('EventSource', FakeES);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const body = url === '/api/labels' ? ['Travel', 'finance'] : url === '/api/settings'
      ? { ...DEFAULT_SETTINGS, folders: [{ name: 'Finance', enabled: true }, { name: 'Work', enabled: true }, { name: 'Old', enabled: false }] }
      : { ok: true };
    return new Response(JSON.stringify(body), { status: 200 });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); FakeES.last = null; });

const dec = (threadId: string, n: number, dest: Decision['dest'], o: Partial<Decision> = {}): Decision => ({
  threadId, n, subject: `subject ${n}`, fromName: 'A', dest, who: 'jev', important: false, star: false, opened: false,
  status: 'proposed', ...o,
});
const card: CardSpec = {
  kind: 'filing', threadId: 'c', n: 4, fromName: 'Chase', fromAddress: 'c@x.com', subject: 'Statement', body: 'b',
  options: [{ dest: 'label:Travel', label: 'Travel', p: 0.6 }], suggestKeep: false, gmailUrl: 'u',
};
const view = (o: Partial<BatchView> = {}): BatchView => ({
  sessionId: 's', batchId: 'b1', batchNo: 2, total: 10, read: 5, fetched: 10, status: 'running', paused: false, dryRun: false,
  decisions: [dec('a', 1, 'archive'), dec('f', 2, 'label:Travel'), dec('y', 3, 'keep', { who: 'you', important: true })],
  queue: [{ threadId: 'q', n: 5, subject: 'Lease renewal', important: true }],
  current: card, ...o,
});

function mount(onReviewing = vi.fn()) {
  render(<Session batchId="b1" onBack={() => {}} onReviewing={onReviewing} />);
  return onReviewing;
}

test('the header shows progress, counts and a labelled ring', async () => {
  mount();
  FakeES.last!.emit({ type: 'snapshot', view: view() });
  expect(screen.getByText('Batch 2')).toBeTruthy();
  expect(screen.getByText('3 of 10 sorted · Jev has read 5')).toBeTruthy();
  expect(screen.getByRole('img', { name: '3 of 10 sorted: 1 archived, 1 filed, 1 kept' })).toBeTruthy();
  const counts = screen.getByTestId('counts');
  expect(counts.textContent).toBe('Archived 1Filed 1Kept 1Asked you 1');
  await waitFor(() => expect(calls.some((c) => c.url === '/api/settings')).toBe(true));
});

test('while Gmail is still fetching, the header says how far it has got', async () => {
  mount();
  FakeES.last!.emit({ type: 'snapshot', view: view({ fetched: 3 }) });
  expect(screen.getByText('Fetching from Gmail… 3 of 10')).toBeTruthy();
  FakeES.last!.emit({ type: 'progress', read: 5, fetched: 9, total: 10, paused: false });
  expect(screen.getByText('Fetching from Gmail… 9 of 10')).toBeTruthy();
  FakeES.last!.emit({ type: 'progress', read: 5, fetched: 10, total: 10, paused: false });
  expect(screen.queryByText(/Fetching from Gmail/)).toBeNull();
  expect(screen.getByText('3 of 10 sorted · Jev has read 5')).toBeTruthy();
  await waitFor(() => expect(calls.some((c) => c.url === '/api/settings')).toBe(true));
});

test('the ticker lists newest first, marks waiting rows, and shows your answers', async () => {
  mount();
  FakeES.last!.emit({ type: 'snapshot', view: view() });
  const rows = within(screen.getByRole('list', { name: "Jev's decisions" })).getAllByRole('listitem');
  expect(rows.map((r) => r.textContent)).toEqual([
    'Lease renewalWaiting for you', 'StatementWaiting for you', 'subject 3you → Inbox', 'subject 2Travel', 'subject 1Archived',
  ]);
  expect(rows[0].className).toContain('ask');
  expect(rows[2].className).toContain('red');
  expect(screen.getByRole('list', { name: "Jev's decisions" }).getAttribute('aria-live')).toBeNull();
  await waitFor(() => expect(calls.some((c) => c.url === '/api/settings')).toBe(true));
});

test('the queue strip counts waiting emails and a chip jumps to its email', async () => {
  mount();
  FakeES.last!.emit({ type: 'snapshot', view: view() });
  expect(screen.getByText(/Waiting for you ·/).textContent).toBe('Waiting for you · 1');
  fireEvent.click(screen.getByRole('button', { name: '#5 Lease renewal' }));
  await waitFor(() => expect(calls).toContainEqual({ url: '/api/batches/b1/jump', method: 'POST', body: { threadId: 'q' } }));
});

test('the live board puts Archived first and Inbox last', async () => {
  mount();
  FakeES.last!.emit({ type: 'snapshot', view: view() });
  const cols = screen.getAllByTestId('board-col').map((c) => c.getAttribute('data-dest'));
  expect(cols).toEqual(['archive', 'label:Travel', 'keep']);
  await waitFor(() => expect(calls.some((c) => c.url === '/api/settings')).toBe(true));
});

test('"Other folder" lists labels plus enabled settings folders, deduped without regard to case', async () => {
  mount();
  FakeES.last!.emit({ type: 'snapshot', view: view() });
  const box = screen.getByRole('combobox', { name: 'Other folder' });
  await waitFor(() => {
    fireEvent.focus(box);
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Travel', 'finance', 'Work']);
  });
});

test('choosing resolves the current card on the server', async () => {
  mount();
  FakeES.last!.emit({ type: 'snapshot', view: view() });
  fireEvent.click(screen.getByRole('button', { name: 'Keep in inbox' }));
  await waitFor(() => expect(calls).toContainEqual({ url: '/api/batches/b1/resolve', method: 'POST', body: { threadId: 'c', dest: 'keep' } }));
});

test('with no card, says Jev is still sorting while it reads', async () => {
  mount();
  FakeES.last!.emit({ type: 'snapshot', view: view({ current: null, queue: [] }) });
  expect(screen.getByText('Nothing needs you right now. Jev is still sorting…')).toBeTruthy();
  expect(screen.queryByText(/Waiting for you ·/)).toBeNull();
  await waitFor(() => expect(calls.some((c) => c.url === '/api/settings')).toBe(true));
});

test('Pause and Resume call the server', async () => {
  mount();
  FakeES.last!.emit({ type: 'snapshot', view: view() });
  fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
  await waitFor(() => expect(calls.some((c) => c.url === '/api/batches/b1/pause')).toBe(true));
  FakeES.last!.emit({ type: 'progress', read: 5, fetched: 10, total: 10, paused: true });
  fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
  await waitFor(() => expect(calls.some((c) => c.url === '/api/batches/b1/continue')).toBe(true));
});

test('reaching reviewing hands the batch to the board', async () => {
  const onReviewing = mount();
  FakeES.last!.emit({ type: 'snapshot', view: view() });
  expect(onReviewing).not.toHaveBeenCalled();
  FakeES.last!.emit({ type: 'status', status: 'reviewing' });
  expect(onReviewing).toHaveBeenCalledWith('b1');
  await waitFor(() => expect(calls.some((c) => c.url === '/api/settings')).toBe(true));
});
