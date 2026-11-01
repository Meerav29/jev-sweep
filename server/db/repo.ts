import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_SETTINGS } from '../../shared/types';
import type { BatchStatus, Decision, Email, JevAnswers, QueueItem, SessionSummary, Settings } from '../../shared/types';
import type { CardText } from '../claude/cardText';

export type StoredEmail = Omit<Email, 'body'>;

export interface StoredCandidate { n: number; threadId: string; latestMessageId: string }

export interface LoadedBatch {
  sessionId: string; batchNo: number; total: number; status: BatchStatus; dryRun: boolean;
  /** The threads picked when the batch started, in batch order (n = position). Empty for batches older than the table. */
  candidates: StoredCandidate[];
  emails: { n: number; email: StoredEmail }[];
  jev: Record<string, JevAnswers>;
  text: Record<string, CardText>;
  decisions: Decision[];
  queue: QueueItem[];
  current: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, started_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
  batch_no INTEGER NOT NULL, total INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'running',
  current TEXT, created_at TEXT NOT NULL, dry_run INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS emails (
  batch_id TEXT NOT NULL REFERENCES batches(id), thread_id TEXT NOT NULL, n INTEGER NOT NULL,
  latest_message_id TEXT NOT NULL, from_name TEXT NOT NULL, from_address TEXT NOT NULL,
  subject TEXT NOT NULL, date TEXT NOT NULL, labels TEXT NOT NULL, unread INTEGER NOT NULL,
  PRIMARY KEY (batch_id, thread_id));
CREATE TABLE IF NOT EXISTS jev_answers (
  batch_id TEXT NOT NULL REFERENCES batches(id), thread_id TEXT NOT NULL, answers TEXT NOT NULL,
  PRIMARY KEY (batch_id, thread_id));
CREATE TABLE IF NOT EXISTS card_text (
  batch_id TEXT NOT NULL REFERENCES batches(id), thread_id TEXT NOT NULL, text TEXT NOT NULL,
  PRIMARY KEY (batch_id, thread_id));
CREATE TABLE IF NOT EXISTS decisions (
  batch_id TEXT NOT NULL REFERENCES batches(id), thread_id TEXT NOT NULL, n INTEGER NOT NULL,
  subject TEXT NOT NULL, from_name TEXT NOT NULL, dest TEXT NOT NULL, who TEXT NOT NULL,
  important INTEGER NOT NULL, star INTEGER NOT NULL, opened INTEGER NOT NULL,
  status TEXT NOT NULL, note TEXT,
  PRIMARY KEY (batch_id, thread_id));
CREATE TABLE IF NOT EXISTS queue_items (
  batch_id TEXT NOT NULL REFERENCES batches(id), position INTEGER NOT NULL, thread_id TEXT NOT NULL,
  n INTEGER NOT NULL, subject TEXT NOT NULL, important INTEGER NOT NULL,
  PRIMARY KEY (batch_id, position));
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS batch_candidates (
  batch_id TEXT NOT NULL REFERENCES batches(id), n INTEGER NOT NULL, thread_id TEXT NOT NULL,
  latest_message_id TEXT NOT NULL,
  PRIMARY KEY (batch_id, thread_id));
`;

function rowToDecision(r: any): Decision {
  const d: Decision = {
    threadId: r.thread_id, n: r.n, subject: r.subject, fromName: r.from_name, dest: r.dest, who: r.who,
    important: r.important === 1, star: r.star === 1, opened: r.opened === 1, status: r.status,
  };
  if (r.note !== null) d.note = r.note;
  return d;
}

export class Repo {
  private db: Database.Database;

  constructor(path: string) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new Database(path);
    if (path !== ':memory:') this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
    // Databases created before dry_run existed get the column (idempotent).
    const cols = this.db.prepare('PRAGMA table_info(batches)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'dry_run')) {
      this.db.exec('ALTER TABLE batches ADD COLUMN dry_run INTEGER NOT NULL DEFAULT 0');
    }
  }

  close(): void { this.db.close(); }

  createSession(): { id: string; startedAt: string } {
    const id = randomUUID();
    const startedAt = new Date().toISOString();
    this.db.prepare('INSERT INTO sessions (id, started_at) VALUES (?, ?)').run(id, startedAt);
    return { id, startedAt };
  }

  /** `dryRun` is the batch's starting dry-run setting; it sticks to the batch across resumes. */
  /** `candidates`, when given, are stored with the batch in one transaction (see saveCandidates). */
  createBatch(sessionId: string, total: number, dryRun = false,
    candidates: { threadId: string; latestMessageId: string }[] = []): { id: string; batchNo: number } {
    const id = randomUUID();
    let batchNo = 0;
    this.db.transaction(() => {
      const row = this.db.prepare('SELECT COALESCE(MAX(batch_no), 0) + 1 AS n FROM batches WHERE session_id = ?')
        .get(sessionId) as { n: number };
      batchNo = row.n;
      this.db.prepare('INSERT INTO batches (id, session_id, batch_no, total, status, created_at, dry_run) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, sessionId, row.n, total, 'running', new Date().toISOString(), dryRun ? 1 : 0);
      this.saveCandidates(id, candidates);
    })();
    return { id, batchNo };
  }

  setBatchStatus(batchId: string, s: BatchStatus): void {
    this.db.prepare('UPDATE batches SET status = ? WHERE id = ?').run(s, batchId);
  }

  batchStatus(batchId: string): BatchStatus | undefined {
    const r = this.db.prepare('SELECT status FROM batches WHERE id = ?').get(batchId) as { status: BatchStatus } | undefined;
    return r?.status;
  }

  /** The batch's thread list as picked at start, so a resume can fetch the ones it never got to. Idempotent. */
  saveCandidates(batchId: string, list: { threadId: string; latestMessageId: string }[]): void {
    const ins = this.db.prepare(
      'INSERT OR REPLACE INTO batch_candidates (batch_id, n, thread_id, latest_message_id) VALUES (?, ?, ?, ?)');
    this.db.transaction(() => { list.forEach((c, i) => ins.run(batchId, i + 1, c.threadId, c.latestMessageId)); })();
  }

  saveEmail(batchId: string, n: number, e: Email): void {
    this.db.prepare(`INSERT OR REPLACE INTO emails
      (batch_id, thread_id, n, latest_message_id, from_name, from_address, subject, date, labels, unread)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(batchId, e.threadId, n, e.latestMessageId, e.fromName, e.fromAddress, e.subject, e.date,
        JSON.stringify(e.labels), e.unread ? 1 : 0);
  }

  saveJev(batchId: string, threadId: string, a: JevAnswers): void {
    this.db.prepare('INSERT OR REPLACE INTO jev_answers (batch_id, thread_id, answers) VALUES (?, ?, ?)')
      .run(batchId, threadId, JSON.stringify(a));
  }

  saveCardText(batchId: string, threadId: string, t: CardText): void {
    this.db.prepare('INSERT OR REPLACE INTO card_text (batch_id, thread_id, text) VALUES (?, ?, ?)')
      .run(batchId, threadId, JSON.stringify(t));
  }

  saveDecision(batchId: string, d: Decision): void {
    this.db.prepare(`INSERT OR REPLACE INTO decisions
      (batch_id, thread_id, n, subject, from_name, dest, who, important, star, opened, status, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(batchId, d.threadId, d.n, d.subject, d.fromName, d.dest, d.who,
        d.important ? 1 : 0, d.star ? 1 : 0, d.opened ? 1 : 0, d.status, d.note ?? null);
  }

  /** One stored decision, or undefined. The repo is the truth once apply has written to it. */
  decision(batchId: string, threadId: string): Decision | undefined {
    const r = this.db.prepare('SELECT * FROM decisions WHERE batch_id = ? AND thread_id = ?').get(batchId, threadId);
    return r ? rowToDecision(r) : undefined;
  }

  deleteDecision(batchId: string, threadId: string): void {
    this.db.prepare('DELETE FROM decisions WHERE batch_id = ? AND thread_id = ?').run(batchId, threadId);
  }

  saveQueue(batchId: string, q: QueueItem[], current: string | null): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM queue_items WHERE batch_id = ?').run(batchId);
      const ins = this.db.prepare(
        'INSERT INTO queue_items (batch_id, position, thread_id, n, subject, important) VALUES (?, ?, ?, ?, ?, ?)');
      q.forEach((it, i) => ins.run(batchId, i, it.threadId, it.n, it.subject, it.important ? 1 : 0));
      this.db.prepare('UPDATE batches SET current = ? WHERE id = ?').run(current, batchId);
    });
    tx();
  }

  loadBatch(batchId: string): LoadedBatch {
    const b = this.db.prepare('SELECT * FROM batches WHERE id = ?').get(batchId) as
      { session_id: string; batch_no: number; total: number; status: BatchStatus; current: string | null; dry_run: number } | undefined;
    if (!b) throw new Error(`Unknown batch ${batchId}`);

    const emails = (this.db.prepare('SELECT * FROM emails WHERE batch_id = ? ORDER BY n').all(batchId) as any[])
      .map((r) => ({
        n: r.n as number,
        email: {
          threadId: r.thread_id, latestMessageId: r.latest_message_id, fromName: r.from_name,
          fromAddress: r.from_address, subject: r.subject, date: r.date,
          labels: JSON.parse(r.labels) as string[], unread: r.unread === 1,
        } satisfies StoredEmail,
      }));

    const candidates = (this.db.prepare('SELECT * FROM batch_candidates WHERE batch_id = ? ORDER BY n').all(batchId) as any[])
      .map((r): StoredCandidate => ({ n: r.n, threadId: r.thread_id, latestMessageId: r.latest_message_id }));

    const jev: Record<string, JevAnswers> = {};
    for (const r of this.db.prepare('SELECT thread_id, answers FROM jev_answers WHERE batch_id = ?').all(batchId) as any[]) {
      jev[r.thread_id] = JSON.parse(r.answers);
    }
    const text: Record<string, CardText> = {};
    for (const r of this.db.prepare('SELECT thread_id, text FROM card_text WHERE batch_id = ?').all(batchId) as any[]) {
      text[r.thread_id] = JSON.parse(r.text);
    }

    const decisions = (this.db.prepare('SELECT * FROM decisions WHERE batch_id = ? ORDER BY n').all(batchId) as any[])
      .map(rowToDecision);

    const queue = (this.db.prepare('SELECT * FROM queue_items WHERE batch_id = ? ORDER BY position').all(batchId) as any[])
      .map((r): QueueItem => ({ threadId: r.thread_id, n: r.n, subject: r.subject, important: r.important === 1 }));

    return {
      sessionId: b.session_id, batchNo: b.batch_no, total: b.total, status: b.status, dryRun: b.dry_run === 1,
      candidates, emails, jev, text, decisions, queue, current: b.current,
    };
  }

  /** threadId -> latestMessageId (from the most recent batch the thread appeared in). */
  excludedThreads(): Map<string, string> {
    const ids = new Set<string>();
    const add = (sql: string) => {
      for (const r of this.db.prepare(sql).all() as { thread_id: string }[]) ids.add(r.thread_id);
    };
    // A dry-run result in a finished (applied or discarded) batch changed nothing in Gmail, so it hides nothing.
    const real = `NOT (COALESCE(d.note, '') = 'dry run' AND b.status IN ('applied', 'discarded'))`;
    add(`SELECT d.thread_id FROM decisions d JOIN batches b ON b.id = d.batch_id WHERE b.status != 'discarded' AND ${real}`);
    add(`SELECT d.thread_id FROM decisions d JOIN batches b ON b.id = d.batch_id
      WHERE d.status IN ('auto_applied', 'applied') AND ${real}`);
    // Open batches keep all their emails, dry run or not, and the candidates they have yet to fetch.
    const open = `b.status IN ('running', 'reviewing', 'applying')`;
    add(`SELECT e.thread_id FROM emails e JOIN batches b ON b.id = e.batch_id WHERE ${open}`);
    add(`SELECT c.thread_id FROM batch_candidates c JOIN batches b ON b.id = c.batch_id WHERE ${open}`);

    // Later batches win; within a batch, the fetched email (sorted after its candidate row) wins.
    const out = new Map<string, string>();
    const rows = this.db.prepare(`
      SELECT thread_id, latest_message_id FROM (
        SELECT c.thread_id, c.latest_message_id, b.rowid AS br, 0 AS k FROM batch_candidates c JOIN batches b ON b.id = c.batch_id
        UNION ALL
        SELECT e.thread_id, e.latest_message_id, b.rowid AS br, 1 AS k FROM emails e JOIN batches b ON b.id = e.batch_id)
      ORDER BY br ASC, k ASC`,
    ).all() as { thread_id: string; latest_message_id: string }[];
    for (const r of rows) if (ids.has(r.thread_id)) out.set(r.thread_id, r.latest_message_id);
    return out;
  }

  unfinishedBatch(): { batchId: string; sessionId: string } | undefined {
    const r = this.db.prepare(
      `SELECT id, session_id FROM batches WHERE status IN ('running', 'reviewing', 'applying') ORDER BY rowid DESC LIMIT 1`,
    ).get() as { id: string; session_id: string } | undefined;
    return r ? { batchId: r.id, sessionId: r.session_id } : undefined;
  }

  listSessions(): SessionSummary[] {
    const sessions = this.db.prepare('SELECT id, started_at FROM sessions ORDER BY started_at DESC, rowid DESC')
      .all() as { id: string; started_at: string }[];
    const batchStmt = this.db.prepare(
      'SELECT COUNT(*) AS c, COALESCE(SUM(total), 0) AS t FROM batches WHERE session_id = ?');
    const splitStmt = this.db.prepare(`SELECT
        COALESCE(SUM(d.dest = 'archive'), 0) AS archived,
        COALESCE(SUM(d.dest LIKE 'label:%'), 0) AS filed,
        COALESCE(SUM(d.who = 'you'), 0) AS you,
        COALESCE(SUM(d.important = 1), 0) AS important
      FROM decisions d JOIN batches b ON b.id = d.batch_id
      WHERE b.session_id = ? AND b.status != 'discarded'`);
    const openStmt = this.db.prepare(
      `SELECT id FROM batches WHERE session_id = ? AND status IN ('running', 'reviewing', 'applying') ORDER BY rowid DESC LIMIT 1`);

    // What a past-session row opens: the newest batch that had emails, else the newest at all (never a discarded one).
    const lastStmt = this.db.prepare(
      `SELECT id FROM batches WHERE session_id = ? AND status != 'discarded' ORDER BY (total > 0) DESC, rowid DESC LIMIT 1`);

    // Judged by what the writes did, not the batch flag: dry run can be switched on mid-batch.
    const dryStmt = this.db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(d.note = 'dry run'), 0) AS d
      FROM decisions d JOIN batches b ON b.id = d.batch_id
      WHERE b.session_id = ? AND b.status != 'discarded' AND d.status IN ('applied', 'auto_applied')`);

    return sessions.map((s) => {
      const bt = batchStmt.get(s.id) as { c: number; t: number };
      const sp = splitStmt.get(s.id) as SessionSummary['split'];
      const open = openStmt.get(s.id) as { id: string } | undefined;
      const out: SessionSummary = {
        id: s.id, startedAt: s.started_at, batches: bt.c, total: bt.t,
        split: { archived: sp.archived, filed: sp.filed, you: sp.you, important: sp.important },
      };
      if (open) out.unfinishedBatchId = open.id;
      const last = lastStmt.get(s.id) as { id: string } | undefined;
      if (last) out.lastBatchId = last.id;
      const dry = dryStmt.get(s.id) as { n: number; d: number };
      if (dry.n > 0 && dry.d === dry.n) out.dryRun = true;
      else if (dry.d > 0) out.partlyDryRun = true;
      return out;
    });
  }

  getSettings(): Settings {
    const r = this.db.prepare(`SELECT value FROM settings WHERE key = 'settings'`).get() as { value: string } | undefined;
    const stored = (r ? JSON.parse(r.value) : {}) as Partial<Settings>;
    return {
      ...DEFAULT_SETTINGS,
      ...stored,
      thresholds: { ...DEFAULT_SETTINGS.thresholds, ...(stored.thresholds ?? {}) },
    };
  }

  saveSettings(patch: Partial<Settings>): Settings {
    const cur = this.getSettings();
    const next: Settings = {
      ...cur,
      ...patch,
      thresholds: { ...cur.thresholds, ...(patch.thresholds ?? {}) },
    };
    this.db.prepare(`INSERT INTO settings (key, value) VALUES ('settings', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(next));
    return next;
  }
}
