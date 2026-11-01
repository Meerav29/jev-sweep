import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { BatchStatus, Dest } from '../../shared/types';
import { api } from '../api';
import { GeneratedCard } from '../cards/registry';
import { Bump } from '../components/Bump';
import { flyTo } from '../components/flyTo';
import { LiveBoard } from '../components/LiveBoard';
import { ProgressRing } from '../components/ProgressRing';
import { QueueStrip } from '../components/QueueStrip';
import { Ticker } from '../components/Ticker';
import { useBatch } from '../useBatch';

interface Props {
  batchId: string;
  onBack: () => void;
  /** Jev is done and nothing is waiting: the batch belongs to the board now. */
  onReviewing: (batchId: string) => void;
}

/** A batch that fetched nothing: the query has run dry. The board shows it too. */
export const NOTHING_LEFT = 'Nothing left to sort. Every unread email matching your query has been handled.';

/** Statuses the session screen has nothing left to do in. */
const BOARD_STATUSES: BatchStatus[] = ['reviewing', 'applying', 'applied'];

/** Gmail labels plus the folders enabled in settings, first spelling wins when two differ only by case. */
export function folderChoices(labels: string[], enabled: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...labels, ...enabled]) {
    const name = raw.trim();
    const k = name.toLowerCase();
    if (!name || seen.has(k)) continue;
    seen.add(k);
    out.push(name);
  }
  return out;
}

export function Session({ batchId, onBack, onReviewing }: Props) {
  const { view, error } = useBatch(batchId);
  const [folders, setFolders] = useState<string[]>([]);
  const [actionError, setActionError] = useState<string | undefined>();
  const [leaving, setLeaving] = useState(false);
  const [pending, setPending] = useState<Dest | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const handedOff = useRef(false);

  useEffect(() => {
    let live = true;
    // Either source can fail on its own; the picker still offers whatever the other one had.
    Promise.allSettled([api.labels(), api.settings()]).then(([labels, settings]) => {
      if (!live) return;
      setFolders(folderChoices(
        labels.status === 'fulfilled' ? labels.value : [],
        settings.status === 'fulfilled' ? settings.value.folders.filter((f) => f.enabled).map((f) => f.name) : [],
      ));
    });
    return () => { live = false; };
  }, []);

  useEffect(() => { handedOff.current = false; }, [batchId]);
  useEffect(() => {
    if (!view || handedOff.current || !BOARD_STATUSES.includes(view.status)) return;
    handedOff.current = true;
    onReviewing(batchId);
  }, [view, batchId, onReviewing]);

  const current = view?.current ?? null;
  // A new card (or none) starts fresh: nothing flying, nothing fading out.
  useEffect(() => { setLeaving(false); setPending(null); }, [current?.threadId]);

  const onChoose = useCallback(async (dest: Dest, opts?: { star?: boolean }) => {
    if (!current) return;
    setActionError(undefined);
    // Commit now, so the destination column exists before the chip measures where to land.
    flushSync(() => { setPending(dest); setLeaving(true); });
    const slot = slotRef.current;
    const from = slot?.querySelector('.win') ?? slot?.querySelector('.card');
    const board = boardRef.current;
    const to = board ? [...board.querySelectorAll('[data-dest]')].find((c) => c.getAttribute('data-dest') === dest) ?? board : null;
    if (from && to) await flyTo(from, to, current.subject);
    try {
      await api.resolve(batchId, current.threadId, dest, opts?.star);
    } catch (e) {
      setLeaving(false);
      setPending(null);
      throw e; // the card shows it and becomes choosable again
    }
  }, [batchId, current]);

  const togglePause = async () => {
    if (!view) return;
    setActionError(undefined);
    try {
      if (view.paused) await api.continue(batchId);
      else await api.pause(batchId);
    } catch (e) {
      setActionError((e as Error).message);
    }
  };

  const jump = (threadId: string) => {
    setActionError(undefined);
    api.jump(batchId, threadId).catch((e: Error) => setActionError(e.message));
  };

  const decisions = view?.decisions ?? [];
  const archived = decisions.filter((d) => d.dest === 'archive').length;
  const filed = decisions.filter((d) => d.dest.startsWith('label:')).length;
  const kept = decisions.filter((d) => d.dest === 'keep').length;
  const askedYou = decisions.filter((d) => d.who === 'you').length;
  const total = view?.total ?? 0;
  const shownError = actionError ?? error;

  let stage: React.ReactNode;
  if (!view) stage = <div className="idle"><span className="dot" />Connecting…</div>;
  else if (view.status === 'applied' && view.total === 0) stage = <div className="idle">{NOTHING_LEFT}</div>;
  else if (current) {
    stage = (
      <div key={current.threadId} ref={slotRef}
        className={`slot arrive${view.queue.length > 0 ? ' stacked' : ''}${leaving ? ' out' : ''}`}>
        <GeneratedCard card={current} folders={folders} onChoose={onChoose} context={{ batchNo: view.batchNo, total }} />
      </div>
    );
  } else if (view.read < view.total) {
    stage = (
      <div className="idle">
        <span className="dot" />
        {view.paused ? 'Nothing needs you right now. Jev is paused.' : 'Nothing needs you right now. Jev is still sorting…'}
      </div>
    );
  } else stage = <div className="idle">Batch sorted</div>;

  return (
    <div className="session">
      <header className="top">
        <button type="button" className="btn ghost" onClick={onBack}>← Sessions</button>
        <ProgressRing archived={archived} filed={filed} kept={kept} total={total} />
        <div className="ttl-wrap">
          <div className="ttl">{view ? `Batch ${view.batchNo}` : 'Batch'}</div>
          <div className="meta">{view ? `${decisions.length} of ${total} sorted · Jev has read ${view.read}` : 'Loading…'}</div>
          {view && view.fetched < total && <div className="meta">{`Fetching from Gmail… ${view.fetched} of ${total}`}</div>}
        </div>
        <div className="sp" />
        <div className="counts" data-testid="counts">
          <span>Archived <Bump value={archived} /></span>
          <span>Filed <Bump value={filed} /></span>
          <span>Kept <Bump value={kept} /></span>
          <span>Asked you <Bump value={askedYou} /></span>
        </div>
        <button type="button" className="btn" onClick={togglePause} disabled={!view || view.status !== 'running'}>
          {view?.paused ? 'Resume' : 'Pause'}
        </button>
      </header>
      {shownError && <p className="err session-err" role="alert">{shownError}</p>}
      <div className="main">
        {view && <Ticker view={view} />}
        <div className="stagewrap">
          <QueueStrip queue={view?.queue ?? []} onJump={jump} />
          <div className="stage">{stage}</div>
          <LiveBoard ref={boardRef} decisions={decisions} pending={pending} dryRun={view?.dryRun ?? false} />
        </div>
      </div>
    </div>
  );
}
