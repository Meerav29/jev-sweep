import { readFileSync } from 'node:fs';
import { beforeEach, expect, test } from 'vitest';
import { BatchRunner } from '../../../server/session/runner';
import { Repo } from '../../../server/db/repo';
import { FakeMail, loadFakeInbox } from '../../../server/mail/fake';
import { FakeJev } from '../../../server/jev/client';
import type { JevClient } from '../../../server/jev/client';
import { FakeWriter } from '../../../server/claude/cardText';
import type { BatchView, Email, Folder, JevAnswers, QueueItem, SessionEvent } from '../../../shared/types';

const now = new Date('2026-10-31T12:00:00Z');
const fixture = loadFakeInbox(JSON.parse(readFileSync('fixtures/fake-inbox.json', 'utf8')), now);
const byId = new Map(fixture.map((f) => [f.threadId, f]));

/** FakeMail where chosen threads vanish (getThread → null) or fail to archive. */
class TestMail extends FakeMail {
  gone = new Set<string>();
  archiveFails = new Set<string>();
  async getThread(threadId: string): Promise<Email | null> {
    return this.gone.has(threadId) ? null : super.getThread(threadId);
  }
  async archive(threadId: string): Promise<void> {
    if (this.archiveFails.has(threadId)) throw new Error('boom');
    return super.archive(threadId);
  }
}

let repo: Repo;
let mail: TestMail;
let jev: FakeJev;
let writer: FakeWriter;
let events: { batchId: string; e: SessionEvent }[];
let runner: BatchRunner;
let sessionId: string;

function makeRunner(j: JevClient = jev): BatchRunner {
  return new BatchRunner({
    mail, jev: j, writer, repo, emit: (batchId, e) => events.push({ batchId, e }), concurrency: 2, now: () => now,
  });
}
const settle = () => runner.idle();
const ofType = <T extends SessionEvent['type']>(id: string, t: T) =>
  events.filter((x) => x.batchId === id && x.e.type === t).map((x) => x.e as Extract<SessionEvent, { type: T }>);

beforeEach(() => {
  repo = new Repo(':memory:');
  repo.saveSettings({ batchSize: 50 }); // the whole 38-item fixture, so important emails are in the batch
  mail = new TestMail(fixture);
  jev = new FakeJev(Object.fromEntries(fixture.map((f) => [f.threadId, f.jev])));
  writer = new FakeWriter(Object.fromEntries(fixture.filter((f) => f.summary).map((f) => [f.threadId, f.summary!])));
  events = [];
  runner = makeRunner();
  sessionId = repo.createSession().id;
});

// What a browser builds from snapshot + events (spec 6.7: "a reload reconnects and replays it").
function outranks(a: QueueItem, b: QueueItem): boolean {
  return a.important !== b.important ? a.important : a.n < b.n;
}
function mirror(batchId: string): BatchView {
  let v: BatchView | null = null;
  for (const { batchId: b, e } of events) {
    if (b !== batchId) continue;
    if (e.type === 'snapshot') { v = structuredClone(e.view); continue; }
    if (!v) throw new Error(`event ${e.type} before snapshot`);
    switch (e.type) {
      case 'decided': {
        v.queue = v.queue.filter((q) => q.threadId !== e.decision.threadId);
        v.decisions = v.decisions.filter((d) => d.threadId !== e.decision.threadId);
        v.decisions.push(e.decision);
        v.decisions.sort((x, y) => x.n - y.n);
        break;
      }
      case 'queued': {
        const at = v.queue.findIndex((q) => outranks(e.item, q));
        v.queue.splice(at === -1 ? v.queue.length : at, 0, e.item);
        break;
      }
      case 'current':
        v.current = e.card;
        if (e.card) v.queue = v.queue.filter((q) => q.threadId !== e.card!.threadId);
        break;
      case 'card_text': break; // the runner re-emits `current` when the text belongs to it
      case 'progress': v.read = e.read; v.total = e.total; v.paused = e.paused; break;
      case 'status': v.status = e.status; break;
      default: break;
    }
  }
  if (!v) throw new Error('no snapshot');
  return v;
}

test('jev keeps processing while a card waits', async () => {
  const id = await runner.start(sessionId); await settle();
  const v = runner.view(id);
  expect(v.total).toBe(38);
  expect(v.read).toBe(v.total); // never blocked on the human
  expect(v.current).not.toBeNull(); expect(v.queue.length).toBeGreaterThan(0);
  expect(v.status).toBe('running');
  expect(ofType(id, 'progress').at(-1)).toEqual({ type: 'progress', read: 38, total: 38, paused: false });
});

test('important cards come first', async () => {
  // Deviation from the brief's one-liner: the oldest queued email (a filing card) becomes current long before
  // the two newest (important) emails reach Jev, and a card is never swapped out from under the reader.
  // So "first" is checked in the queue: importants lead it and come up next.
  const id = await runner.start(sessionId); await settle();
  const v = runner.view(id);
  expect(v.queue.slice(0, 2).map((q) => q.important)).toEqual([true, true]);
  expect(v.queue.slice(2).every((q) => !q.important)).toBe(true);
  if (v.current!.kind !== 'important') runner.resolve(id, v.current!.threadId, 'keep');
  expect(runner.view(id).current!.kind).toBe('important');
});

test('auto-archive writes to gmail, proposals do not', async () => {
  const id = await runner.start(sessionId); await settle();
  const archived = mail.log.filter((l) => l.startsWith('archive:')); expect(archived.length).toBeGreaterThan(0);
  expect(mail.log.some((l) => l.startsWith('label:'))).toBe(false);
  const autos = fixture.filter((f) => f.expect === 'auto_archive').map((f) => `archive:${f.threadId}`);
  expect([...archived].sort()).toEqual([...autos].sort());
  const ds = runner.view(id).decisions;
  expect(ds.find((d) => d.threadId === 't1')).toMatchObject({ dest: 'archive', who: 'jev', status: 'auto_applied' });
  expect(ds.find((d) => d.threadId === 't20')).toMatchObject({ who: 'jev', status: 'proposed' });
  expect(ds.find((d) => d.threadId === 't20')!.dest).toBe(byId.get('t20')!.jev.destination.choice);
});

test('dry run never writes', async () => {
  repo.saveSettings({ dryRun: true });
  const id = await runner.start(sessionId); await settle();
  expect(mail.log).toEqual([]);
  expect(runner.view(id).dryRun).toBe(true);
  expect(runner.view(id).decisions.find((d) => d.threadId === 't1')).toMatchObject({ status: 'auto_applied', note: 'dry run' });
});

test('resolve is idempotent', async () => {
  const id = await runner.start(sessionId); await settle();
  const t = runner.view(id).current!.threadId; const q = runner.view(id).queue.length;
  runner.resolve(id, t, 'keep'); runner.resolve(id, t, 'archive');
  expect(runner.view(id).decisions.find((d) => d.threadId === t)!.dest).toBe('keep');
  expect(runner.view(id).queue.length).toBe(Math.max(q - 1, 0));
  expect(runner.view(id).decisions.find((d) => d.threadId === t))
    .toMatchObject({ who: 'you', status: 'proposed', star: false, opened: false, important: false });
});

test('resolving an important card records star and opened', async () => {
  const id = await runner.start(sessionId); await settle();
  const imp = runner.view(id).queue[0];
  runner.jumpTo(id, imp.threadId);
  runner.resolve(id, imp.threadId, 'keep', { star: true });
  expect(runner.view(id).decisions.find((d) => d.threadId === imp.threadId))
    .toMatchObject({ dest: 'keep', who: 'you', status: 'proposed', star: true, opened: true, important: true });
});

test('resolving a queued card that is not current removes it from the queue', async () => {
  const id = await runner.start(sessionId); await settle();
  const before = runner.view(id);
  const b = before.queue.at(-1)!;
  runner.resolve(id, b.threadId, 'archive');
  const after = runner.view(id);
  expect(after.current!.threadId).toBe(before.current!.threadId);
  expect(after.queue.map((q) => q.threadId)).toEqual(before.queue.slice(0, -1).map((q) => q.threadId));
  runner.resolve(id, 'nope', 'keep'); runner.jumpTo(id, 'nope');
  expect(runner.view(id)).toEqual(after);
});

test('jumpTo puts the current card back at the front', async () => {
  const id = await runner.start(sessionId); await settle();
  const a = runner.view(id).current!.threadId;
  const b = runner.view(id).queue.at(-1)!.threadId;
  runner.jumpTo(id, b);
  const v = runner.view(id);
  expect(v.current!.threadId).toBe(b);
  expect(v.queue[0].threadId).toBe(a);
  expect(v.queue.some((q) => q.threadId === b)).toBe(false);
  const stored = repo.loadBatch(id);
  expect(stored.current).toBe(b);
  expect(stored.queue.map((q) => q.threadId)).toEqual(v.queue.map((q) => q.threadId));
});

test('jev failure becomes a filing card with no options', async () => {
  jev.failFor(fixture[3].threadId);
  const id = await runner.start(sessionId); await settle();
  runner.jumpTo(id, fixture[3].threadId);
  const card = runner.view(id).current!;
  expect(card.threadId).toBe(fixture[3].threadId);
  expect(card.kind).toBe('filing');
  expect(card.options).toEqual([]);
  expect(repo.loadBatch(id).jev[fixture[3].threadId]).toMatchObject({ failed: true, destination: { choice: 'keep', confidence: 0 } });
  expect(mail.log).not.toContain(`archive:${fixture[3].threadId}`);
});

test('queued cards get card text; the current card is re-emitted with it', async () => {
  const id = await runner.start(sessionId); await settle();
  const queuedCount = fixture.filter((f) => f.expect.startsWith('queue')).length;
  expect(ofType(id, 'card_text').length).toBe(queuedCount);
  expect(runner.view(id).current!.why).toBe("Jev wasn't sure about this one.");
  const imp = runner.view(id).queue[0].threadId;
  runner.jumpTo(id, imp);
  expect(runner.view(id).current!.summary).toEqual(byId.get(imp)!.summary);
});

test('reviewing once everything is answered', async () => {
  const id = await runner.start(sessionId); await settle();
  for (let i = 0; runner.view(id).current && i < 100; i++) runner.resolve(id, runner.view(id).current!.threadId, 'keep');
  const v = runner.view(id);
  expect(v.current).toBeNull(); expect(v.queue).toEqual([]);
  expect(ofType(id, 'status').at(-1)).toEqual({ type: 'status', status: 'reviewing' });
  expect(ofType(id, 'current').at(-1)).toEqual({ type: 'current', card: null });
  expect(v.status).toBe('reviewing');
  expect(repo.loadBatch(id).status).toBe('reviewing');
  expect(v.decisions.length).toBe(38);
});

test('a batch that fetches nothing goes straight to reviewing', async () => {
  mail = new TestMail([]); runner = makeRunner();
  const id = await runner.start(sessionId); await settle();
  expect(events.map((x) => x.e.type)).toEqual(['snapshot', 'status']);
  expect(runner.view(id)).toMatchObject({ status: 'reviewing', total: 0, read: 0, current: null });
});

test('a failed auto-archive is recorded and the pool keeps going', async () => {
  mail.archiveFails.add('t1');
  const id = await runner.start(sessionId); await settle();
  const v = runner.view(id);
  expect(v.decisions.find((d) => d.threadId === 't1')).toMatchObject({ status: 'failed', note: 'boom', who: 'jev', dest: 'archive' });
  expect(ofType(id, 'error').length).toBe(1);
  expect(v.read).toBe(38);
  expect(mail.log).toContain('archive:t2');
});

test('pause stops new jev calls; continue finishes the batch', async () => {
  const id = await runner.start(sessionId);
  runner.pause(id); await settle();
  const paused = runner.view(id);
  expect(paused.paused).toBe(true);
  expect(paused.read).toBeLessThan(38);
  expect(jev.calls).toBe(paused.read);
  expect(ofType(id, 'progress').at(-1)!.paused).toBe(true);
  runner.continue(id); await settle();
  expect(runner.view(id)).toMatchObject({ paused: false, read: 38 });
  expect(jev.calls).toBe(38);
});

test('the pool never runs more than `concurrency` jev calls at once', async () => {
  let inFlight = 0; let max = 0;
  const slow: JevClient = {
    async ask(e: Email, f: Folder[]): Promise<JevAnswers> {
      inFlight++; max = Math.max(max, inFlight);
      await new Promise((r) => setImmediate(r));
      inFlight--;
      return jev.ask(e, f);
    },
  };
  runner = makeRunner(slow);
  const id = await runner.start(sessionId); await settle();
  expect(max).toBe(2);
  expect(runner.view(id).read).toBe(38);
});

test('move sets a board decision without touching gmail', async () => {
  const id = await runner.start(sessionId); await settle();
  const logBefore = [...mail.log];
  runner.move(id, 't20', 'archive');
  expect(runner.view(id).decisions.find((d) => d.threadId === 't20')).toMatchObject({ dest: 'archive', who: 'you', status: 'proposed' });
  expect(ofType(id, 'decided').at(-1)!.decision.threadId).toBe('t20');
  const auto = runner.view(id).decisions.find((d) => d.threadId === 't1')!;
  runner.move(id, 't1', 'keep'); // auto_applied: out of scope, no-op
  expect(runner.view(id).decisions.find((d) => d.threadId === 't1')).toEqual(auto);
  const cur = runner.view(id).current!.threadId;
  const nextUp = runner.view(id).queue[0].threadId;
  runner.move(id, cur, 'label:Work'); // dragging the current card's chip decides it
  expect(runner.view(id).decisions.find((d) => d.threadId === cur)).toMatchObject({ dest: 'label:Work', who: 'you', status: 'proposed' });
  expect(runner.view(id).current!.threadId).toBe(nextUp);
  expect(mail.log).toEqual(logBefore);
});

test('a browser replaying snapshot + events sees exactly view()', async () => {
  const id = await runner.start(sessionId); await settle();
  expect(mirror(id)).toEqual(runner.view(id));
  runner.jumpTo(id, runner.view(id).queue.at(-1)!.threadId);
  runner.resolve(id, runner.view(id).current!.threadId, 'keep');
  runner.resolve(id, runner.view(id).queue.at(-1)!.threadId, 'archive');
  runner.move(id, 't21', 'keep');
  runner.pause(id); runner.continue(id);
  expect(mirror(id)).toEqual(runner.view(id));
  for (let i = 0; runner.view(id).current && i < 100; i++) runner.resolve(id, runner.view(id).current!.threadId, 'keep');
  expect(mirror(id)).toEqual(runner.view(id));
});

test('events mirror the view mid-run too (pushes after a jump)', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const gated: JevClient = {
    async ask(e: Email, f: Folder[]) { if (byId.get(e.threadId)!.expect === 'queue_important') await gate; return jev.ask(e, f); },
  };
  runner = makeRunner(gated);
  const id = await runner.start(sessionId);
  await new Promise((r) => setImmediate(r)); for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  const q = runner.view(id).queue;
  if (q.length > 0) runner.jumpTo(id, q.at(-1)!.threadId); // pins the old current at the front
  release(); await settle();
  expect(runner.view(id).read).toBe(38);
  expect(mirror(id)).toEqual(runner.view(id));
});

test('resume restores queue and does not re-ask Jev', async () => {
  const id = await runner.start(sessionId); await settle();
  runner.jumpTo(id, runner.view(id).queue.at(-1)!.threadId); // a pinned item must survive the restart
  const before = runner.view(id);
  const calls = jev.calls;
  events = [];
  runner = makeRunner();
  await runner.resume(id); await settle();
  const after = runner.view(id);
  expect(after.queue).toEqual(before.queue);
  expect(after.current).toEqual(before.current); // body re-fetched with getThread
  expect(after.decisions).toEqual(before.decisions);
  expect(after.read).toBe(38);
  expect(jev.calls).toBe(calls);
  expect(events[0].e.type).toBe('snapshot');
  expect(mirror(id)).toEqual(after);
});

test('resume skips queued threads that changed in Gmail', async () => {
  const id = await runner.start(sessionId); await settle();
  const before = runner.view(id);
  const goneQueued = before.queue[0].threadId;
  const goneCurrent = before.current!.threadId;
  mail.gone.add(goneQueued); mail.gone.add(goneCurrent);
  runner = makeRunner();
  await runner.resume(id); await settle();
  const v = runner.view(id);
  for (const t of [goneQueued, goneCurrent]) {
    expect(v.decisions.find((d) => d.threadId === t)).toMatchObject({ status: 'skipped', note: 'changed in Gmail' });
    expect(v.queue.some((q) => q.threadId === t)).toBe(false);
  }
  expect(v.current!.threadId).toBe(before.queue[1].threadId);
  expect(repo.loadBatch(id).current).toBe(v.current!.threadId);
});

test('resume continues emails Jev had not reached', async () => {
  const id = await runner.start(sessionId);
  runner.pause(id); await settle();
  const stored = repo.loadBatch(id);
  const pending = stored.emails.map((e) => e.email.threadId).filter((t) => !stored.jev[t]);
  expect(pending.length).toBeGreaterThan(1);
  const gone = pending.at(-1)!;
  mail.gone.add(gone);
  const calls = jev.calls;
  runner = makeRunner();
  await runner.resume(id); await settle();
  const v = runner.view(id);
  expect(jev.calls).toBe(calls + pending.length - 1);
  expect(v.read).toBe(38);
  expect(v.paused).toBe(false);
  expect(v.decisions.find((d) => d.threadId === gone)).toMatchObject({ status: 'skipped', note: 'changed in Gmail' });
  expect(mirror(id)).toEqual(v);
});

test('two batches coexist and events carry their batch id', async () => {
  repo.saveSettings({ batchSize: 10 });
  const a = await runner.start(sessionId); await settle();
  const b = await runner.start(sessionId); await settle();
  expect(a).not.toBe(b);
  const ta = new Set(repo.loadBatch(a).emails.map((e) => e.email.threadId));
  expect(repo.loadBatch(b).emails.some((e) => ta.has(e.email.threadId))).toBe(false);
  expect(runner.view(a).batchNo).toBe(1); expect(runner.view(b).batchNo).toBe(2);
  expect(mirror(a)).toEqual(runner.view(a)); expect(mirror(b)).toEqual(runner.view(b));
});
