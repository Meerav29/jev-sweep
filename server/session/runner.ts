import { NOUL_IDS } from '../../shared/types';
import type {
  BatchStatus, BatchView, CardSpec, Decision, Dest, Email, JevAnswers, NoulId, Outcome, QueueItem, SessionEvent, Settings,
} from '../../shared/types';
import type { JevClient } from '../jev/client';
import { ageDays } from '../jev/questions';
import { decide } from '../policy/decide';
import { toCard } from '../cards/toCard';
import { withTimeout } from '../claude/cardText';
import type { CardText, CardTextWriter } from '../claude/cardText';
import type { Repo } from '../db/repo';
import type { MailProvider } from '../mail/provider';
import { ReviewQueue } from './queue';

type QueueOutcome = Extract<Outcome, { kind: 'queue' }>;

/** Full thread fetches (getThread) in flight per batch while it streams in from Gmail. */
export const FETCH_CONCURRENCY = 8;

/** Subject shown for a thread that never made it out of Gmail (gone, or its fetch failed). */
const UNFETCHED_SUBJECT = '(not fetched from Gmail)';

export interface RunnerDeps {
  mail: MailProvider;
  jev: JevClient;
  writer: CardTextWriter;
  repo: Repo;
  emit: (batchId: string, e: SessionEvent) => void;
  concurrency: number;
  now?: () => Date;
  /** Card text slower than this is dropped and the card shows without it (spec 6.5). */
  cardTextTimeoutMs?: number;
}

/** Everything the runner knows about one batch. Bodies live only here, never in SQLite. */
interface BatchState {
  batchId: string;
  sessionId: string;
  batchNo: number;
  total: number;
  status: BatchStatus;
  paused: boolean;
  /** Dry run as of the batch's start; sticky across resumes (a live setting can still switch it on). */
  dryRun: boolean;
  settings: Settings;
  /** Every thread picked for the batch, with its position. Emails arrive for them as their full fetch finishes. */
  candidates: Map<string, number>;
  /** Candidates still to fetch in full, in batch order; `fetchCursor` is the next one. */
  toFetch: string[];
  fetchCursor: number;
  /** Full fetches running now. */
  fetching: number;
  /** Candidates whose full fetch has finished (fetched, gone or failed). */
  fetched: number;
  emails: Map<string, { n: number; email: Email }>;
  /** Threads whose body still has to be re-fetched with getThread (resumed batches only). */
  needsBody: Set<string>;
  jev: Map<string, JevAnswers>;
  outcomes: Map<string, QueueOutcome>;
  text: Map<string, CardText>;
  decisions: Map<string, Decision>;
  /** Threads Jev has finished with (answered, or skipped because they changed in Gmail). `read` = its size. */
  done: Set<string>;
  /** Threads the pool still has to process, in batch order; `cursor` is the next one. */
  pending: string[];
  cursor: number;
  queue: ReviewQueue;
  current: CardSpec | null;
  currentItem: QueueItem | null;
  workers: number;
  /** Jev workers and card-text writes still running; idle() waits on these. */
  inFlight: Set<Promise<void>>;
}

/** Answers used when Jev fails for an email: decide() sends them to a filing card with no options. */
export function failedAnswers(): JevAnswers {
  const nouls = Object.fromEntries(NOUL_IDS.map((k) => [k, 0])) as Record<NoulId, number>;
  return { failed: true, destination: { choice: 'keep', confidence: 0, probabilities: {} }, nouls };
}

function outranks(a: QueueItem, b: QueueItem): boolean {
  return a.important !== b.important ? a.important : a.n < b.n;
}

/** Where a browser mirroring `queued` events inserts an item: before the first item it outranks. */
function mirrorInsert(list: QueueItem[], item: QueueItem): QueueItem[] {
  const at = list.findIndex((q) => outranks(item, q));
  const out = [...list];
  out.splice(at === -1 ? out.length : at, 0, item);
  return out;
}

const sameOrder = (a: QueueItem[], b: QueueItem[]) => a.length === b.length && a.every((x, i) => x.threadId === b[i].threadId);

/** Rebuilds a ReviewQueue whose list() is exactly `items`: the shortest prefix that breaks priority order is pinned. */
function restoreQueue(items: QueueItem[]): ReviewQueue {
  let start = items.length - 1; // `rest` is the longest suffix already in priority order
  while (start > 0 && !outranks(items[start], items[start - 1])) start--;
  if (start < 0) start = 0;
  const q = new ReviewQueue(items.slice(start));
  for (let i = start - 1; i >= 0; i--) q.unshift(items[i]);
  return q;
}

const errMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The batch loop (spec 6.2): stream the emails in from Gmail, ask Jev about each email in a small pool, act on each policy outcome,
 * and keep a review queue the human works through while Jev carries on.
 * Every state change is persisted and emitted, so view() equals what a client builds from snapshot + events.
 */
export class BatchRunner {
  private readonly batches = new Map<string, BatchState>();
  private readonly writer: CardTextWriter;
  private readonly now: () => Date;

  constructor(private readonly deps: RunnerDeps) {
    this.writer = withTimeout(deps.writer, deps.cardTextTimeoutMs ?? 4000);
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Lists the batch's threads (message ids only), creates the batch and returns its id. The full fetches and
   * Jev run on in the background: each email joins the Jev pool the moment Gmail returns it.
   */
  async start(sessionId: string): Promise<string> {
    const { repo, mail } = this.deps;
    const settings = repo.getSettings();
    const candidates = await mail.listCandidates(settings.query, settings.batchSize, repo.excludedThreads());
    const { id, batchNo } = repo.createBatch(sessionId, candidates.length, settings.dryRun, candidates);
    const s = this.newState(id, sessionId, batchNo, candidates.length, settings);
    candidates.forEach((c, i) => {
      s.candidates.set(c.threadId, i + 1);
      s.toFetch.push(c.threadId);
    });
    this.batches.set(id, s);
    this.emit(s, { type: 'snapshot', view: this.view(id) });
    this.spawnFetch(s);
    this.checkDone(s); // nothing to fetch: straight to applied
    return id;
  }

  async resume(batchId: string): Promise<void> {
    const existing = this.batches.get(batchId);
    if (existing) {
      this.emit(existing, { type: 'snapshot', view: this.view(batchId) });
      return;
    }
    const { repo, mail } = this.deps;
    const lb = repo.loadBatch(batchId);
    const s = this.newState(batchId, lb.sessionId, lb.batchNo, lb.total, repo.getSettings());
    s.status = lb.status;
    s.dryRun = lb.dryRun;
    for (const { n, email } of lb.emails) s.emails.set(email.threadId, { n, email: { ...email, body: '' } });
    for (const [t, a] of Object.entries(lb.jev)) s.jev.set(t, a);
    for (const [t, x] of Object.entries(lb.text)) s.text.set(t, x);
    for (const d of lb.decisions) s.decisions.set(d.threadId, d);
    // Batches from before the candidate list was stored fetched everything up front: their emails are the list.
    const candidates = lb.candidates.length > 0 ? lb.candidates : lb.emails.map(({ n, email }) => ({ n, threadId: email.threadId }));
    for (const c of candidates) s.candidates.set(c.threadId, c.n);
    // A crash mid-fetch: candidates with neither an email nor a decision are fetched again.
    for (const c of candidates) if (!s.emails.has(c.threadId) && !s.decisions.has(c.threadId)) s.toFetch.push(c.threadId);
    s.fetched = s.candidates.size - s.toFetch.length;
    s.queue = restoreQueue(lb.queue.filter((q) => s.emails.has(q.threadId)));

    // Queued and current cards need their body again (it is never stored). Gone or changed in Gmail → skipped.
    const resumeErrors: string[] = [];
    const shown = [...(lb.current ? [lb.current] : []), ...s.queue.list().map((q) => q.threadId)];
    for (const t of shown) {
      let fresh: Email | null;
      try {
        fresh = await mail.getThread(t);
      } catch (e) {
        s.queue.take(t);
        resumeErrors.push(this.fail(s, t, e, false));
        continue;
      }
      const a = s.jev.get(t);
      if (!fresh || !a || this.changed(s, t, fresh)) {
        s.queue.take(t);
        this.skip(s, t, false);
        continue;
      }
      this.setBody(s, t, fresh);
      const o = decide(a, ageDays(fresh.date, this.now()), s.settings.thresholds);
      const item = s.queue.list().find((q) => q.threadId === t);
      const important = item ? item.important : o.kind === 'queue' && o.card === 'important';
      s.outcomes.set(t, { kind: 'queue', card: important ? 'important' : 'filing', suggestKeep: o.kind === 'queue' && o.suggestKeep });
    }
    const cur = lb.current;
    if (cur && s.emails.has(cur) && !s.decisions.has(cur) && s.outcomes.has(cur)) {
      const { n, email } = s.emails.get(cur)!;
      s.currentItem = { threadId: cur, n, subject: email.subject, important: s.outcomes.get(cur)!.card === 'important' };
      s.current = this.buildCard(s, cur);
    }

    // Emails Jev never answered, or answered but never acted on (a crash in between), go back to the pool.
    for (const { email } of lb.emails) {
      const t = email.threadId;
      if (s.decisions.has(t) || s.queue.has(t) || s.currentItem?.threadId === t) continue;
      s.pending.push(t);
      s.needsBody.add(t);
    }
    // Done = decided, queued or current. Threads back in the pool (answered or not), or still to fetch,
    // become done only once processed.
    const notDone = new Set([...s.pending, ...s.toFetch]);
    for (const t of new Set([...s.candidates.keys(), ...s.emails.keys()])) if (!notDone.has(t)) s.done.add(t);

    this.batches.set(batchId, s);
    if (s.status === 'running' || s.status === 'reviewing') this.persistQueue(s);
    this.emit(s, { type: 'snapshot', view: this.view(batchId) });
    for (const message of resumeErrors) this.emit(s, { type: 'error', message });
    if (s.status === 'running') {
      this.advance(s);
      this.spawn(s);
      this.spawnFetch(s);
      this.checkDone(s);
    }
  }

  pause(batchId: string): void {
    const s = this.get(batchId);
    if (!s || s.paused) return;
    s.paused = true;
    this.emitProgress(s);
  }

  continue(batchId: string): void {
    const s = this.get(batchId);
    if (!s || !s.paused) return;
    s.paused = false;
    this.emitProgress(s);
    this.spawn(s);
    this.spawnFetch(s);
  }

  resolve(batchId: string, threadId: string, dest: Dest, opts?: { star?: boolean }): void {
    const s = this.get(batchId);
    if (!s) return;
    const isCurrent = s.current?.threadId === threadId;
    if (!isCurrent && !s.queue.has(threadId)) return; // unknown or already answered: idempotent
    const kind = isCurrent ? s.current!.kind : (s.outcomes.get(threadId)?.card ?? 'filing');
    const { n, email } = s.emails.get(threadId)!;
    if (!isCurrent) s.queue.take(threadId);
    this.setDecision(s, {
      threadId, n, subject: email.subject, fromName: email.fromName, dest, who: 'you',
      important: kind === 'important', star: opts?.star ?? false, opened: kind === 'important', status: 'proposed',
    });
    if (isCurrent) this.clearCurrent(s);
    else this.persistQueue(s);
    this.checkDone(s);
  }

  jumpTo(batchId: string, threadId: string): void {
    const s = this.get(batchId);
    if (!s || s.current?.threadId === threadId || !s.queue.has(threadId)) return;
    if (s.currentItem) s.queue.unshift(s.currentItem);
    s.currentItem = s.queue.take(threadId)!;
    s.current = this.buildCard(s, threadId);
    this.persistQueue(s);
    // A reorder has no event of its own; a snapshot keeps clients exact.
    this.emit(s, { type: 'snapshot', view: this.view(batchId) });
  }

  /** Board drag: records a human decision. Never writes to Gmail (apply does that). */
  move(batchId: string, threadId: string, dest: Dest): void {
    const s = this.get(batchId);
    if (!s || (s.status !== 'running' && s.status !== 'reviewing')) return;
    // Apply runs outside the runner: the repo's status is the truth while (or after) it runs.
    const stored = this.deps.repo.batchStatus(batchId);
    if (stored === 'applying' || stored === 'applied') return;
    const entry = s.emails.get(threadId);
    if (!entry) return;
    // Apply writes decisions straight to the repo, so in-memory ones can be stale: the stored one wins.
    const existing = this.deps.repo.decision(batchId, threadId) ?? s.decisions.get(threadId);
    // Skipped/failed threads aren't safe to re-propose blind; applied ones are already done in Gmail.
    if (existing && (existing.status === 'skipped' || existing.status === 'failed' || existing.status === 'applied')) return;
    if (existing?.status === 'auto_applied') {
      // Moving an auto-archive records the new dest only; apply undoes it in Gmail. Back to 'archive' = nothing to apply.
      // The status (and a 'dry run' note, which says the archive never happened) stay for apply to read.
      this.setDecision(s, { ...existing, dest, who: 'you' });
      return;
    }
    const isCurrent = s.current?.threadId === threadId;
    const item = isCurrent ? s.currentItem : s.queue.take(threadId) ?? null;
    const d: Decision = existing
      ? { ...existing, dest, who: 'you', status: 'proposed' }
      : {
        threadId, n: entry.n, subject: entry.email.subject, fromName: entry.email.fromName, dest, who: 'you',
        important: item?.important ?? false, star: false, opened: false, status: 'proposed',
      };
    delete d.note;
    this.setDecision(s, d);
    if (isCurrent) this.clearCurrent(s);
    else if (item) this.persistQueue(s);
    this.checkDone(s);
  }

  /** Reloads decisions and status from the repo (apply writes them there) and sends clients a snapshot. */
  refresh(batchId: string): void {
    const s = this.get(batchId);
    if (!s) return;
    const lb = this.deps.repo.loadBatch(batchId);
    s.status = lb.status;
    s.decisions = new Map(lb.decisions.map((d) => [d.threadId, d]));
    this.emit(s, { type: 'snapshot', view: this.view(batchId) });
  }

  /** Whether this runner holds the batch in memory (started or resumed since the server came up). */
  has(batchId: string): boolean {
    return this.batches.has(batchId);
  }

  view(batchId: string): BatchView {
    const s = this.get(batchId);
    if (!s) throw new Error(`Unknown batch ${batchId}`);
    return structuredClone({
      sessionId: s.sessionId, batchId: s.batchId, batchNo: s.batchNo, total: s.total, read: s.done.size, fetched: s.fetched,
      status: s.status, paused: s.paused, dryRun: s.dryRun,
      decisions: [...s.decisions.values()].sort((a, b) => a.n - b.n),
      queue: s.queue.list(), current: s.current,
    });
  }

  /** Resolves once no Gmail fetch, Jev call or card-text write is in flight for the batch (or for every batch). */
  async idle(batchId?: string): Promise<void> {
    const states = batchId ? [this.get(batchId)].filter((x): x is BatchState => !!x) : [...this.batches.values()];
    for (;;) {
      const all = states.flatMap((s) => [...s.inFlight]);
      if (all.length === 0) return;
      await Promise.allSettled(all);
    }
  }

  // ---- fetch pool ----

  /** Pause holds new fetches as well as new Jev calls; the ones in flight finish. */
  private spawnFetch(s: BatchState): void {
    while (s.fetching < FETCH_CONCURRENCY && !s.paused && s.status === 'running' && s.fetchCursor < s.toFetch.length) {
      const t = s.toFetch[s.fetchCursor++];
      s.fetching++;
      this.track(s, this.fetchOne(s, t).finally(() => {
        s.fetching--;
        this.spawnFetch(s);
      }));
    }
  }

  /** One full fetch: the email is saved and joins the Jev pool. Gone in Gmail: skipped. A throw: failed. */
  private async fetchOne(s: BatchState, t: string): Promise<void> {
    let counted = false;
    try {
      const email = await this.deps.mail.getThread(t);
      if (s.status !== 'running') return; // discarded or applied while the fetch was in flight: write nothing
      counted = true;
      s.fetched++;
      if (!email) this.skip(s, t, true);
      else {
        const n = s.candidates.get(t)!;
        this.deps.repo.saveEmail(s.batchId, n, email);
        s.emails.set(t, { n, email });
        s.pending.push(t);
      }
    } catch (e) {
      if (!counted) s.fetched++;
      this.fail(s, t, e, true);
    }
    this.emitProgress(s);
    this.spawn(s);
    this.checkDone(s);
  }

  // ---- jev pool ----

  private spawn(s: BatchState): void {
    while (s.workers < this.deps.concurrency && !s.paused && s.status === 'running' && s.cursor < s.pending.length) {
      s.workers++;
      this.track(s, this.work(s).finally(() => { s.workers--; }));
    }
  }

  private async work(s: BatchState): Promise<void> {
    while (!s.paused && s.status === 'running' && s.cursor < s.pending.length) {
      const t = s.pending[s.cursor++];
      try {
        await this.process(s, t);
      } catch (e) {
        this.fail(s, t, e, true);
        this.emitProgress(s);
        this.checkDone(s);
      }
    }
  }

  private async process(s: BatchState, t: string): Promise<void> {
    const { repo, jev, mail } = this.deps;
    if (s.needsBody.has(t)) {
      s.needsBody.delete(t);
      const fresh = await mail.getThread(t);
      // A stored answer is about the message Jev saw; if the thread moved on (or vanished), don't act on it.
      if (!fresh || (s.jev.has(t) && this.changed(s, t, fresh))) {
        this.skip(s, t, true);
        this.emitProgress(s);
        this.checkDone(s);
        return;
      }
      if (s.jev.has(t)) this.setBody(s, t, fresh);
      else this.replaceEmail(s, t, fresh); // Jev will see the fresh thread, so store what it saw
    }
    const { n, email } = s.emails.get(t)!;
    let a = s.jev.get(t);
    if (!a) {
      try {
        a = await jev.ask(email, s.settings.folders);
      } catch {
        a = failedAnswers();
      }
      repo.saveJev(s.batchId, t, a);
      s.jev.set(t, a);
    }
    // A board drag may already have decided this thread while Jev was thinking; the human wins.
    if (!s.decisions.has(t)) await this.act(s, n, email, a);
    // Done only once act() (and any archive write in it) has finished, so checkDone can't fire mid-write.
    s.done.add(t);
    this.emitProgress(s);
    this.checkDone(s);
  }

  private async act(s: BatchState, n: number, email: Email, a: JevAnswers): Promise<void> {
    const outcome = decide(a, ageDays(email.date, this.now()), s.settings.thresholds);
    const base = { threadId: email.threadId, n, subject: email.subject, fromName: email.fromName, who: 'jev' as const,
      important: false, star: false, opened: false };
    if (outcome.kind === 'auto_archive') {
      const d: Decision = { ...base, dest: 'archive', status: 'auto_applied' };
      // Checked right before the write: the batch's own setting, or dry run switched on since it started.
      if (s.dryRun || this.deps.repo.getSettings().dryRun) d.note = 'dry run';
      else {
        try {
          await this.deps.mail.archive(email.threadId);
        } catch (e) {
          d.status = 'failed';
          d.note = errMessage(e);
          this.emit(s, { type: 'error', message: `Archiving "${email.subject}" failed: ${d.note}` });
        }
      }
      this.setDecision(s, d);
      return;
    }
    if (outcome.kind === 'proposed') {
      this.setDecision(s, { ...base, dest: outcome.dest, status: 'proposed' });
      return;
    }
    const item: QueueItem = { threadId: email.threadId, n, subject: email.subject, important: outcome.card === 'important' };
    s.outcomes.set(email.threadId, outcome);
    const before = s.queue.list();
    s.queue.push(item);
    this.persistQueue(s);
    if (sameOrder(mirrorInsert(before, item), s.queue.list())) this.emit(s, { type: 'queued', item });
    else this.emit(s, { type: 'snapshot', view: this.view(s.batchId) }); // pinned items ahead: not expressible as `queued`
    this.writeCardText(s, email, a, outcome.card);
    this.advance(s);
  }

  // ---- queue and cards ----

  private writeCardText(s: BatchState, email: Email, a: JevAnswers, kind: 'filing' | 'important'): void {
    const t = email.threadId;
    this.track(s, this.writer.write(email, a, kind).then((text) => {
      this.deps.repo.saveCardText(s.batchId, t, text);
      s.text.set(t, text);
      this.emit(s, { type: 'card_text', threadId: t, why: text.why, summary: text.summary });
      if (s.current?.threadId === t) {
        s.current = this.buildCard(s, t);
        this.emit(s, { type: 'current', card: s.current });
      }
      this.advance(s);
    }).catch((e: unknown) => {
      this.emit(s, { type: 'error', message: `Card text for "${email.subject}" failed: ${errMessage(e)}` });
    }));
  }

  /** If nothing is current, the head of the queue becomes the current card. */
  private advance(s: BatchState): boolean {
    if (s.current || s.queue.size === 0) return false;
    const item = s.queue.shift()!;
    s.currentItem = item;
    s.current = this.buildCard(s, item.threadId);
    this.persistQueue(s);
    this.emit(s, { type: 'current', card: s.current });
    return true;
  }

  private clearCurrent(s: BatchState): void {
    s.current = null;
    s.currentItem = null;
    if (!this.advance(s)) {
      this.persistQueue(s);
      this.emit(s, { type: 'current', card: null });
    }
  }

  private buildCard(s: BatchState, t: string): CardSpec {
    const { n, email } = s.emails.get(t)!;
    const outcome = s.outcomes.get(t) ?? { kind: 'queue', card: 'filing', suggestKeep: false };
    return toCard(email, n, s.jev.get(t) ?? failedAnswers(), outcome, s.text.get(t) ?? {});
  }

  private checkDone(s: BatchState): void {
    if (s.status !== 'running' || s.done.size < s.total || s.current || s.queue.size > 0) return;
    // A batch that fetched nothing has nothing to review or apply: it is finished, not left open.
    const next = s.total === 0 ? 'applied' : 'reviewing';
    s.status = next;
    this.deps.repo.setBatchStatus(s.batchId, next);
    this.emit(s, { type: 'status', status: next });
  }

  // ---- helpers ----

  /** Position, subject and sender for a decision: from the email, or placeholders if it was never fetched. */
  private meta(s: BatchState, t: string): { n: number; subject: string; fromName: string } | undefined {
    const entry = s.emails.get(t);
    if (entry) return { n: entry.n, subject: entry.email.subject, fromName: entry.email.fromName };
    const n = s.candidates.get(t);
    return n === undefined ? undefined : { n, subject: UNFETCHED_SUBJECT, fromName: '' };
  }

  private skip(s: BatchState, t: string, emit: boolean): void {
    const { n, subject, fromName } = this.meta(s, t)!;
    const d: Decision = { threadId: t, n, subject, fromName, dest: 'keep', who: 'jev',
      important: false, star: false, opened: false, status: 'skipped', note: 'changed in Gmail' };
    s.done.add(t);
    if (emit) this.setDecision(s, d);
    else { s.decisions.set(t, d); this.deps.repo.saveDecision(s.batchId, d); }
  }

  /** An unexpected throw for one thread: fail that thread so the batch can still finish (never stuck in running). */
  private fail(s: BatchState, t: string, e: unknown, emit: boolean): string {
    const m = this.meta(s, t);
    const message = `Processing "${s.emails.get(t)?.email.subject ?? t}" failed: ${errMessage(e)}`;
    s.done.add(t);
    if (m) {
      const d: Decision = { threadId: t, n: m.n, subject: m.subject, fromName: m.fromName, dest: 'keep', who: 'jev',
        important: false, star: false, opened: false, status: 'failed', note: errMessage(e) };
      s.decisions.set(t, d);
      try { this.deps.repo.saveDecision(s.batchId, d); } catch { /* the error event below still reports it */ }
      if (emit) this.emit(s, { type: 'decided', decision: structuredClone(d) });
      // A decided thread can't stay on the review queue (clients drop it on `decided`).
      if (s.queue.take(t)) this.persistQueueSafe(s);
      if (s.current?.threadId === t) this.clearCurrent(s);
    }
    if (emit) this.emit(s, { type: 'error', message });
    return message;
  }

  private persistQueueSafe(s: BatchState): void {
    try { this.persistQueue(s); } catch { /* best effort while already handling an error */ }
  }

  private changed(s: BatchState, t: string, fresh: Email): boolean {
    return fresh.latestMessageId !== s.emails.get(t)!.email.latestMessageId;
  }

  private replaceEmail(s: BatchState, t: string, fresh: Email): void {
    const entry = s.emails.get(t)!;
    entry.email = { ...fresh };
    this.deps.repo.saveEmail(s.batchId, entry.n, fresh);
  }

  private setBody(s: BatchState, t: string, fresh: Email): void {
    const entry = s.emails.get(t)!;
    entry.email = { ...entry.email, body: fresh.body };
  }

  private setDecision(s: BatchState, d: Decision): void {
    s.decisions.set(d.threadId, d);
    this.deps.repo.saveDecision(s.batchId, d);
    this.emit(s, { type: 'decided', decision: structuredClone(d) });
  }

  private persistQueue(s: BatchState): void {
    this.deps.repo.saveQueue(s.batchId, s.queue.list(), s.current?.threadId ?? null);
  }

  private emitProgress(s: BatchState): void {
    this.emit(s, { type: 'progress', read: s.done.size, fetched: s.fetched, total: s.total, paused: s.paused });
  }

  private emit(s: BatchState, e: SessionEvent): void {
    this.deps.emit(s.batchId, e);
  }

  private track(s: BatchState, p: Promise<void>): void {
    s.inFlight.add(p);
    void p.then(
      () => { s.inFlight.delete(p); },
      (e: unknown) => {
        s.inFlight.delete(p);
        this.emit(s, { type: 'error', message: errMessage(e) });
      },
    );
  }

  private get(batchId: string): BatchState | undefined {
    return this.batches.get(batchId);
  }

  private newState(batchId: string, sessionId: string, batchNo: number, total: number, settings: Settings): BatchState {
    return {
      batchId, sessionId, batchNo, total, status: 'running', paused: false, dryRun: settings.dryRun, settings,
      candidates: new Map(), toFetch: [], fetchCursor: 0, fetching: 0, fetched: 0,
      emails: new Map(), needsBody: new Set(), jev: new Map(), outcomes: new Map(), text: new Map(),
      decisions: new Map(), done: new Set(), pending: [], cursor: 0, queue: new ReviewQueue(),
      current: null, currentItem: null, workers: 0, inFlight: new Set(),
    };
  }
}
