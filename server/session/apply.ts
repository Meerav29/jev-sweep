import type { Decision, Dest, Email, SessionEvent } from '../../shared/types';
import type { Repo, StoredEmail } from '../db/repo';
import type { MailProvider } from '../mail/provider';

export interface ApplyDeps {
  mail: MailProvider;
  repo: Repo;
  emit: (batchId: string, e: SessionEvent) => void;
}

export interface ApplyResult { applied: number; skipped: number; failed: number }

/** Apply's own failures carry this note prefix; only these are retried by a later apply. */
const FAIL_PREFIX = 'apply: ';
/**
 * Progress markers written after the prefix of a failure note, so a retry knows where the last attempt stopped:
 * `(undo) ` = the decision was undoing an auto-archive; `(archived) ` = the archive step had already happened.
 * They are bookkeeping only and never shown in error events.
 */
const UNDO_MARK = '(undo) ';
const ARCHIVED_MARK = '(archived) ';
const CHANGED = 'changed in Gmail';
const DRY_RUN = 'dry run';

/** Batches with an apply in progress in this process: a second call gets the same run, never a second one. */
const running = new Map<string, Promise<ApplyResult>>();

const errMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

const isRetry = (d: Decision) => d.status === 'failed' && !!d.note?.startsWith(FAIL_PREFIX);

/** What an earlier failed attempt recorded about itself (all false for a first attempt). */
function progressOf(d: Decision): { undo: boolean; archived: boolean } {
  if (!isRetry(d)) return { undo: false, archived: false };
  let rest = d.note!.slice(FAIL_PREFIX.length);
  const undo = rest.startsWith(UNDO_MARK);
  if (undo) rest = rest.slice(UNDO_MARK.length);
  return { undo, archived: rest.startsWith(ARCHIVED_MARK) };
}

/** A moved auto-archive whose archive really happened in Gmail (a 'dry run' note means it never did). */
const isUndo = (d: Decision) => (d.status === 'auto_applied' && d.note !== DRY_RUN) || progressOf(d).undo;

/** proposed; auto_applied moved off archive on the board; apply's own earlier failures. Nothing else is touched. */
function processable(d: Decision): boolean {
  if (d.status === 'proposed') return true;
  if (d.status === 'auto_applied') return d.dest !== 'archive';
  return isRetry(d);
}

const folderOf = (dest: Dest) => (dest.startsWith('label:') ? dest.slice('label:'.length) : null);

function stepLabel(dest: Dest, count: number): string {
  if (dest === 'archive') return `Archiving ${count} ${count === 1 ? 'thread' : 'threads'}`;
  if (dest === 'keep') return `Leaving ${count} in inbox`;
  return `Labeling ${count} → ${folderOf(dest)} and archiving`;
}

/** archive first, then label groups alphabetically by folder, then keep. */
function groupOrder(a: Dest, b: Dest): number {
  const rank = (d: Dest) => (d === 'archive' ? 0 : d === 'keep' ? 2 : 1);
  return rank(a) - rank(b) || a.localeCompare(b);
}

/**
 * Performs the approved Gmail changes for a reviewed batch (spec 6.2 step 7, read state per 6.6).
 * Every thread is re-checked first; nothing already applied is processed again; dry run makes no Gmail calls.
 */
export function applyBatch(deps: ApplyDeps, batchId: string): Promise<ApplyResult> {
  const inFlight = running.get(batchId);
  if (inFlight) return inFlight;
  const run = doApply(deps, batchId).finally(() => { running.delete(batchId); });
  running.set(batchId, run);
  return run;
}

async function doApply(deps: ApplyDeps, batchId: string): Promise<ApplyResult> {
  const { repo, emit } = deps;
  const lb = repo.loadBatch(batchId);
  // 'applying' is allowed so a batch left mid-apply (a crash) can be finished; 'applied' just finds nothing to do.
  if (lb.status === 'running' || lb.status === 'discarded') {
    throw new Error(`Batch ${batchId} is ${lb.status}; only a reviewed batch can be applied`);
  }
  const emails = new Map(lb.emails.map(({ email }) => [email.threadId, email]));
  const groups = new Map<Dest, Decision[]>();
  for (const d of lb.decisions) {
    if (!processable(d)) continue;
    groups.set(d.dest, [...(groups.get(d.dest) ?? []), d]);
  }

  const result: ApplyResult = { applied: 0, skipped: 0, failed: 0 };
  repo.setBatchStatus(batchId, 'applying');
  emit(batchId, { type: 'status', status: 'applying' });
  try {
    for (const dest of [...groups.keys()].sort(groupOrder)) {
      const list = groups.get(dest)!;
      const label = stepLabel(dest, list.length);
      emit(batchId, { type: 'apply_step', label, count: list.length, done: false });
      for (const d of list) {
        // Checked before every thread: the batch's own setting, or dry run switched on since.
        const dry = lb.dryRun || repo.getSettings().dryRun;
        const { decision: next, error } = dry
          ? { decision: done(d, 'applied', DRY_RUN), error: undefined }
          : await applyOne(deps, d, emails.get(d.threadId));
        result[next.status === 'applied' ? 'applied' : next.status === 'skipped' ? 'skipped' : 'failed']++;
        repo.saveDecision(batchId, next);
        emit(batchId, { type: 'decided', decision: structuredClone(next) });
        // The raw error only: progress markers in the stored note are bookkeeping, not for people.
        if (error !== undefined) emit(batchId, { type: 'error', message: `Applying "${d.subject}" failed: ${error}` });
      }
      emit(batchId, { type: 'apply_step', label, count: list.length, done: true });
    }
  } catch (e) {
    // Never leave the batch stuck in 'applying': back to reviewing so Apply can be tried again.
    try { repo.setBatchStatus(batchId, 'reviewing'); } catch { /* the error below still reports it */ }
    emit(batchId, { type: 'status', status: 'reviewing' });
    emit(batchId, { type: 'error', message: `Apply stopped: ${errMessage(e)}` });
    throw e;
  }

  // A failure keeps the batch reviewable so Apply can be retried; skips are final.
  const final = result.failed > 0 ? 'reviewing' : 'applied';
  repo.setBatchStatus(batchId, final);
  emit(batchId, { type: 'status', status: final });
  return result;
}

function done(d: Decision, status: 'applied' | 'skipped' | 'failed', note?: string): Decision {
  const out: Decision = { ...d, status };
  delete out.note;
  if (note !== undefined) out.note = note;
  return out;
}

interface Outcome { decision: Decision; error?: string }

/** Re-checks one thread, then writes: (unarchive) → label → archive → mark read → star. */
async function applyOne(deps: ApplyDeps, d: Decision, stored: StoredEmail | undefined): Promise<Outcome> {
  const { mail } = deps;
  const undo = isUndo(d);
  const retry = isRetry(d);
  const { archived } = progressOf(d);
  let archivedNow = archived;
  const fail = (e: unknown): Outcome => {
    const message = errMessage(e);
    const marks = (undo ? UNDO_MARK : '') + (archivedNow ? ARCHIVED_MARK : '');
    return { decision: done(d, 'failed', FAIL_PREFIX + marks + message), error: message };
  };
  const skip = (): Outcome => ({ decision: done(d, 'skipped', CHANGED) });

  let fresh: Email | null;
  try {
    fresh = await mail.getThread(d.threadId);
  } catch (e) {
    return fail(e);
  }
  if (!fresh || !stored || fresh.latestMessageId !== stored.latestMessageId) return skip();

  let inInbox = fresh.labels.includes('INBOX');
  if (archived) {
    // The last attempt got as far as archiving: back in the inbox means someone moved it.
    if (inInbox) return skip();
  } else if (undo) {
    // First attempt: an auto-archive being undone must still be out of the inbox. On a retry our own unarchive
    // may already have happened, so either place is one this decision can finish from.
    if (!retry && inInbox) return skip();
  } else if (!inInbox) {
    // A proposal (first try or retry before its archive step) must still be in the inbox.
    return skip();
  }

  const folder = folderOf(d.dest);
  const leaves = d.dest !== 'keep';
  try {
    if (!archived) {
      if (undo && !inInbox) {
        await mail.unarchive(d.threadId);
        inInbox = true;
      }
      if (folder !== null) await mail.addLabel(d.threadId, folder);
      if (leaves) {
        await mail.archive(d.threadId);
        archivedNow = true;
      }
    }
    if (leaves || d.opened) await mail.markRead(d.threadId);
    if (d.star) await mail.star(d.threadId);
  } catch (e) {
    return fail(e);
  }
  return { decision: done(d, 'applied') };
}
