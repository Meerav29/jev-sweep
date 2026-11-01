import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repo } from '../../../server/db/repo';
import { DEFAULT_SETTINGS } from '../../../shared/types';
import type { Decision } from '../../../shared/types';
import { email, ans } from '../jev/fixtures';

const dec = (threadId: string, o: Partial<Decision> = {}): Decision => ({
  threadId, n: 1, subject: 's', fromName: 'f', dest: 'archive', who: 'jev',
  important: false, star: false, opened: false, status: 'proposed', ...o,
});

describe('Repo', () => {
  let repo: Repo;
  let sid: string;
  beforeEach(() => { repo = new Repo(':memory:'); sid = repo.createSession().id; });

  it('numbers batches from 1 within a session', () => {
    expect(repo.createBatch(sid, 5).batchNo).toBe(1);
    expect(repo.createBatch(sid, 5).batchNo).toBe(2);
    expect(repo.createBatch(repo.createSession().id, 5).batchNo).toBe(1);
  });

  it('stores emails without the body', () => {
    const { id } = repo.createBatch(sid, 1);
    repo.saveEmail(id, 1, email);
    const b = repo.loadBatch(id);
    expect(b.emails).toHaveLength(1);
    expect(b.emails[0].n).toBe(1);
    expect('body' in b.emails[0].email).toBe(false);
    expect(b.emails[0].email.subject).toBe('Hello');
    expect(b.emails[0].email.labels).toEqual(['INBOX', 'UNREAD']);
    expect(b.emails[0].email.unread).toBe(true);
  });

  it('round-trips jev, card text, decisions, queue and current', () => {
    const { id } = repo.createBatch(sid, 2);
    repo.saveEmail(id, 1, email);
    repo.saveJev(id, 't1', ans({}));
    repo.saveCardText(id, 't1', { why: 'w', summary: ['a'] });
    repo.saveDecision(id, dec('t1', { note: 'x' }));
    repo.saveDecision(id, dec('t1', { dest: 'label:Travel', who: 'you', status: 'applied' }));
    repo.saveQueue(id, [{ threadId: 't2', n: 2, subject: 'q', important: true }, { threadId: 't3', n: 3, subject: 'r', important: false }], 't2');
    const b = repo.loadBatch(id);
    expect(b.sessionId).toBe(sid);
    expect(b.total).toBe(2);
    expect(b.status).toBe('running');
    expect(b.jev.t1.destination.choice).toBe('archive');
    expect(b.text.t1).toEqual({ why: 'w', summary: ['a'] });
    expect(b.decisions).toHaveLength(1);
    expect(b.decisions[0].dest).toBe('label:Travel');
    expect(b.queue.map((q) => q.threadId)).toEqual(['t2', 't3']);
    expect(b.current).toBe('t2');
    repo.saveQueue(id, [], null);
    expect(repo.loadBatch(id).queue).toEqual([]);
    expect(repo.loadBatch(id).current).toBeNull();
    repo.deleteDecision(id, 't1');
    expect(repo.loadBatch(id).decisions).toEqual([]);
  });

  it('excludes decided threads with their latestMessageId and all emails of running batches', () => {
    const a = repo.createBatch(sid, 2).id;
    repo.saveEmail(a, 1, { ...email, threadId: 'd', latestMessageId: 'md' });
    repo.saveEmail(a, 2, { ...email, threadId: 'u', latestMessageId: 'mu' });
    repo.saveDecision(a, dec('d'));
    repo.setBatchStatus(a, 'reviewing');
    expect(repo.excludedThreads().get('d')).toBe('md');
    expect(repo.excludedThreads().get('u')).toBe('mu');
    repo.setBatchStatus(a, 'applied');
    const ex = repo.excludedThreads();
    expect(ex.get('d')).toBe('md');
    expect(ex.has('u')).toBe(false);
  });

  it('uses the most recent batch latestMessageId', () => {
    const a = repo.createBatch(sid, 1).id;
    repo.saveEmail(a, 1, { ...email, latestMessageId: 'old' });
    repo.saveDecision(a, dec('t1', { status: 'applied' }));
    repo.setBatchStatus(a, 'applied');
    const b = repo.createBatch(sid, 1).id;
    repo.saveEmail(b, 1, { ...email, latestMessageId: 'new' });
    repo.saveDecision(b, dec('t1'));
    expect(repo.excludedThreads().get('t1')).toBe('new');
  });

  it('discarded batch frees proposed threads but keeps auto_applied ones', () => {
    const a = repo.createBatch(sid, 2).id;
    repo.saveEmail(a, 1, { ...email, threadId: 'p', latestMessageId: 'mp' });
    repo.saveEmail(a, 2, { ...email, threadId: 'x', latestMessageId: 'mx' });
    repo.saveDecision(a, dec('p', { status: 'proposed' }));
    repo.saveDecision(a, dec('x', { status: 'auto_applied' }));
    repo.setBatchStatus(a, 'discarded');
    const ex = repo.excludedThreads();
    expect(ex.has('p')).toBe(false);
    expect(ex.get('x')).toBe('mx');
  });

  /** A batch holding thread `t` (auto-archived) and `p` (proposed then applied), both noted `dry run` if dry. */
  const finishedBatch = (tag: string, dry: boolean, status: 'applied' | 'reviewing' | 'applying' | 'discarded') => {
    const id = repo.createBatch(sid, 2, dry).id;
    repo.saveEmail(id, 1, { ...email, threadId: `${tag}-auto`, latestMessageId: 'm1' });
    repo.saveEmail(id, 2, { ...email, threadId: `${tag}-prop`, latestMessageId: 'm2' });
    const note = dry ? { note: 'dry run' } : {};
    repo.saveDecision(id, dec(`${tag}-auto`, { status: 'auto_applied', ...note }));
    repo.saveDecision(id, dec(`${tag}-prop`, { n: 2, status: status === 'applied' ? 'applied' : 'proposed', ...note }));
    repo.setBatchStatus(id, status);
    return id;
  };

  it('dry-run results of an applied or discarded batch do not hide threads from later batches', () => {
    finishedBatch('a', true, 'applied');
    finishedBatch('x', true, 'discarded');
    const ex = repo.excludedThreads();
    for (const t of ['a-auto', 'a-prop', 'x-auto']) expect(ex.has(t)).toBe(false);
  });

  it('a live applied batch still excludes its threads', () => {
    finishedBatch('l', false, 'applied');
    const ex = repo.excludedThreads();
    expect(ex.get('l-auto')).toBe('m1');
    expect(ex.get('l-prop')).toBe('m2');
  });

  it('a dry-run batch still reviewing or applying excludes all its threads', () => {
    finishedBatch('r', true, 'reviewing');
    finishedBatch('y', true, 'applying');
    const ex = repo.excludedThreads();
    for (const t of ['r-auto', 'r-prop', 'y-auto', 'y-prop']) expect(ex.has(t)).toBe(true);
  });

  it('batchStatus reads one batch status', () => {
    const a = repo.createBatch(sid, 1).id;
    expect(repo.batchStatus(a)).toBe('running');
    repo.setBatchStatus(a, 'applying');
    expect(repo.batchStatus(a)).toBe('applying');
    expect(repo.batchStatus('nope')).toBeUndefined();
  });

  it('unfinishedBatch returns running/reviewing and ignores applied', () => {
    expect(repo.unfinishedBatch()).toBeUndefined();
    const a = repo.createBatch(sid, 1).id;
    repo.setBatchStatus(a, 'applied');
    expect(repo.unfinishedBatch()).toBeUndefined();
    const b = repo.createBatch(sid, 1).id;
    repo.setBatchStatus(b, 'reviewing');
    expect(repo.unfinishedBatch()).toEqual({ batchId: b, sessionId: sid });
  });

  it('listSessions summarises, newest first', () => {
    const a = repo.createBatch(sid, 4).id;
    repo.saveDecision(a, dec('1', { dest: 'archive' }));
    repo.saveDecision(a, dec('2', { dest: 'label:Travel', who: 'you', important: true }));
    repo.saveDecision(a, dec('3', { dest: 'keep', who: 'you' }));
    repo.setBatchStatus(a, 'applied');
    const gone = repo.createBatch(sid, 6).id;
    repo.saveDecision(gone, dec('4', { dest: 'archive' }));
    repo.setBatchStatus(gone, 'discarded');
    const live = repo.createBatch(sid, 2).id;
    const s2 = repo.createSession().id;
    const list = repo.listSessions();
    expect(list.map((s) => s.id)).toEqual([s2, sid]);
    const s = list[1];
    expect(s.batches).toBe(3);
    expect(s.total).toBe(12);
    expect(s.split).toEqual({ archived: 1, filed: 1, you: 2, important: 1 });
    expect(s.unfinishedBatchId).toBe(live);
    expect(list[0].unfinishedBatchId).toBeUndefined();
    expect(s.lastBatchId).toBe(live);
    expect(list[0].lastBatchId).toBeUndefined();
  });

  it('lastBatchId skips empty batches, unless every batch is empty', () => {
    const full = repo.createBatch(sid, 3).id;
    repo.setBatchStatus(full, 'applied');
    const empty = repo.createBatch(sid, 0).id;
    repo.setBatchStatus(empty, 'applied');
    const gone = repo.createBatch(sid, 5).id;
    repo.setBatchStatus(gone, 'discarded');
    expect(repo.listSessions().find((s) => s.id === sid)!.lastBatchId).toBe(full);

    const s2 = repo.createSession().id;
    const e1 = repo.createBatch(s2, 0).id;
    repo.setBatchStatus(e1, 'applied');
    const e2 = repo.createBatch(s2, 0).id;
    repo.setBatchStatus(e2, 'applied');
    const g2 = repo.createBatch(s2, 4).id;
    repo.setBatchStatus(g2, 'discarded');
    expect(repo.listSessions().find((s) => s.id === s2)!.lastBatchId).toBe(e2);
  });

  it('settings merge defaults with stored values', () => {
    expect(repo.getSettings()).toEqual(DEFAULT_SETTINGS);
    const out = repo.saveSettings({ dryRun: true });
    expect(out.dryRun).toBe(true);
    expect(repo.getSettings().dryRun).toBe(true);
    expect(repo.getSettings().query).toBe(DEFAULT_SETTINGS.query);
    repo.saveSettings({ thresholds: { recentDays: 3 } as never });
    expect(repo.getSettings().thresholds).toEqual({ ...DEFAULT_SETTINGS.thresholds, recentDays: 3 });
    expect(repo.getSettings().dryRun).toBe(true);
    repo.saveSettings({ folders: [{ name: 'A', enabled: true }] });
    expect(repo.getSettings().folders).toEqual([{ name: 'A', enabled: true }]);
  });

  it('a batch that crashed mid-apply is still unfinished (resumable)', () => {
    const b = repo.createBatch(sid, 1).id;
    repo.setBatchStatus(b, 'applying');
    expect(repo.unfinishedBatch()).toEqual({ batchId: b, sessionId: sid });
    expect(repo.listSessions().find((s) => s.id === sid)!.unfinishedBatchId).toBe(b);
    repo.setBatchStatus(b, 'applied');
    expect(repo.unfinishedBatch()).toBeUndefined();
    expect(repo.listSessions().find((s) => s.id === sid)!.unfinishedBatchId).toBeUndefined();
  });

  it('decision() reads one stored decision', () => {
    const b = repo.createBatch(sid, 1).id;
    expect(repo.decision(b, 't1')).toBeUndefined();
    repo.saveDecision(b, dec('t1', { status: 'applied', note: 'x' }));
    expect(repo.decision(b, 't1')).toEqual(dec('t1', { status: 'applied', note: 'x' }));
    repo.saveDecision(b, dec('t2'));
    expect(repo.decision(b, 't2')).toEqual(dec('t2'));
  });

  it('remembers the dry-run setting a batch started with', () => {
    expect(repo.loadBatch(repo.createBatch(sid, 1).id).dryRun).toBe(false);
    expect(repo.loadBatch(repo.createBatch(sid, 1, true).id).dryRun).toBe(true);
  });
});

it('adds the dry_run column to a database created before it existed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-sweep-repo-'));
  const path = join(dir, 'old.db');
  try {
    const old = new Database(path);
    old.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, started_at TEXT NOT NULL);
      CREATE TABLE batches (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
        batch_no INTEGER NOT NULL, total INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'running',
        current TEXT, created_at TEXT NOT NULL);
      INSERT INTO sessions VALUES ('s', '2026-10-01T00:00:00Z');
      INSERT INTO batches (id, session_id, batch_no, total, created_at) VALUES ('b', 's', 1, 0, '2026-10-01T00:00:00Z');`);
    old.close();
    const r = new Repo(path);
    expect(r.loadBatch('b').dryRun).toBe(false);
    expect(r.loadBatch(r.createBatch('s', 0, true).id).dryRun).toBe(true);
    r.close();
    const again = new Repo(path); // reopening is a no-op
    expect(again.loadBatch('b').dryRun).toBe(false);
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
