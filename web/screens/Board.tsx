import { useCallback, useEffect, useRef, useState } from 'react';
import type { BatchView, Decision, Dest } from '../../shared/types';
import { ApiError, api } from '../api';
import { FolderCombo } from '../cards/parts';
import { boardColumns } from '../components/LiveBoard';
import { destLabel } from '../components/destLabel';
import { useBatch } from '../useBatch';
import { NOTHING_LEFT, folderChoices } from './Session';

interface Props {
  batchId: string;
  /** A past batch: a receipt, with no moving and no buttons. */
  readOnly: boolean;
  onHome: () => void;
  /** A new batch was started: it opens on the Session screen. */
  onSession: (batchId: string) => void;
}

/** Apply's own failures carry this prefix (server/session/apply.ts); only those are retried. */
const FAIL_PREFIX = 'apply: ';
const isRetry = (d: Decision) => d.status === 'failed' && !!d.note?.startsWith(FAIL_PREFIX);
/** An auto-archive moved somewhere else on the board: apply will undo it in Gmail. */
const isMovedAuto = (d: Decision) => d.status === 'auto_applied' && d.dest !== 'archive';

/** What apply will process: proposals, moved auto-archives, and apply's own earlier failures. */
export function pendingCount(decisions: Decision[]): number {
  return decisions.filter((d) => d.status === 'proposed' || isMovedAuto(d) || isRetry(d)).length;
}

/** The note as a person should read it: apply's bookkeeping prefix and progress markers dropped. */
function readableNote(note: string): string {
  let s = note.startsWith(FAIL_PREFIX) ? note.slice(FAIL_PREFIX.length) : note;
  for (const mark of ['(undo) ', '(archived) ']) if (s.startsWith(mark)) s = s.slice(mark.length);
  return s;
}

const MOVABLE_BATCH = (v: BatchView) => v.status === 'running' || v.status === 'reviewing';
const movableDecision = (d: Decision) => d.status === 'proposed' || d.status === 'auto_applied';
const DRY_RUN_NOTE = "dry run: Gmail won't be changed";
/** The note apply and the runner leave on a decision that dry run kept out of Gmail. */
const DRY_RUN = 'dry run';

function errorText(e: unknown, what: 'apply' | 'other'): string {
  if (what === 'apply' && e instanceof ApiError && e.status === 409) return 'Already applying…';
  return e instanceof Error ? e.message : String(e);
}

/** "+ Folder": a button that opens the folder picker in its place. */
function FolderPicker({ folders, disabled, onPick }: { folders: string[]; disabled?: boolean; onPick: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => { if (open) wrap.current?.querySelector('input')?.focus(); }, [open]);
  if (!open) {
    return <button type="button" className="btn" disabled={disabled} onClick={() => setOpen(true)}>+ Folder</button>;
  }
  return (
    <div className="fpick" ref={wrap}>
      <FolderCombo folders={folders} disabled={!!disabled} onPick={(name) => { setOpen(false); onPick(name); }} />
    </div>
  );
}

export function Board({ batchId, readOnly, onHome, onSession }: Props) {
  const { view, applySteps, error } = useBatch(batchId);
  const [labels, setLabels] = useState<{ labels: string[]; enabled: string[] }>({ labels: [], enabled: [] });
  const [startedAt, setStartedAt] = useState<string | undefined>();
  const [actionError, setActionError] = useState<string | undefined>();
  const [moved, setMoved] = useState<Set<string>>(new Set());
  const [extra, setExtra] = useState<Dest[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [over, setOver] = useState<Dest | null>(null);
  const [applying, setApplying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const dragId = useRef<string | null>(null);

  useEffect(() => {
    setMoved(new Set());
    setExtra([]);
    setSelected(null);
    setActionError(undefined);
    setConfirmDiscard(false);
  }, [batchId]);

  useEffect(() => {
    if (readOnly) return;
    let live = true;
    // Either source can fail on its own; the picker still offers whatever the other one had.
    Promise.allSettled([api.labels(), api.settings()]).then(([l, s]) => {
      if (!live) return;
      setLabels({
        labels: l.status === 'fulfilled' ? l.value : [],
        enabled: s.status === 'fulfilled' ? s.value.folders.filter((f) => f.enabled).map((f) => f.name) : [],
      });
    });
    return () => { live = false; };
  }, [readOnly]);

  const sessionId = view?.sessionId;
  useEffect(() => {
    if (!readOnly || !sessionId) return;
    let live = true;
    // Only the receipt's title needs it; without it the title is just "Batch n".
    api.sessions()
      .then((all) => { if (live) setStartedAt(all.find((s) => s.id === sessionId)?.startedAt); })
      .catch(() => {});
    return () => { live = false; };
  }, [readOnly, sessionId]);

  useEffect(() => {
    if (selected === null) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSelected(null); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selected]);

  const decisions = view?.decisions ?? [];
  const canMove = !readOnly && !!view && MOVABLE_BATCH(view) && !applying;
  const isMovable = (d: Decision) => canMove && movableDecision(d);

  const move = useCallback(async (threadId: string, dest: Dest) => {
    setSelected(null);
    const d = view?.decisions.find((x) => x.threadId === threadId);
    if (!d || d.dest === dest || !canMove || !movableDecision(d)) return;
    setActionError(undefined);
    try {
      await api.move(batchId, threadId, dest);
      setMoved((m) => new Set(m).add(threadId));
    } catch (e) {
      setActionError(errorText(e, 'other'));
    }
  }, [batchId, view, canMove]);

  const apply = async () => {
    setActionError(undefined);
    setApplying(true);
    try {
      await api.apply(batchId);
    } catch (e) {
      setActionError(errorText(e, 'apply'));
    } finally {
      setApplying(false);
    }
  };

  const nextBatch = async () => {
    if (!view) return;
    setActionError(undefined);
    setBusy(true);
    try {
      onSession((await api.nextBatch(view.sessionId)).batchId);
    } catch (e) {
      setActionError(errorText(e, 'other'));
      setBusy(false);
    }
  };

  const discard = async () => {
    setActionError(undefined);
    setBusy(true);
    try {
      await api.discard(batchId);
      onHome();
    } catch (e) {
      setActionError(errorText(e, 'other'));
      setBusy(false);
      setConfirmDiscard(false);
    }
  };

  const columns = boardColumns(decisions, readOnly ? [] : ['archive', ...extra, 'keep']);
  const boardFolders = columns.map((c) => c.dest).filter((d) => d.startsWith('label:')).map(destLabel);
  const folders = folderChoices([...labels.labels, ...boardFolders], labels.enabled);
  const addColumn = (name: string) => setExtra((x) => (x.includes(`label:${name}`) ? x : [...x, `label:${name}`]));

  const sel = selected ? decisions.find((d) => d.threadId === selected) : undefined;
  const selMovable = sel && isMovable(sel) ? sel : undefined;

  const pending = pendingCount(decisions);
  const hasFailed = decisions.some(isRetry);
  const dryRun = view?.dryRun ?? false;
  const date = startedAt ? new Date(startedAt) : null;
  const dateText = date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString() : null;
  const title = !view ? 'Batch'
    : readOnly ? (dateText ? `Batch ${view.batchNo} · ${dateText}` : `Batch ${view.batchNo}`)
    : `Batch ${view.batchNo} · where everything's going`;
  const applied = view?.status === 'applied';
  const empty = applied && view.total === 0;
  // A dry-run receipt must never pass for a real one, so it says so even read-only.
  const sub = dryRun && (applied || readOnly) ? 'Dry run: nothing was changed in Gmail.'
    : applied ? 'These moves have been applied in Gmail.'
    : `Drag a card to change where it goes. Nothing has moved in Gmail yet.${dryRun ? ` (${DRY_RUN_NOTE})` : ''}`;
  const shownError = actionError ?? error;

  const renderChip = (d: Decision) => {
    const movable = isMovable(d);
    // A dry-run note means Gmail was never touched: never drawn as done, tagged instead.
    const dry = d.note === DRY_RUN && (d.status === 'applied' || (d.status === 'auto_applied' && d.dest === 'archive'));
    const done = !dry && (d.status === 'applied' || (d.status === 'auto_applied' && d.dest === 'archive'));
    const isMoved = moved.has(d.threadId) || isMovedAuto(d);
    const cls = ['chip',
      d.important ? 'red' : d.who === 'you' ? 'you' : '',
      done ? 'done' : '',
      d.status === 'proposed' || isMovedAuto(d) || isRetry(d) ? 'pending' : '',
      isMoved ? 'moved' : '',
      movable ? 'grab' : '',
      selected === d.threadId ? 'sel' : '',
      d.status === 'skipped' || d.status === 'failed' ? d.status : '',
    ].filter(Boolean).join(' ');
    const body = (
      <>
        {done && <i className="ck" aria-hidden="true">✓</i>}
        <b>{d.subject}</b>
        <span>{d.fromName}{d.who === 'you' ? ' · you chose' : ''}{done ? <span className="sr-only"> · done</span> : null}</span>
        {dry && <span className="tag">dry run</span>}
        {(d.status === 'skipped' || d.status === 'failed') && d.note && (
          <span className="note">{d.status === 'failed' ? 'Failed: ' : 'Skipped: '}{readableNote(d.note)}</span>
        )}
      </>
    );
    if (!movable) return <div key={d.threadId} className={cls}>{body}</div>;
    return (
      <button key={d.threadId} type="button" className={cls} draggable aria-pressed={selected === d.threadId}
        onClick={() => setSelected((s) => (s === d.threadId ? null : d.threadId))}
        onDragStart={(e) => {
          dragId.current = d.threadId;
          e.dataTransfer.setData('text/plain', d.threadId);
          e.dataTransfer.effectAllowed = 'move';
        }}
        onDragEnd={() => { dragId.current = null; setOver(null); }}>
        {body}
      </button>
    );
  };

  if (empty) {
    return (
      <main className="screen">
        <div>
          <h1>{`Batch ${view.batchNo}`}</h1>
          <p className="sub">{NOTHING_LEFT}</p>
        </div>
        {shownError && <p className="err" role="alert">{shownError}</p>}
        <button type="button" className="btn dark" onClick={onHome}>End session</button>
      </main>
    );
  }

  return (
    <main className="bscreen">
      <div className="bhead">
        <div className="bttl">
          <button type="button" className="btn ghost back" onClick={onHome}>← Sessions</button>
          <h1>{title}</h1>
          {(!readOnly || dryRun) && <p className="sub">{sub}</p>}
        </div>
        <div className="legend" data-testid="legend">
          <span style={{ ['--c' as string]: 'var(--strong)' }}>you decided</span>
          <span style={{ ['--c' as string]: 'var(--red)' }}>important</span>
          <span style={{ ['--c' as string]: 'var(--line)' }}>Jev decided</span>
        </div>
      </div>
      {shownError && <p className="err board-err" role="alert">{shownError}</p>}
      {!readOnly && canMove && (
        selMovable ? (
          <div className="moveto" role="group" aria-label="Move to…">
            <span className="mlbl">Move <b>{selMovable.subject}</b> to</span>
            {columns.filter((c) => c.dest !== selMovable.dest).map((c) => (
              <button key={c.dest} type="button" className="btn" onClick={() => move(selMovable.threadId, c.dest)}>{destLabel(c.dest)}</button>
            ))}
            <FolderPicker folders={folders} onPick={(name) => move(selMovable.threadId, `label:${name}`)} />
            <button type="button" className="btn ghost" onClick={() => setSelected(null)}>Cancel</button>
          </div>
        ) : (
          <div className="moveto tools">
            <span className="hint">Tap a card to move it, or drag it.</span>
            <FolderPicker folders={folders} onPick={addColumn} />
          </div>
        )
      )}
      <div className="board review" aria-label="Where everything's going">
        {columns.map((c) => (
          <div key={c.dest} className={`col${over === c.dest ? ' over' : ''}`} data-testid="board-col" data-dest={c.dest}
            onDragOver={canMove ? (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (over !== c.dest) setOver(c.dest); } : undefined}
            onDragLeave={canMove ? () => setOver((o) => (o === c.dest ? null : o)) : undefined}
            onDrop={canMove ? (e) => {
              e.preventDefault();
              setOver(null);
              const id = e.dataTransfer.getData('text/plain') || dragId.current;
              dragId.current = null;
              if (id) void move(id, c.dest);
            } : undefined}>
            <h4>{destLabel(c.dest)} <i>{c.items.length}</i></h4>
            {c.items.map(renderChip)}
          </div>
        ))}
      </div>
      {applySteps.length > 0 && (
        <ul className="applying" data-testid="applying" aria-live="polite">
          {applySteps.map((s) => <li key={s.label}>{s.done ? `${s.label} ✓` : `${s.label}…`}</li>)}
        </ul>
      )}
      {!readOnly && view && (
        <div className="actions" data-testid="actions">
          {view.status === 'applied' ? (
            <>
              <button type="button" className="btn dark" disabled={busy} onClick={nextBatch}>Next batch</button>
              <button type="button" className="btn" disabled={busy} onClick={onHome}>End session</button>
            </>
          ) : view.status === 'discarded' ? (
            <span className="hint">This batch was discarded.</span>
          ) : view.status !== 'reviewing' ? (
            view.status === 'applying' ? <span className="hint">Applying…</span> : null
          ) : confirmDiscard ? (
            <>
              <span className="hint">Discard this batch? Its proposed moves won't happen.</span>
              <button type="button" className="btn dark" disabled={busy} onClick={discard}>Yes, discard</button>
              <button type="button" className="btn" disabled={busy} onClick={() => setConfirmDiscard(false)}>Keep it</button>
            </>
          ) : (
            <>
              {hasFailed
                ? <button type="button" className="btn dark" disabled={applying} onClick={apply}>Retry failed</button>
                : <button type="button" className="btn dark" disabled={applying} onClick={apply}>Apply {pending} moves</button>}
              <button type="button" className="btn ghost" disabled={applying || busy} onClick={() => setConfirmDiscard(true)}>Discard batch</button>
              {hasFailed && <button type="button" className="btn" disabled={applying} onClick={onHome}>End session</button>}
              {dryRun && <span className="hint">{DRY_RUN_NOTE}</span>}
            </>
          )}
        </div>
      )}
    </main>
  );
}
