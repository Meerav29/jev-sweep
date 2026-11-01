// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { Setup } from '../../web/screens/Setup';
import { Home } from '../../web/screens/Home';
import { mergeFolders } from '../../web/screens/Folders';
import { DEFAULT_SETTINGS } from '../../shared/types';
import type { SessionSummary, SetupStatus } from '../../shared/types';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const status = (o: Partial<SetupStatus> = {}): SetupStatus => ({
  typesafe: true, anthropic: true, google: true, gmailConnected: true, foldersChosen: true, fake: false, ...o,
});

test('Setup lists the missing items with their fixes and marks the rest done', () => {
  render(<Setup status={status({ typesafe: false, gmailConnected: false, foldersChosen: false })} onFolders={() => {}} onRecheck={() => {}} />);
  const ts = screen.getByTestId('setup-typesafe');
  expect(ts.className).toBe('todo');
  expect(within(ts).getByRole('link', { name: 'How to add it' }).getAttribute('href')).toMatch(/#typesafe$/);
  expect(screen.getByTestId('setup-anthropic').className).toBe('ok');
  expect(screen.getByRole('link', { name: 'Connect Gmail' }).getAttribute('href')).toBe('/api/auth/google');
  expect(screen.getByRole('button', { name: 'Choose folders' })).toHaveProperty('disabled', true);
});

test('Setup shows a sign-in error line when asked', () => {
  render(<Setup status={status({ gmailConnected: false })} authError onFolders={() => {}} onRecheck={() => {}} />);
  expect(screen.getByRole('alert').textContent).toMatch(/sign-in/i);
});

function stubApi(sessions: SessionSummary[]) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const body = url === '/api/sessions' ? sessions : url === '/api/settings' ? DEFAULT_SETTINGS
      : url.endsWith('/resume') ? { batchId: 'b9', status: 'running' } : {};
    return new Response(JSON.stringify(body), { status: 200 });
  }));
}
const summary = (o: Partial<SessionSummary> = {}): SessionSummary => ({
  id: 's1', startedAt: '2026-10-30T10:00:00Z', batches: 1, total: 10, split: { archived: 5, filed: 3, you: 2, important: 1 }, ...o,
});

test('Home shows Resume when a session has an unfinished batch, and resumes that batch', async () => {
  stubApi([summary({ unfinishedBatchId: 'b9', lastBatchId: 'b9' })]);
  const onSession = vi.fn();
  render(<Home onSession={onSession} onReview={() => {}} onPast={() => {}} onFolders={() => {}} />);
  const btn = await screen.findByRole('button', { name: 'Resume unfinished batch' });
  btn.click();
  await waitFor(() => expect(onSession).toHaveBeenCalledWith('b9'));
});

test('Home hides Resume when nothing is unfinished and opens a past session by its last batch', async () => {
  stubApi([summary({ lastBatchId: 'b3' })]);
  const onPast = vi.fn();
  render(<Home onSession={() => {}} onReview={() => {}} onPast={onPast} onFolders={() => {}} />);
  const row = await screen.findByText('10 emails');
  expect(screen.queryByRole('button', { name: 'Resume unfinished batch' })).toBeNull();
  row.click();
  await waitFor(() => expect(onPast).toHaveBeenCalledWith('b3'));
});

test('Home saves the batch size through PUT /api/settings with a JSON body', async () => {
  stubApi([]);
  render(<Home onSession={() => {}} onReview={() => {}} onPast={() => {}} onFolders={() => {}} />);
  const btn = await screen.findByRole('button', { name: '30' });
  await waitFor(() => expect(btn).toHaveProperty('disabled', false));
  btn.click();
  const put = await waitFor(() => {
    const call = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[1]?.method === 'PUT');
    expect(call).toBeTruthy();
    return call!;
  });
  expect(put[0]).toBe('/api/settings');
  expect(put[1].headers).toEqual({ 'Content-Type': 'application/json' });
  expect(JSON.parse(put[1].body)).toEqual({ batchSize: 30 });
});

test('mergeFolders defaults every label on at first visit, and keeps saved choices after', () => {
  expect(mergeFolders(['A', 'B'], [])).toEqual([{ name: 'A', enabled: true }, { name: 'B', enabled: true }]);
  expect(mergeFolders(['A', 'B', 'C'], [{ name: 'A', enabled: true, description: 'x' }, { name: 'B', enabled: false }, { name: 'Gone', enabled: true }]))
    .toEqual([{ name: 'A', enabled: true, description: 'x' }, { name: 'B', enabled: false }, { name: 'C', enabled: false }]);
});
