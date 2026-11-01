import { readFileSync } from 'node:fs';
import { beforeEach, expect, test } from 'vitest';
import { applyBatch } from '../../../server/session/apply';
import { Repo } from '../../../server/db/repo';
import { FakeMail, loadFakeInbox } from '../../../server/mail/fake';
import type { BatchStatus, Decision, Dest, Email, SessionEvent } from '../../../shared/types';

const now = new Date('2026-10-31T12:00:00Z');
const fixture = loadFakeInbox(JSON.parse(readFileSync('fixtures/fake-inbox.json', 'utf8')), now);
const byId = new Map(fixture.map((f) => [f.threadId, f]));

/** FakeMail that records every call (reads too) and can be told to misbehave per thread. */
class TestMail extends FakeMail {
  calls: string[] = [];
  gone = new Set<string>();
  getThreadFails = new Set<string>();
  /** Fail the next call of `op` for a thread, once. */
  failOnce = new Map<string, 'addLabel' | 'unarchive' | 'archive'>();
  newMessage = new Set<string>();
  beforeWrite: (op: string, threadId: string) => void = () => {};

  async getThread(threadId: string): Promise<Email | null> {
    this.calls.push(`getThread:${threadId}`);
    if (this.getThreadFails.has(threadId)) throw new Error('gmail 500');
    if (this.gone.has(threadId)) return null;
    const t = await super.getThread(threadId);
    if (t && this.newMessage.has(threadId)) t.latestMessageId = `${t.latestMessageId}-new`;
    return t;
  }
  private guard(op: 'addLabel' | 'unarchive' | 'archive' | 'star' | 'markRead', threadId: string): void {
    this.calls.push(`${op}:${threadId}`);
    this.beforeWrite(op, threadId);
    if (this.failOnce.get(threadId) === op) {
      this.failOnce.delete(threadId);
      throw new Error(`${op} exploded`);
    }
  }
  async archive(t: string) { this.guard('archive', t); return super.archive(t); }
  async unarchive(t: string) { this.guard('unarchive', t); return super.unarchive(t); }
  async addLabel(t: string, name: string) { this.guard('addLabel', t); return super.addLabel(t, name); }
  async star(t: string) { this.guard('star', t); return super.star(t); }
  async markRead(t: string) { this.guard('markRead', t); return super.markRead(t); }
}

let repo: Repo;
let mail: TestMail;
let events: { batchId: string; e: SessionEvent }[];
let sessionId: string;

const deps = () => ({ mail, repo, emit: (batchId: string, e: SessionEvent) => events.push({ batchId, e }) });
const ofType = <T extends SessionEvent['type']>(id: string, t: T) =>
  events.filter((x) => x.batchId === id && x.e.type === t).map((x) => x.e as Extract<SessionEvent, { type: T }>);
const decisionOf = (id: string, t: string) => repo.loadBatch(id).decisions.find((d) => d.threadId === t)!;

beforeEach(() => {
  repo = new Repo(':memory:');
  mail = new TestMail(fixture);
  events = [];
  sessionId = repo.createSession().id;
});

type Spec = { t: string; dest: Dest; status?: Decision['status']; star?: boolean; opened?: boolean; note?: string };

/** A reviewed batch holding exactly these decisions. auto_applied ones (not dry run) are archived in FakeMail first. */
async function batch(specs: Spec[], opts: { dryRun?: boolean; status?: BatchStatus } = {}): Promise<string> {
  const { id } = repo.createBatch(sessionId, specs.length, opts.dryRun ?? false);
  for (const [i, s] of specs.entries()) {
    const e = byId.get(s.t)!;
    repo.saveEmail(id, i + 1, e);
    const status = s.status ?? 'proposed';
    const d: Decision = { threadId: s.t, n: i + 1, subject: e.subject, fromName: e.fromName, dest: s.dest,
      who: status === 'auto_applied' ? 'jev' : 'you', important: !!s.opened, star: !!s.star, opened: !!s.opened, status };
    if (s.note) d.note = s.note;
    repo.saveDecision(id, d);
    if (status === 'auto_applied' && s.note !== 'dry run') await mail.archive(s.t);
  }
  repo.setBatchStatus(id, opts.status ?? 'reviewing');
  mail.log = [];
  mail.calls = [];
  return id;
}

// ---- brief tests ----

test('a proposed label: label, archive, mark read', async () => {
  const id = await batch([{ t: 't1', dest: 'label:Travel' }]);
  expect(await applyBatch(deps(), id)).toEqual({ applied: 1, skipped: 0, failed: 0 });
  expect(mail.log).toEqual(['label:t1:Travel', 'archive:t1', 'read:t1']);
  expect(decisionOf(id, 't1')).toMatchObject({ status: 'applied' });
  expect(decisionOf(id, 't1').note).toBeUndefined();
  expect(repo.loadBatch(id).status).toBe('applied');
});

test('a proposed keep, starred and opened: read and star, never archived', async () => {
  const id = await batch([{ t: 't2', dest: 'keep', star: true, opened: true }]);
  await applyBatch(deps(), id);
  expect(mail.log).toEqual(['read:t2', 'star:t2']);
  expect(decisionOf(id, 't2').status).toBe('applied');
});

test('a plain keep keeps its read state; a plain archive is archived and read', async () => {
  const id = await batch([{ t: 't3', dest: 'keep' }, { t: 't4', dest: 'archive' }]);
  expect(await applyBatch(deps(), id)).toEqual({ applied: 2, skipped: 0, failed: 0 });
  expect(mail.log).toEqual(['archive:t4', 'read:t4']);
  expect((await mail.getThread('t3'))!.unread).toBe(true);
});

test('an auto-archived thread moved to a label is unarchived, then labeled (and re-archived)', async () => {
  const id = await batch([{ t: 't5', dest: 'label:Receipts', status: 'auto_applied' }]);
  expect(await applyBatch(deps(), id)).toEqual({ applied: 1, skipped: 0, failed: 0 });
  expect(mail.log).toEqual(['unarchive:t5', 'label:t5:Receipts', 'archive:t5', 'read:t5']);
  expect(decisionOf(id, 't5').status).toBe('applied');
});

test('an auto-archived thread moved to keep is put back in the inbox only', async () => {
  const id = await batch([{ t: 't5', dest: 'keep', status: 'auto_applied' }]);
  await applyBatch(deps(), id);
  expect(mail.log).toEqual(['unarchive:t5']);
  expect((await mail.getThread('t5'))!.labels).toContain('INBOX');
});

test('a thread with a new message is skipped with no writes', async () => {
  mail.newMessage.add('t1');
  const id = await batch([{ t: 't1', dest: 'label:Travel' }, { t: 't2', dest: 'archive' }]);
  expect(await applyBatch(deps(), id)).toEqual({ applied: 1, skipped: 1, failed: 0 });
  expect(decisionOf(id, 't1')).toMatchObject({ status: 'skipped', note: 'changed in Gmail' });
  expect(mail.log).toEqual(['archive:t2', 'read:t2']);
  expect(repo.loadBatch(id).status).toBe('applied');
});

test('dry run (batch): no Gmail calls at all; everything applied with note "dry run"', async () => {
  const id = await batch([
    { t: 't1', dest: 'label:Travel' }, { t: 't2', dest: 'keep', star: true, opened: true },
    { t: 't3', dest: 'label:Receipts', status: 'auto_applied', note: 'dry run' },
    { t: 't4', dest: 'archive', status: 'auto_applied', note: 'dry run' },
  ], { dryRun: true });
  const before = decisionOf(id, 't4');
  expect(await applyBatch(deps(), id)).toEqual({ applied: 3, skipped: 0, failed: 0 });
  expect(mail.calls).toEqual([]);
  expect(mail.log).toEqual([]);
  for (const t of ['t1', 't2', 't3']) expect(decisionOf(id, t)).toMatchObject({ status: 'applied', note: 'dry run' });
  expect(decisionOf(id, 't4')).toEqual(before);
  expect(repo.loadBatch(id).status).toBe('applied');
});

test('dry run (current settings) on a batch that started live: no Gmail calls', async () => {
  const id = await batch([{ t: 't1', dest: 'label:Travel' }, { t: 't2', dest: 'archive', status: 'auto_applied' },
    { t: 't3', dest: 'keep', status: 'auto_applied' }]);
  repo.saveSettings({ dryRun: true });
  expect(await applyBatch(deps(), id)).toEqual({ applied: 2, skipped: 0, failed: 0 });
  expect(mail.calls).toEqual([]);
  expect(decisionOf(id, 't1')).toMatchObject({ status: 'applied', note: 'dry run' });
  expect(decisionOf(id, 't3')).toMatchObject({ status: 'applied', note: 'dry run' });
  expect(decisionOf(id, 't2')).toMatchObject({ status: 'auto_applied' });
});

test('dry run switched on mid-apply: the rest are not written', async () => {
  const id = await batch([{ t: 't1', dest: 'archive' }, { t: 't2', dest: 'archive' }]);
  mail.beforeWrite = (op, t) => { if (op === 'markRead' && t === 't1') repo.saveSettings({ dryRun: true }); };
  expect(await applyBatch(deps(), id)).toEqual({ applied: 2, skipped: 0, failed: 0 });
  expect(mail.log).toEqual(['archive:t1', 'read:t1']);
  expect(decisionOf(id, 't2')).toMatchObject({ status: 'applied', note: 'dry run' });
});

test('running applyBatch twice never repeats a write', async () => {
  const id = await batch([{ t: 't1', dest: 'label:Travel' }, { t: 't2', dest: 'keep', star: true },
    { t: 't5', dest: 'label:Receipts', status: 'auto_applied' }]);
  await applyBatch(deps(), id);
  const log = [...mail.log];
  expect(await applyBatch(deps(), id)).toEqual({ applied: 0, skipped: 0, failed: 0 });
  expect(mail.log).toEqual(log);
  expect(repo.loadBatch(id).status).toBe('applied');
});

test('addLabel throwing once fails that decision only and keeps the batch reviewing; a retry applies it', async () => {
  mail.failOnce.set('t2', 'addLabel');
  const id = await batch([{ t: 't1', dest: 'label:Travel' }, { t: 't2', dest: 'label:Travel' }, { t: 't3', dest: 'archive' }]);
  expect(await applyBatch(deps(), id)).toEqual({ applied: 2, skipped: 0, failed: 1 });
  expect(decisionOf(id, 't2')).toMatchObject({ status: 'failed', note: 'apply: addLabel exploded' });
  expect(decisionOf(id, 't1').status).toBe('applied');
  expect(decisionOf(id, 't3').status).toBe('applied');
  expect(repo.loadBatch(id).status).toBe('reviewing');
  expect(ofType(id, 'error').at(-1)!.message).toContain('addLabel exploded');
  expect(ofType(id, 'status').at(-1)!.status).toBe('reviewing');

  mail.log = [];
  expect(await applyBatch(deps(), id)).toEqual({ applied: 1, skipped: 0, failed: 0 });
  expect(mail.log).toEqual(['label:t2:Travel', 'archive:t2', 'read:t2']);
  expect(decisionOf(id, 't2').status).toBe('applied');
  expect(decisionOf(id, 't2').note).toBeUndefined();
  expect(repo.loadBatch(id).status).toBe('applied');
});

// ---- ruling 3: what is processed ----

test('runner failures, skips, earlier applies and untouched auto-archives are never processed', async () => {
  const id = await batch([
    { t: 't1', dest: 'keep', status: 'failed', note: 'boom' },
    { t: 't2', dest: 'keep', status: 'skipped', note: 'changed in Gmail' },
    { t: 't3', dest: 'label:Travel', status: 'applied' },
    { t: 't4', dest: 'archive', status: 'auto_applied' },
  ]);
  const before = repo.loadBatch(id).decisions;
  expect(await applyBatch(deps(), id)).toEqual({ applied: 0, skipped: 0, failed: 0 });
  expect(mail.calls).toEqual([]);
  expect(repo.loadBatch(id).decisions).toEqual(before);
  expect(repo.loadBatch(id).status).toBe('applied'); // a runner failure stays in the inbox; it doesn't block the batch
});

test('a moved auto-archive whose unarchive failed is unarchived on retry', async () => {
  mail.failOnce.set('t5', 'unarchive');
  const id = await batch([{ t: 't5', dest: 'label:Receipts', status: 'auto_applied' }]);
  expect(await applyBatch(deps(), id)).toEqual({ applied: 0, skipped: 0, failed: 1 });
  expect(decisionOf(id, 't5').status).toBe('failed');
  expect(decisionOf(id, 't5').note!.startsWith('apply: ')).toBe(true);
  mail.log = [];
  expect(await applyBatch(deps(), id)).toEqual({ applied: 1, skipped: 0, failed: 0 });
  expect(mail.log).toEqual(['unarchive:t5', 'label:t5:Receipts', 'archive:t5', 'read:t5']);
});

test('a moved auto-archive that failed after unarchive is not unarchived twice on retry', async () => {
  mail.failOnce.set('t5', 'addLabel');
  const id = await batch([{ t: 't5', dest: 'label:Receipts', status: 'auto_applied' }]);
  await applyBatch(deps(), id);
  expect(mail.log).toEqual(['unarchive:t5']);
  mail.log = [];
  expect(await applyBatch(deps(), id)).toEqual({ applied: 1, skipped: 0, failed: 0 });
  expect(mail.log).toEqual(['label:t5:Receipts', 'archive:t5', 'read:t5']);
});

test('a moved auto-archive that was only a dry-run note is applied like a proposal (it never left the inbox)', async () => {
  const id = await batch([{ t: 't5', dest: 'label:Receipts', status: 'auto_applied', note: 'dry run' }]);
  expect(await applyBatch(deps(), id)).toEqual({ applied: 1, skipped: 0, failed: 0 });
  expect(mail.log).toEqual(['label:t5:Receipts', 'archive:t5', 'read:t5']);
});

test('a retried proposal that failed before archiving must still be in the inbox', async () => {
  mail.failOnce.set('t1', 'addLabel');
  const id = await batch([{ t: 't1', dest: 'label:Travel' }]);
  await applyBatch(deps(), id);
  expect(decisionOf(id, 't1')).toMatchObject({ status: 'failed', note: 'apply: addLabel exploded' });
  await mail.archive('t1'); // the user archives it in Gmail meanwhile
  mail.log = [];
  expect(await applyBatch(deps(), id)).toEqual({ applied: 0, skipped: 1, failed: 0 });
  expect(decisionOf(id, 't1')).toMatchObject({ status: 'skipped', note: 'changed in Gmail' });
  expect(mail.log).toEqual([]);
});

test('a proposal that failed after archiving records it, and the retry only finishes the rest', async () => {
  const fails = new Set(['markRead']);
  mail.beforeWrite = (op) => { if (fails.delete(op)) throw new Error('read exploded'); };
  const id = await batch([{ t: 't1', dest: 'label:Travel', star: true }]);
  expect(await applyBatch(deps(), id)).toEqual({ applied: 0, skipped: 0, failed: 1 });
  expect(decisionOf(id, 't1')).toMatchObject({ status: 'failed', note: 'apply: (archived) read exploded' });
  expect(ofType(id, 'error').at(-1)!.message).toBe(`Applying "${byId.get('t1')!.subject}" failed: read exploded`);
  mail.log = [];
  expect(await applyBatch(deps(), id)).toEqual({ applied: 1, skipped: 0, failed: 0 });
  expect(mail.log).toEqual(['read:t1', 'star:t1']);
});

test('an archived-marked retry that is back in the inbox was moved by someone: skipped', async () => {
  const fails = new Set(['markRead']);
  mail.beforeWrite = (op) => { if (fails.delete(op)) throw new Error('read exploded'); };
  const id = await batch([{ t: 't1', dest: 'archive' }]);
  await applyBatch(deps(), id);
  await mail.unarchive('t1');
  mail.log = [];
  expect(await applyBatch(deps(), id)).toEqual({ applied: 0, skipped: 1, failed: 0 });
  expect(mail.log).toEqual([]);
});

test('error events never show the progress markers', async () => {
  mail.failOnce.set('t5', 'unarchive');
  const id = await batch([{ t: 't5', dest: 'label:Receipts', status: 'auto_applied' }]);
  await applyBatch(deps(), id);
  expect(decisionOf(id, 't5').note).toBe('apply: (undo) unarchive exploded');
  expect(ofType(id, 'error').at(-1)!.message).toBe(`Applying "${byId.get('t5')!.subject}" failed: unarchive exploded`);
});

// ---- ruling 4: re-check ----

test('each re-check reason skips with "changed in Gmail" and writes nothing for that thread', async () => {
  mail.gone.add('t1');
  mail.newMessage.add('t2');
  await mail.archive('t3'); // proposed, but someone archived it in Gmail
  const id = await batch([
    { t: 't1', dest: 'archive' }, { t: 't2', dest: 'label:Travel' }, { t: 't3', dest: 'keep', star: true },
    { t: 't4', dest: 'keep', status: 'auto_applied' },
  ]);
  await mail.unarchive('t4'); // auto-archived, but someone moved it back to the inbox
  mail.log = [];
  expect(await applyBatch(deps(), id)).toEqual({ applied: 0, skipped: 4, failed: 0 });
  for (const t of ['t1', 't2', 't3', 't4']) expect(decisionOf(id, t)).toMatchObject({ status: 'skipped', note: 'changed in Gmail' });
  expect(mail.log).toEqual([]);
  expect(repo.loadBatch(id).status).toBe('applied');
});

test('getThread throwing fails the decision with an apply: note', async () => {
  mail.getThreadFails.add('t1');
  const id = await batch([{ t: 't1', dest: 'archive' }]);
  expect(await applyBatch(deps(), id)).toEqual({ applied: 0, skipped: 0, failed: 1 });
  expect(decisionOf(id, 't1')).toMatchObject({ status: 'failed', note: 'apply: gmail 500' });
  expect(mail.log).toEqual([]);
  expect(repo.loadBatch(id).status).toBe('reviewing');
});

// ---- ruling 6: groups, labels, events ----

test('a step for one thread is worded in the singular', async () => {
  const id = await batch([{ t: 't1', dest: 'archive' }, { t: 't2', dest: 'label:Travel' }, { t: 't3', dest: 'keep' }]);
  await applyBatch(deps(), id);
  expect([...new Set(ofType(id, 'apply_step').map((e) => e.label))]).toEqual([
    'Archiving 1 thread', 'Labeling 1 → Travel and archiving', 'Leaving 1 in inbox',
  ]);
});

test('groups run archive, labels alphabetically, keep, with apply_step and status events around them', async () => {
  const id = await batch([
    { t: 't1', dest: 'keep', opened: true }, { t: 't2', dest: 'label:Travel' }, { t: 't3', dest: 'archive' },
    { t: 't4', dest: 'label:Receipts' }, { t: 't5', dest: 'label:Travel' }, { t: 't6', dest: 'archive' },
  ]);
  await applyBatch(deps(), id);
  const seq = events.filter((x) => x.batchId === id).map(({ e }) =>
    e.type === 'status' ? `status:${e.status}`
      : e.type === 'apply_step' ? `step:${e.label}:${e.count}:${e.done}`
        : e.type === 'decided' ? `decided:${e.decision.threadId}:${e.decision.status}` : e.type);
  expect(seq).toEqual([
    'status:applying',
    'step:Archiving 2 threads:2:false', 'decided:t3:applied', 'decided:t6:applied', 'step:Archiving 2 threads:2:true',
    'step:Labeling 1 → Receipts and archiving:1:false', 'decided:t4:applied', 'step:Labeling 1 → Receipts and archiving:1:true',
    'step:Labeling 2 → Travel and archiving:2:false', 'decided:t2:applied', 'decided:t5:applied',
    'step:Labeling 2 → Travel and archiving:2:true',
    'step:Leaving 1 in inbox:1:false', 'decided:t1:applied', 'step:Leaving 1 in inbox:1:true',
    'status:applied',
  ]);
  expect(mail.log).toEqual(['archive:t3', 'read:t3', 'archive:t6', 'read:t6',
    'label:t4:Receipts', 'archive:t4', 'read:t4',
    'label:t2:Travel', 'archive:t2', 'read:t2', 'label:t5:Travel', 'archive:t5', 'read:t5',
    'read:t1']);
});

// ---- ruling 7: concurrency ----

test('a concurrent applyBatch for the same batch does not double-apply', async () => {
  const id = await batch([{ t: 't1', dest: 'label:Travel' }, { t: 't2', dest: 'archive' }]);
  const a = applyBatch(deps(), id);
  const b = applyBatch(deps(), id);
  const [ra, rb] = await Promise.all([a, b]);
  expect(ra).toEqual({ applied: 2, skipped: 0, failed: 0 });
  expect(rb).toEqual(ra); // the same run, not a second one
  expect(mail.log).toEqual(['archive:t2', 'read:t2', 'label:t1:Travel', 'archive:t1', 'read:t1']);
  expect(ofType(id, 'status').map((e) => e.status)).toEqual(['applying', 'applied']);
  // Once finished, a later call runs again (and finds nothing to do).
  expect(await applyBatch(deps(), id)).toEqual({ applied: 0, skipped: 0, failed: 0 });
});

// ---- batch status guard ----

test('a batch still running, or discarded, is refused without touching Gmail', async () => {
  for (const status of ['running', 'discarded'] as const) {
    const id = await batch([{ t: 't1', dest: 'archive' }], { status });
    await expect(applyBatch(deps(), id)).rejects.toThrow(status);
    expect(repo.loadBatch(id).status).toBe(status);
    expect(mail.calls).toEqual([]);
  }
});
