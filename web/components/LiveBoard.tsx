import { forwardRef } from 'react';
import type { Decision, Dest } from '../../shared/types';
import { Bump } from './Bump';
import { destLabel } from './destLabel';

/** Archived first, Inbox last, folders between in the order they first appeared. */
export function boardColumns(decisions: Decision[], extra: Dest[] = []): { dest: Dest; items: Decision[] }[] {
  const cols = new Map<Dest, Decision[]>();
  for (const d of decisions) {
    const list = cols.get(d.dest);
    if (list) list.push(d);
    else cols.set(d.dest, [d]);
  }
  for (const d of extra) if (!cols.has(d)) cols.set(d, []);
  const rank = (d: Dest) => (d === 'archive' ? 0 : d === 'keep' ? 2 : 1);
  return [...cols.entries()]
    .map(([dest, items], i) => ({ dest, items, i }))
    .sort((a, b) => rank(a.dest) - rank(b.dest) || a.i - b.i)
    .map(({ dest, items }) => ({ dest, items }));
}

interface Props {
  decisions: Decision[];
  /** A column to show before anything lands in it, so a chip has somewhere to fly to. */
  pending?: Dest | null;
  dryRun: boolean;
}

/** Where the batch is heading so far. Nothing here has moved in Gmail. */
export const LiveBoard = forwardRef<HTMLDivElement, Props>(function LiveBoard({ decisions, pending, dryRun }, ref) {
  const cols = boardColumns(decisions, pending ? [pending] : []);
  return (
    <section className="live" aria-label="This batch so far">
      <div className="lbl">
        <span>This batch so far</span>
        <span>{dryRun ? 'dry run: nothing will change in Gmail' : 'nothing moves in Gmail until you approve the batch'}</span>
      </div>
      <div className="board" ref={ref}>
        {cols.map((c) => (
          <div key={c.dest} className="col" data-testid="board-col" data-dest={c.dest}>
            <h4>{destLabel(c.dest)} <Bump value={c.items.length} tag="i" /></h4>
            {c.items.map((d) => (
              <div key={d.threadId} className={`chip tin${d.important ? ' red' : d.who === 'you' ? ' you' : ''}`}>
                <b>{d.subject}</b>
              </div>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
});
