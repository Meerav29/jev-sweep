import type { BatchView } from '../../shared/types';
import { destLabel } from './destLabel';

interface Row { threadId: string; n: number; subject: string; to: string; kind: 'jev' | 'you' | 'ask'; red: boolean }

/** Every email Jev has read, newest on top: what it decided, or that it's waiting for you. */
export function tickerRows(view: BatchView): Row[] {
  const rows = new Map<string, Row>();
  for (const d of view.decisions) {
    rows.set(d.threadId, {
      threadId: d.threadId, n: d.n, subject: d.subject,
      to: d.who === 'you' ? `you → ${destLabel(d.dest)}` : destLabel(d.dest),
      kind: d.who === 'you' ? 'you' : 'jev', red: d.who === 'you' && d.important,
    });
  }
  const waiting = [...view.queue, ...(view.current ? [view.current] : [])];
  for (const q of waiting) {
    if (!rows.has(q.threadId)) rows.set(q.threadId, { threadId: q.threadId, n: q.n, subject: q.subject, to: 'Waiting for you', kind: 'ask', red: false });
  }
  return [...rows.values()].sort((a, b) => b.n - a.n);
}

/** No aria-live: a screen reader shouldn't announce every email Jev reads. */
export function Ticker({ view }: { view: BatchView }) {
  const rows = tickerRows(view);
  return (
    <aside className="feed">
      <div className="lbl"><span>Jev's decisions</span><span>{view.paused ? 'paused' : 'live'}</span></div>
      <ol className="tick" aria-label="Jev's decisions">
        {rows.map((r) => (
          <li key={r.threadId} className={`trow tin${r.kind === 'jev' ? '' : ` ${r.kind}`}${r.red ? ' red' : ''}`}>
            <span className="w">{r.subject}</span><span className="to">{r.to}</span>
          </li>
        ))}
      </ol>
    </aside>
  );
}
