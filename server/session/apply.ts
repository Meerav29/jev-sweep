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
/** Marks a failure while undoing an auto-archive, so a retry knows the thread may still need unarchiving. */
const UNDO_FAIL_PREFIX = `${FAIL_PREFIX}(undo) `;
const CHANGED = 'changed in Gmail';
const DRY_RUN = 'dry run';

/** Batches with an apply in progress in this process: a second call gets the same run, never a second one. */
const running = new Map<string, Promise<ApplyResult>>();

const errMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A moved auto-archive whose archive really happened in Gmail (a 'dry run' note means it never did). */
const isUndo = (d: Decision) =>
  (d.status === 'auto_applied' && d.note !== DRY_RUN) ||
  (d.status === 'failed' && !!d.note?.startsWith(UNDO_FAIL_PREFIX));

const isRetry = (d: Decision) => d.status === 'failed' && !!d.note?.startsWith(FAIL_PREFIX);

/** proposed; auto_applied moved off archive on the board; apply's own earlier failures. Nothing else is touched. */
function processable(d: Decision): boolean {
  if (d.status === 'proposed') return true;
  if (d.status === 'auto_applied') return d.dest !== 'archive';
  return isRetry(d);
}

const folderOf = (dest: Dest) => (dest.startsWith('label:') ? dest.slice('label:'.length) : null);

function stepLabel(dest: Dest, count: number): string {
  if (dest === 'archive') return `Archiving ${count} threads`;
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
        const next = dry ? done(d, 'applied', DRY_RUN) : await applyOne(deps, d, emails.get(d.threadId));
        result[next.status === 'applied' ? 'applied' : next.status === 'skipped' ? 'skipped' : 'failed']++;
        repo.saveDecision(batchId, next);
        emit(batchId, { type: 'decided', decision: structuredClone(next) });
        if (next.status === 'failed') {
          emit(batchId, { type: 'error', message: `Applying "${d.subject}" failed: ${next.note!.slice(FAIL_PREFIX.length)}` });
        }
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

/** Re-checks one thread, then writes: (unarchive) → label → archive → mark read → star. */
async function applyOne(deps: ApplyDeps, d: Decision, stored: StoredEmail | undefined): Promise<Decision> {
  const { mail } = deps;
  const undo = isUndo(d);
  const retry = isRetry(d);
  const failPrefix = undo ? UNDO_FAIL_PREFIX : FAIL_PREFIX;
  let fresh: Email | null;
  try {
    fresh = await mail.getThread(d.threadId);
  } catch (e) {
    return done(d, 'failed', failPrefix + errMessage(e));
  }
  if (!fresh || !stored || fresh.latestMessageId !== stored.latestMessageId) return done(d, 'skipped', CHANGED);

  let inInbox = fresh.labels.includes('INBOX');
  if (retry) {
    // Our own earlier attempt may have moved it part way. A proposal kept in the inbox that is now out of it
    // was moved by someone else; every other state is one this decision's writes can finish from.
    if (!undo && !inInbox && d.dest === 'keep') return done(d, 'skipped', CHANGED);
  } else if (undo ? inInbox : !inInbox) {
    // A proposal must still be in the inbox; an auto-archive being undone must still be out of it.
    return done(d, 'skipped', CHANGED);
  }

  const folder = folderOf(d.dest);
  const leaves = d.dest !== 'keep';
  try {
    if (undo && !inInbox) {
      await mail.unarchive(d.threadId);
      inInbox = true;
    }
    if (folder !== null) await mail.addLabel(d.threadId, folder);
    if (leaves && inInbox) await mail.archive(d.threadId);
    if (leaves || d.opened) await mail.markRead(d.threadId);
    if (d.star) await mail.star(d.threadId);
  } catch (e) {
    return done(d, 'failed', failPrefix + errMessage(e));
  }
  return done(d, 'applied');
}
