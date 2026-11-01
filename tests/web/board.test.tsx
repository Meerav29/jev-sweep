// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Board, pendingCount } from '../../web/screens/Board';
import { Home } from '../../web/screens/Home';
import { App } from '../../web/App';
import { DEFAULT_SETTINGS } from '../../shared/types';
import type { BatchView, Decision, SessionEvent, SessionSummary, SetupStatus } from '../../shared/types';

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

type Reply = [number, unknown];
let calls: { url: string; method: string; body?: unknown }[] = [];
let overrides: Record<string, Reply> = {};
const sessions: SessionSummary[] = [{
  id: 's', startedAt: '2026-10-30T10:00:00Z', batches: 2, total: 10, split: { archived: 5, filed: 3, you: 2, important: 1 }, lastBatchId: 'b1',
}];
const setupOk: SetupStatus = { typesafe: true, anthropic: true, google: true, gmailConnected: true, foldersChosen: true, fake: true };

beforeEach(() => {
  calls = [];
  overrides = {};
  vi.stubGlobal('EventSource', FakeES);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const o = overrides[`${method} ${url}`];
    if (o) return new Response(JSON.stringify(o[1]), { status: o[0] });
    const body = url === '/api/labels' ? ['Travel', 'finance']
      : url === '/api/settings' ? { ...DEFAULT_SETTINGS, folders: [{ name: 'Work', enabled: true }] }
      : url === '/api/sessions' ? sessions
      : url === '/api/setup' ? setupOk
      : { ok: true };
    return new Response(JSON.stringify(body), { status: 200 });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); FakeES.last = null; window.history.replaceState(null, '', '/'); });

const dec = (threadId: string, n: number, dest: Decision['dest'], o: Partial<Decision> = {}): Decision => ({
  threadId, n, subject: `subject ${threadId}`, fromName: 'A', dest, who: 'jev', important: false, star: false, opened: false,
  status: 'proposed', ...o,
});
const view = (o: Partial<BatchView> = {}): BatchView => ({
  sessionId: 's', batchId: 'b1', batchNo: 2, total: 4, read: 4, status: 'reviewing', paused: false, dryRun: false,
  decisions: [
    dec('k', 1, 'keep', { who: 'you' }),
    dec('t', 2, 'label:Travel'),
    dec('a', 3, 'archive', { status: 'auto_applied' }),
    dec('i', 4, 'label:Travel', { important: true, who: 'you' }),
  ],
  queue: [], current: null, ...o,
});

function mount(o: { readOnly?: boolean } = {}) {
  const onHome = vi.fn();
  const onSession = vi.fn();
  render(<Board batchId="b1" readOnly={o.readOnly ?? false} onHome={onHome} onSession={onSession} />);
  return { onHome, onSession };
}
const chip = (subject: string) => screen.getByText(subject).closest('.chip') as HTMLElement;
const settle = () => waitFor(() => expect(calls.some((c) => c.url === '/api/settings')).toBe(true));
const posted = (url: string) => calls.filter((c) => c.method === 'POST' && c.url === url);

// ---- brief tests ----

test('chips are grouped into columns, Archived first and Inbox last', async () => {
  mount();
  FakeES.last!.emit({ type: 'snapshot', view: view() });
  const cols = screen.getAllByTestId('board-col');
  expect(cols.map((c) => c.getAttribute('data-dest'))).toEqual(['archive', 'label:Travel', 'keep']);
  expect(within(cols[1]).getAllByText(/^subject /).map((e) => e.textContent)).toEqual(['subject t', 'subject i']);
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe("Batch 2 · where everything's going");
  expect(screen.getByText('Drag a card to change where it goes. Nothing has moved in Gmail yet.')).toBeTruthy();
  const legend = screen.getByTestId('legend');
  expect(legend.textContent).toBe('you decidedimportantJev decided');
  await settle();
});

test('an auto_applied chip is styled done, with a check; a proposed chip is pending', async () => {
  mount();
  FakeES.last!.emit({ type: 'snapshot', view: view() });
  expect(chip('subject a').className).toContain('done');
  expect(chip('subject a').textContent).toContain('✓');
  expect(chip('subject t').className).toContain('pending');
  expect(chip('subject t').className).not.toContain('done');
  expect(chip('subject i').className).toContain('red');
  await settle();
});

test('the pending count excludes auto_applied chips that were not moved', async () => {
  const ds = [
    dec('p', 1, 'keep'),
    dec('a', 2, 'archive', { status: 'auto_applied' }),
    dec('m', 3, 'keep', { status: 'auto_applied', who: 'you' }),
    dec('f', 4, 'archive', { status: 'failed', note: 'apply: boom' }),
    dec('x', 5, 'archive', { status: 'applied' }),
    dec('s', 6, 'archive', { status: 'skipped', note: 'changed in Gmail' }),
  ];
  expect(pendingCount(ds)).toBe(3);
  expect(pendingCount([dec('a', 1, 'archive', { status: 'auto_applied' })])).toBe(0);
  mount();
  FakeES.last!.emit({ type: 'snapshot', view: view() });
  expect(screen.getByRole('button', { name: 'Apply 3 moves' })).toBeTruthy();
  await settle();
});

test('readOnly hides Apply, drag and buttons, and titles the receipt with its date', async () => {
  mount({ readOnly: true });
  FakeES.last!.emit({ type: 'snapshot', view: view({ status: 'applied' }) });
  expect(screen.queryByRole('button', { name: /^Apply/ })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Discard batch' })).toBeNull();
  expect(screen.queryByRole('button', { name: '+ Folder' })).toBeNull();
  expect(chip('subject t').getAttribute('draggable')).not.toBe('true');
  fireEvent.click(chip('subject t'));
  expect(screen.queryByRole('group', { name: 'Move to…' })).toBeNull();
  const date = new Date('2026-10-30T10:00:00Z').toLocaleDateString();
  await waitFor(() => expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(`Batch 2 · ${date}`));
});

test('a failed decision shows "Retry failed", which re-calls apply', async () => {
  mount();
  FakeES.last!.emit({ type: 'snapshot', view: view({
    decisions: [dec('f', 1, 'archive', { status: 'failed', note: 'apply: (archived) Gmail said no' }), dec('x', 2, 'keep', { status: 'applied' })],
  }) });
  expect(chip('subject f').textContent).toContain('Gmail said no');
  expect(chip('subject f').textContent).not.toContain('(archived)');
  fireEvent.click(screen.getByRole('button', { name: 'Retry failed' }));
  await waitFor(() => expect(posted('/api/batches/b1/apply')).toHaveLength(1));
  await settle();
});

test('a skipped chip shows its note', async () => {
  mount();
  FakeES.last!.emit({ type: 'snapshot', view: view({ decisions: [dec('s', 1, 'archive', { status: 'skipped', note: 'changed in Gmail' })] }) });
  expect(chip('subject s').textContent).toContain('changed in Gmail');
  await settle();
});

// ---- moving ----

test('dragging a chip to another column calls move, and the chip then shows as moved', async () => {
  mount();
  FakeES.last!.emit({ type: 'snapshot', view: view() });
  const c = chip('subject t');
  expect(c.getAttribute('draggable')).toBe('true');
  const data: Record<string, string> = {};
  const dataTransfer = { setData: (k: string, v: string) => { data[k] = v; }, getData: (k: string) => data[k] ?? '', effectAllowed: '', dropEffect: '' };
  fireEvent.dragStart(c, { dataTransfer });
  const inbox = screen.getAllByTestId('board-col').find((x) => x.getAttribute('data-dest') === 'keep')!;
  fireEvent.dragOver(inbox, { dataTransfer });
  fireEvent.drop(inbox, { dataTransfer });
  await waitFor(() => expect(posted('/api/batches/b1/move')).toEqual([{ url: '/api/batches/b1/move', method: 'POST', body: { threadId: 't', dest: 'keep' } }]));
  FakeES.last!.emit({ type: 'decided', decision: dec('t', 2, 'keep', { who: 'you' }) });
  await waitFor(() => expect(chip('subject t').className).toContain('moved'));
  expect(chip('subject k').className).not.toContain('moved');
});

test('an auto-archive moved off Archived shows as moved and pending', async () => {
  mount();
  FakeES.last!.emit({ type: 'snapshot', view: view({ decisions: [dec('m', 1, 'keep', { status: 'auto_applied', who: 'you' })] }) });
  expect(chip('subject m').className).toContain('moved');
  expect(chip('subject m').className).not.toContain('done');
  await settle();
});

test('tapping a chip opens "Move to…", and a column button moves it', async () => {
  mount();
  FakeES.last!.emit({ type: 'snapshot', view: view() });
  fireEvent.click(chip('subject t'));
  const group = screen.getByRole('group', { name: 'Move to…' });
  expect(within(group).queryByRole('button', { name: 'Travel' })).toBeNull();
  fireEvent.click(within(group).getByRole('button', { name: 'Inbox' }));
  await waitFor(() => expect(posted('/api/batches/b1/move')).toEqual([{ url: '/api/batches/b1/move', method: 'POST', body: { threadId: 't', dest: 'keep' } }]));
  await waitFor(() => expect(screen.queryByRole('group', { name: 'Move to…' })).toBeNull());
});

test('Escape cancels a tapped selection', async () => {
  mount();
  FakeES.last!.emit({ type: 'snapshot', view: view() });
  fireEvent.click(chip('subject t'));
  expect(screen.getByRole('group', { name: 'Move to…' })).toBeTruthy();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('group', { name: 'Move to…' })).toBeNull();
  expect(posted('/api/batches/b1/move')).toHaveLength(0);
  await settle();
});

test('chips that cannot move are not draggable or selectable', async () => {
  mount();
  FakeES.last!.emit({ type: 'snapshot', view: view({ decisions: [
    dec('x', 1, 'keep', { status: 'applied' }), dec('s', 2, 'keep', { status: 'skipped' }), dec('f', 3, 'keep', { status: 'failed', note: 'apply: x' }),
  ] }) });
  for (const s of ['subject x', 'subject s', 'subject f']) {
    expect(chip(s).getAttribute('draggable')).not.toBe('true');
    fireEvent.click(chip(s));
  }
  expect(screen.queryByRole('group', { name: 'Move to…' })).toBeNull();
  await settle();
});

test('nothing moves while applying', async () => {
  mount();
  FakeES.last!.emit({ type: 'snapshot', view: view({ status: 'applying' }) });
  expect(chip('subject t').getAttribute('draggable')).not.toBe('true');
  await settle();
});

test('the "+ Folder" picker moves a tapped chip into a new folder, and refuses Gmail names', async () => {
  mount();
  FakeES.last!.emit({ type: 'snapshot', view: view() });
  await settle();
  fireEvent.click(chip('subject k'));
  const group = screen.getByRole('group', { name: 'Move to…' });
  fireEvent.click(within(group).getByRole('button', { name: '+ Folder' }));
  const box = within(group).getByRole('combobox', { name: 'Other folder' });
  fireEvent.focus(box);
  await waitFor(() => expect(within(group).getAllByRole('option').map((o) => o.textContent)).toEqual(['Travel', 'finance', 'Work']));
  fireEvent.change(box, { target: { value: 'inbox' } });
  expect(within(group).getByText('That name is reserved by Gmail')).toBeTruthy();
  fireEvent.keyDown(box, { key: 'Enter' });
  expect(posted('/api/batches/b1/move')).toHaveLength(0);
  fireEvent.change(box, { target: { value: 'Receipts' } });
  fireEvent.keyDown(box, { key: 'Enter' });
  await waitFor(() => expect(posted('/api/batches/b1/move')).toEqual([{ url: '/api/batches/b1/move', method: 'POST', body: { threadId: 'k', dest: 'label:Receipts' } }]));
});

test('the "+ Folder" picker on the board adds an empty column to drop into', async () => {
  mount();
  FakeES.last!.emit({ type: 'snapshot', view: view() });
  await settle();
  fireEvent.click(screen.getByRole('button', { name: '+ Folder' }));
  const box = screen.getByRole('combobox', { name: 'Other folder' });
  fireEvent.change(box, { target: { value: 'FINANCE' } });
  fireEvent.keyDown(box, { key: 'Enter' });
  await waitFor(() => expect(screen.getAllByTestId('board-col').map((c) => c.getAttribute('data-dest')))
    .toEqual(['archive', 'label:Travel', 'label:finance', 'keep']));
  expect(posted('/api/batches/b1/move')).toHaveLength(0);
});

// ---- errors ----

test('a move error is shown on the board', async () => {
  overrides['POST /api/batches/b1/move'] = [409, { error: 'batch is applied' }];
  mount();
  FakeES.last!.emit({ type: 'snapshot', view: view() });
  fireEvent.click(chip('subject t'));
  fireEvent.click(within(screen.getByRole('group', { name: 'Move to…' })).getByRole('button', { name: 'Archived' }));
  expect((await screen.findByRole('alert')).textContent).toContain('batch is applied');
  await settle();
});

test('an apply 409 shows "Already applying…"', async () => {
  overrides['POST /api/batches/b1/apply'] = [409, { error: 'apply is already running for this batch' }];
  mount();
  FakeES.last!.emit({ type: 'snapshot', view: view() });
  fireEvent.click(screen.getByRole('button', { name: 'Apply 3 moves' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Already applying…');
  await settle();
});

test('Apply is disabled while the request runs', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const base = fetch as unknown as (u: string, i?: RequestInit) => Promise<Response>;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/batches/b1/apply') { await gate; return new Response('{"applied":3,"skipped":0,"failed":0}', { status: 200 }); }
    return base(url, init);
  }));
  mount();
  FakeES.last!.emit({ type: 'snapshot', view: view() });
  const btn = screen.getByRole('button', { name: 'Apply 3 moves' });
  fireEvent.click(btn);
  await waitFor(() => expect(btn).toHaveProperty('disabled', true));
  await act(async () => { release(); await gate; });
  await settle();
});

test('a next-batch error is shown on the board', async () => {
  overrides['POST /api/sessions/s/batches'] = [409, { error: 'this session already has an open batch' }];
  mount();
  FakeES.last!.emit({ type: 'snapshot', view: view({ status: 'applied' }) });
  fireEvent.click(screen.getByRole('button', { name: 'Next batch' }));
  expect((await screen.findByRole('alert')).textContent).toContain('this session already has an open batch');
  await settle();
});

// ---- apply, next, end, discard ----

test('Apply lists the steps with ✓, then offers Next batch and End session', async () => {
  const { onHome, onSession } = mount();
  overrides['POST /api/sessions/s/batches'] = [200, { batchId: 'b2' }];
  FakeES.last!.emit({ type: 'snapshot', view: view() });
  fireEvent.click(screen.getByRole('button', { name: 'Apply 3 moves' }));
  await waitFor(() => expect(posted('/api/batches/b1/apply')).toHaveLength(1));
  FakeES.last!.emit({ type: 'status', status: 'applying' });
  FakeES.last!.emit({ type: 'apply_step', label: 'Labeling 2 → Travel and archiving', count: 2, done: false });
  FakeES.last!.emit({ type: 'apply_step', label: 'Labeling 2 → Travel and archiving', count: 2, done: true });
  FakeES.last!.emit({ type: 'apply_step', label: 'Leaving 1 in inbox', count: 1, done: false });
  const steps = within(screen.getByTestId('applying')).getAllByRole('listitem').map((l) => l.textContent);
  expect(steps).toEqual(['Labeling 2 → Travel and archiving ✓', 'Leaving 1 in inbox…']);
  FakeES.last!.emit({ type: 'status', status: 'applied' });
  fireEvent.click(screen.getByRole('button', { name: 'End session' }));
  expect(onHome).toHaveBeenCalled();
  expect(calls.filter((c) => c.method === 'POST' && c.url.includes('/api/sessions'))).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Next batch' }));
  await waitFor(() => expect(onSession).toHaveBeenCalledWith('b2'));
  // Started: no second batch from a double click while the screen changes.
  expect(screen.getByRole('button', { name: 'Next batch' })).toHaveProperty('disabled', true);
});

test('Discard asks first, then discards and goes home', async () => {
  const { onHome } = mount();
  FakeES.last!.emit({ type: 'snapshot', view: view() });
  fireEvent.click(screen.getByRole('button', { name: 'Discard batch' }));
  expect(posted('/api/batches/b1/discard')).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Yes, discard' }));
  await waitFor(() => expect(posted('/api/batches/b1/discard')).toHaveLength(1));
  await waitFor(() => expect(onHome).toHaveBeenCalled());
});

test('dry run says so on the header and by the Apply button', async () => {
  mount();
  FakeES.last!.emit({ type: 'snapshot', view: view({ dryRun: true }) });
  expect(screen.getByText("Drag a card to change where it goes. Nothing has moved in Gmail yet. (dry run: Gmail won't be changed)")).toBeTruthy();
  expect(screen.getByTestId('actions').textContent).toContain("dry run: Gmail won't be changed");
  await settle();
});

// ---- polish: empty batches, applied copy, Apply only while reviewing ----

const EMPTY = 'Nothing left to sort. Every unread email matching your query has been handled.';

test('an applied batch with no emails says so and offers only End session', async () => {
  const { onHome } = mount();
  FakeES.last!.emit({ type: 'snapshot', view: view({ status: 'applied', total: 0, read: 0, decisions: [] }) });
  expect(screen.getByText(EMPTY)).toBeTruthy();
  expect(screen.queryAllByTestId('board-col')).toHaveLength(0);
  expect(screen.queryByRole('button', { name: /^Apply/ })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Next batch' })).toBeNull();
  expect(screen.queryByText(/Drag a card/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'End session' }));
  expect(onHome).toHaveBeenCalled();
  await settle();
});

test('the session screen shows the same message for an empty applied batch', async () => {
  const { Session } = await import('../../web/screens/Session');
  render(<Session batchId="b1" onBack={() => {}} onReviewing={() => {}} />);
  FakeES.last!.emit({ type: 'snapshot', view: view({ status: 'applied', total: 0, read: 0, decisions: [] }) });
  expect(screen.getByText(EMPTY)).toBeTruthy();
  await settle();
});

test('once applied, the sub-line says the moves were applied', async () => {
  mount();
  FakeES.last!.emit({ type: 'snapshot', view: view({ status: 'applied' }) });
  expect(screen.getByText('These moves have been applied in Gmail.')).toBeTruthy();
  expect(screen.queryByText(/Drag a card/)).toBeNull();
  await settle();
});

test('once applied in dry run, the sub-line says nothing changed', async () => {
  mount();
  FakeES.last!.emit({ type: 'snapshot', view: view({ status: 'applied', dryRun: true }) });
  expect(screen.getByText('Dry run: nothing was changed in Gmail.')).toBeTruthy();
  expect(screen.queryByText(/Drag a card/)).toBeNull();
  await settle();
});

test('Apply shows only while reviewing', async () => {
  mount();
  FakeES.last!.emit({ type: 'snapshot', view: view({ status: 'running' }) });
  expect(screen.queryByRole('button', { name: /^Apply/ })).toBeNull();
  FakeES.last!.emit({ type: 'status', status: 'applying' });
  expect(screen.queryByRole('button', { name: /^Apply/ })).toBeNull();
  FakeES.last!.emit({ type: 'status', status: 'reviewing' });
  expect(screen.getByRole('button', { name: 'Apply 3 moves' })).toBeTruthy();
  await settle();
});

// ---- dry run is never drawn as done ----

test('a read-only dry-run receipt says so, and its dry-run chips are not done', async () => {
  mount({ readOnly: true });
  FakeES.last!.emit({ type: 'snapshot', view: view({ status: 'applied', dryRun: true, decisions: [
    dec('a', 1, 'archive', { status: 'auto_applied', note: 'dry run' }),
    dec('t', 2, 'label:Travel', { status: 'applied', note: 'dry run' }),
  ] }) });
  expect(screen.getByText('Dry run: nothing was changed in Gmail.')).toBeTruthy();
  for (const s of ['subject a', 'subject t']) {
    const c = chip(s);
    expect(c.className).not.toContain('done');
    expect(c.textContent).not.toContain('✓');
    expect(c.textContent).not.toMatch(/done/);
    expect(within(c).getByText('dry run')).toBeTruthy();
  }
  await waitFor(() => expect(calls.some((c) => c.url === '/api/sessions')).toBe(true));
});

test('on the live board a dry-run chip gets a dry-run tag, while a real applied chip stays done', async () => {
  mount();
  FakeES.last!.emit({ type: 'snapshot', view: view({ status: 'applied', decisions: [
    dec('d', 1, 'archive', { status: 'applied', note: 'dry run' }),
    dec('r', 2, 'archive', { status: 'applied' }),
    dec('a', 3, 'archive', { status: 'auto_applied' }),
  ] }) });
  expect(chip('subject d').className).not.toContain('done');
  expect(chip('subject d').textContent).not.toContain('✓');
  expect(within(chip('subject d')).getByText('dry run')).toBeTruthy();
  for (const s of ['subject r', 'subject a']) {
    expect(chip(s).className).toContain('done');
    expect(chip(s).textContent).toContain('✓');
    expect(within(chip(s)).queryByText('dry run')).toBeNull();
  }
  await settle();
});

// ---- resume (Home) ----

test('Resume asks the server, then opens the Session screen for a running batch', async () => {
  overrides['GET /api/sessions'] = [200, [{ ...sessions[0], unfinishedBatchId: 'b9' }]];
  overrides['POST /api/batches/b9/resume'] = [200, view({ batchId: 'b9', status: 'running' })];
  const onSession = vi.fn();
  const onReview = vi.fn();
  render(<Home onSession={onSession} onReview={onReview} onPast={() => {}} onFolders={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Resume unfinished batch' }));
  await waitFor(() => expect(onSession).toHaveBeenCalledWith('b9'));
  expect(posted('/api/batches/b9/resume')).toHaveLength(1);
  expect(onReview).not.toHaveBeenCalled();
});

test('Resume opens the board for a reviewing batch', async () => {
  overrides['GET /api/sessions'] = [200, [{ ...sessions[0], unfinishedBatchId: 'b9' }]];
  overrides['POST /api/batches/b9/resume'] = [200, view({ batchId: 'b9', status: 'reviewing' })];
  const onSession = vi.fn();
  const onReview = vi.fn();
  render(<Home onSession={onSession} onReview={onReview} onPast={() => {}} onFolders={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Resume unfinished batch' }));
  await waitFor(() => expect(onReview).toHaveBeenCalledWith('b9'));
  expect(onSession).not.toHaveBeenCalled();
});

test('a failed resume shows its error on Home', async () => {
  overrides['GET /api/sessions'] = [200, [{ ...sessions[0], unfinishedBatchId: 'b9' }]];
  overrides['POST /api/batches/b9/resume'] = [503, { error: 'setup incomplete' }];
  render(<Home onSession={() => {}} onReview={() => {}} onPast={() => {}} onFolders={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Resume unfinished batch' }));
  expect((await screen.findByRole('alert')).textContent).toContain('setup incomplete');
});

// ---- App routes ----

test('a malformed hash lands on Home', async () => {
  window.history.replaceState(null, '', '/#/session/%E0%A4%A');
  render(<App />);
  expect(await screen.findByText('Inbox, a batch at a time')).toBeTruthy();
  await waitFor(() => expect(window.location.hash).toBe(''));
  await settle();
});

test('a board hash restores the board after a reload', async () => {
  window.history.replaceState(null, '', '/#/board/b1');
  render(<App />);
  await waitFor(() => expect(FakeES.last?.url).toBe('/api/batches/b1/events'));
  FakeES.last!.emit({ type: 'snapshot', view: view() });
  expect(screen.getByRole('button', { name: 'Apply 3 moves' })).toBeTruthy();
  expect(window.location.hash).toBe('#/board/b1');
  await settle();
});

test('a receipt hash restores the read-only board', async () => {
  window.history.replaceState(null, '', '/#/receipt/b1');
  render(<App />);
  await waitFor(() => expect(FakeES.last?.url).toBe('/api/batches/b1/events'));
  FakeES.last!.emit({ type: 'snapshot', view: view({ status: 'applied' }) });
  expect(screen.queryByRole('button', { name: /^Apply/ })).toBeNull();
  expect(window.location.hash).toBe('#/receipt/b1');
  await waitFor(() => expect(calls.some((c) => c.url === '/api/sessions')).toBe(true));
});

test('incomplete setup wins over a hashed route', async () => {
  overrides['GET /api/setup'] = [200, { ...setupOk, gmailConnected: false }];
  window.history.replaceState(null, '', '/#/session/b1');
  render(<App />);
  expect(await screen.findByRole('link', { name: 'Connect Gmail' })).toBeTruthy();
  expect(FakeES.last).toBeNull();
});
