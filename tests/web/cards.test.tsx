// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CARD_REGISTRY, GeneratedCard } from '../../web/cards/registry';
import { FilingCard } from '../../web/cards/FilingCard';
import { ImportantCard } from '../../web/cards/ImportantCard';
import { flyTo } from '../../web/components/flyTo';
import type { CardSpec } from '../../shared/types';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.innerHTML = ''; });

const filing = (o: Partial<CardSpec> = {}): CardSpec => ({
  kind: 'filing', threadId: 't1', n: 3, fromName: 'Chase', fromAddress: 'no-reply@alertsp.chase.com',
  subject: 'Your September statement is ready', body: 'Your new balance is $1,284.19.',
  why: 'Looks routine, but it has a due date.',
  options: [
    { dest: 'label:Finance/Statements', label: 'Finance/Statements', p: 0.71 },
    { dest: 'label:Finance/Bills due', label: 'Finance/Bills due', p: 0.19 },
    { dest: 'archive', label: 'Archive', p: 0.06 },
  ],
  suggestKeep: false, gmailUrl: 'https://mail.google.com/mail/u/0/#all/t1', ...o,
});
const important = (o: Partial<CardSpec> = {}): CardSpec => filing({
  kind: 'important', threadId: 't2', fromName: 'Priya', subject: 'Water shutoff Thursday + lease renewal',
  why: undefined, summary: ['Water off Thu Nov 5, 9am–1pm', 'Lease renewal form due Nov 20'],
  options: [
    { dest: 'label:Home', label: 'Home', p: 0.82 },
    { dest: 'label:Finance/Bills due', label: 'Finance/Bills due', p: 0.09 },
    { dest: 'archive', label: 'Archive', p: 0.03 },
  ],
  ...o,
});
const FOLDERS = ['Finance/Statements', 'Finance/Bills due', 'Home', 'Travel'];
const LOCK_IN = 520;
const key = (k: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(document, { key: k, ...init });
const flush = () => act(() => { vi.advanceTimersByTime(LOCK_IN); });

test('the registry renders FilingCard for filing and ImportantCard for important', () => {
  expect(CARD_REGISTRY.filing).toBe(FilingCard);
  expect(CARD_REGISTRY.important).toBe(ImportantCard);
  const { unmount } = render(<GeneratedCard card={filing()} folders={FOLDERS} onChoose={() => {}} />);
  expect(screen.getByText('Where should this go?')).toBeTruthy();
  unmount();
  render(<GeneratedCard card={important()} folders={FOLDERS} onChoose={() => {}} />);
  expect(screen.getByText(/Read this one/)).toBeTruthy();
});

test('FilingCard shows the three options with their probabilities, and key 1 chooses the top one after the lock-in', () => {
  const onChoose = vi.fn();
  render(<FilingCard card={filing()} folders={FOLDERS} onChoose={onChoose} />);
  expect(screen.getByText('71%')).toBeTruthy();
  expect(screen.getByText('19%')).toBeTruthy();
  expect(screen.getByText('6%')).toBeTruthy();
  expect(screen.getByRole('button', { name: /Finance\/Statements/ })).toBeTruthy();
  key('1');
  expect(onChoose).not.toHaveBeenCalled();
  flush();
  expect(onChoose).toHaveBeenCalledTimes(1);
  expect(onChoose).toHaveBeenCalledWith('label:Finance/Statements', undefined);
});

test('the why line shows when present and is absent when why is undefined', () => {
  const { unmount } = render(<FilingCard card={filing()} folders={FOLDERS} onChoose={() => {}} />);
  expect(screen.getByText(/Why I'm asking:/).parentElement!.textContent).toBe("Why I'm asking: Looks routine, but it has a due date.");
  unmount();
  render(<FilingCard card={filing({ why: undefined })} folders={FOLDERS} onChoose={() => {}} />);
  expect(screen.queryByText(/Why I'm asking/)).toBeNull();
});

test('ImportantCard hides the options until "Got it, file it", and "Keep in inbox, needs reply" keeps with a star', () => {
  const onChoose = vi.fn();
  const { unmount } = render(<ImportantCard card={important()} folders={FOLDERS} onChoose={onChoose} />);
  expect(screen.getByText('The short version')).toBeTruthy();
  expect(screen.getByText('Lease renewal form due Nov 20')).toBeTruthy();
  expect(screen.queryByText('82%')).toBeNull();
  key('1');
  flush();
  expect(onChoose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Got it, file it' }));
  expect(screen.getByText('82%')).toBeTruthy();
  key('1');
  flush();
  expect(onChoose).toHaveBeenCalledWith('label:Home', undefined);
  unmount();

  const onKeep = vi.fn();
  render(<ImportantCard card={important()} folders={FOLDERS} onChoose={onKeep} />);
  fireEvent.click(screen.getByRole('button', { name: 'Keep in inbox, needs reply' }));
  expect(onKeep).toHaveBeenCalledWith('keep', { star: true });
});

test('ImportantCard leaves out "The short version" until a summary arrives', () => {
  render(<ImportantCard card={important({ summary: undefined })} folders={FOLDERS} onChoose={() => {}} />);
  expect(screen.queryByText('The short version')).toBeNull();
});

test('with no options, FilingCard still offers Keep, Archive and the folder combobox', () => {
  const onChoose = vi.fn();
  render(<FilingCard card={filing({ options: [] })} folders={FOLDERS} onChoose={onChoose} />);
  expect(screen.getByRole('combobox', { name: 'Other folder' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
  expect(onChoose).toHaveBeenCalledWith('archive', undefined);
  expect(screen.getByRole('button', { name: 'Keep in inbox' })).toBeTruthy();
});

test('Keep in inbox keeps, and is dark when Jev suggests keeping', () => {
  const onChoose = vi.fn();
  render(<FilingCard card={filing({ suggestKeep: true })} folders={FOLDERS} onChoose={onChoose} />);
  const keep = screen.getByRole('button', { name: 'Keep in inbox' });
  expect(keep.className).toContain('dark');
  fireEvent.click(keep);
  expect(onChoose).toHaveBeenCalledWith('keep', undefined);
});

test('Open in Gmail is a new-tab link that decides nothing', () => {
  const onChoose = vi.fn();
  render(<FilingCard card={filing()} folders={FOLDERS} onChoose={onChoose} />);
  const a = screen.getByRole('link', { name: 'Open in Gmail ↗' });
  expect(a.getAttribute('href')).toBe('https://mail.google.com/mail/u/0/#all/t1');
  expect(a.getAttribute('target')).toBe('_blank');
  expect(a.getAttribute('rel')).toBe('noopener noreferrer');
  fireEvent.click(a);
  flush();
  expect(onChoose).not.toHaveBeenCalled();
});

test('typing a new name in the combobox offers Create, which yields label:{typed}', () => {
  const onChoose = vi.fn();
  render(<FilingCard card={filing()} folders={FOLDERS} onChoose={onChoose} />);
  fireEvent.change(screen.getByRole('combobox', { name: 'Other folder' }), { target: { value: 'Taxes 2026' } });
  fireEvent.click(screen.getByRole('option', { name: 'Create “Taxes 2026”' }));
  expect(onChoose).toHaveBeenCalledWith('label:Taxes 2026', undefined);
});

test('typing "archive" offers Archive (not Create) and chooses the archive destination', () => {
  const onChoose = vi.fn();
  render(<FilingCard card={filing()} folders={FOLDERS} onChoose={onChoose} />);
  const box = screen.getByRole('combobox', { name: 'Other folder' });
  fireEvent.change(box, { target: { value: ' ARCHIVE ' } });
  expect(screen.queryByRole('option', { name: /Create/ })).toBeNull();
  expect(screen.queryByText('That name is reserved by Gmail')).toBeNull();
  fireEvent.click(screen.getByRole('option', { name: 'Archive' }));
  expect(onChoose).toHaveBeenCalledWith('archive', undefined);
});

test('the combobox lists existing labels, and picking one files there', () => {
  const onChoose = vi.fn();
  render(<FilingCard card={filing()} folders={FOLDERS} onChoose={onChoose} />);
  const box = screen.getByRole('combobox', { name: 'Other folder' });
  fireEvent.change(box, { target: { value: 'tra' } });
  expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Travel', 'Create “tra”']);
  fireEvent.click(screen.getByRole('option', { name: 'Travel' }));
  expect(onChoose).toHaveBeenCalledWith('label:Travel', undefined);
});

test('a typed name matching a label in another case selects that label, with no Create', () => {
  const onChoose = vi.fn();
  render(<FilingCard card={filing()} folders={FOLDERS} onChoose={onChoose} />);
  const box = screen.getByRole('combobox', { name: 'Other folder' });
  fireEvent.change(box, { target: { value: 'finance/statements' } });
  expect(screen.queryByRole('option', { name: /Create/ })).toBeNull();
  fireEvent.keyDown(box, { key: 'Enter' });
  expect(onChoose).toHaveBeenCalledWith('label:Finance/Statements', undefined);
});

test('a Gmail system label name is refused with a note and no Create', () => {
  const onChoose = vi.fn();
  render(<FilingCard card={filing()} folders={FOLDERS} onChoose={onChoose} />);
  const box = screen.getByRole('combobox', { name: 'Other folder' });
  for (const name of ['inbox', 'Spam', 'CATEGORY_UPDATES', 'starred']) {
    fireEvent.change(box, { target: { value: name } });
    expect(screen.getByText('That name is reserved by Gmail')).toBeTruthy();
    expect(screen.queryByRole('option', { name: /Create/ })).toBeNull();
    fireEvent.keyDown(box, { key: 'Enter' });
  }
  expect(onChoose).not.toHaveBeenCalled();
});

test('after a choice the card ignores further choices until the next card', () => {
  const onChoose = vi.fn(() => new Promise<void>(() => {}));
  render(<FilingCard card={filing()} folders={FOLDERS} onChoose={onChoose} />);
  key('1');
  key('2');
  fireEvent.click(screen.getByRole('button', { name: 'Keep in inbox' }));
  flush();
  key('3');
  fireEvent.click(screen.getByRole('button', { name: /Finance\/Bills due/ }));
  flush();
  expect(onChoose).toHaveBeenCalledTimes(1);
  expect(onChoose).toHaveBeenCalledWith('label:Finance/Statements', undefined);
});

test('a failed resolve shows its error on the card and makes it choosable again', async () => {
  const onChoose = vi.fn().mockRejectedValueOnce(new Error('batch is applying')).mockResolvedValue(undefined);
  render(<FilingCard card={filing()} folders={FOLDERS} onChoose={onChoose} />);
  key('2');
  await act(async () => { vi.advanceTimersByTime(LOCK_IN); });
  expect(screen.getByRole('alert').textContent).toContain('batch is applying');
  key('3');
  await act(async () => { vi.advanceTimersByTime(LOCK_IN); });
  expect(onChoose).toHaveBeenCalledTimes(2);
  expect(onChoose).toHaveBeenLastCalledWith('archive', undefined);
});

test('keys do nothing while typing in the combobox or with a modifier held', () => {
  const onChoose = vi.fn();
  render(<FilingCard card={filing()} folders={FOLDERS} onChoose={onChoose} />);
  const box = screen.getByRole('combobox', { name: 'Other folder' });
  box.focus();
  fireEvent.keyDown(box, { key: '1' });
  box.blur();
  for (const m of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey']) key('1', { [m]: true });
  flush();
  expect(onChoose).not.toHaveBeenCalled();
  key('1');
  flush();
  expect(onChoose).toHaveBeenCalledTimes(1);
});

test('under reduced motion the lock-in has no delay, and flyTo resolves at once without leaving a chip', async () => {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {} }));
  const onChoose = vi.fn();
  render(<FilingCard card={filing()} folders={FOLDERS} onChoose={onChoose} />);
  key('1');
  expect(onChoose).toHaveBeenCalledTimes(1);
  const a = document.createElement('div');
  const b = document.createElement('div');
  document.body.append(a, b);
  await flyTo(a, b, 'subject');
  expect(document.querySelector('.flyer')).toBeNull();
});

test('flyTo moves a chip and removes it when it lands', async () => {
  const a = document.createElement('div');
  const b = document.createElement('div');
  document.body.append(a, b);
  let done = false;
  const p = flyTo(a, b, 'Your September statement').then(() => { done = true; });
  const chip = document.querySelector('.flyer');
  expect(chip?.textContent).toBe('Your September statement');
  await act(async () => { vi.advanceTimersByTime(1000); });
  await p;
  expect(done).toBe(true);
  expect(document.querySelector('.flyer')).toBeNull();
});
