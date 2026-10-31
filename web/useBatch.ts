import { useEffect, useState } from 'react';
import type { BatchView, SessionEvent } from '../shared/types';

export interface ApplyStep { label: string; count: number; done: boolean }

const upsert = <T>(list: T[], item: T, same: (a: T) => boolean): T[] => {
  const i = list.findIndex(same);
  return i < 0 ? [...list, item] : list.map((x, j) => (j === i ? item : x));
};

/** Pure: folds one server event into the mirrored view. Events before the first snapshot are ignored. */
export function reduceBatch(view: BatchView | null, e: SessionEvent): BatchView | null {
  if (e.type === 'snapshot') return e.view;
  if (!view) return view;
  switch (e.type) {
    case 'decided':
      return { ...view, decisions: upsert(view.decisions, e.decision, (d) => d.threadId === e.decision.threadId) };
    case 'queued':
      return { ...view, queue: upsert(view.queue, e.item, (q) => q.threadId === e.item.threadId) };
    case 'current':
      return {
        ...view,
        current: e.card,
        queue: e.card ? view.queue.filter((q) => q.threadId !== e.card!.threadId) : view.queue,
      };
    case 'card_text':
      if (!view.current || view.current.threadId !== e.threadId) return view;
      return {
        ...view,
        current: {
          ...view.current,
          ...(e.why !== undefined && { why: e.why }),
          ...(e.summary !== undefined && { summary: e.summary }),
        },
      };
    case 'progress':
      return { ...view, read: e.read, total: e.total, paused: e.paused };
    case 'status':
      return { ...view, status: e.status };
    default:
      return view;
  }
}

const EVENT_TYPES: SessionEvent['type'][] = [
  'snapshot', 'decided', 'queued', 'current', 'card_text', 'progress', 'status', 'apply_step', 'error',
];

export function useBatch(batchId: string | null): { view: BatchView | null; applySteps: ApplyStep[]; error?: string } {
  const [view, setView] = useState<BatchView | null>(null);
  const [applySteps, setApplySteps] = useState<ApplyStep[]>([]);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    setView(null);
    setApplySteps([]);
    setError(undefined);
    if (!batchId) return;
    const es = new EventSource(`/api/batches/${encodeURIComponent(batchId)}/events`);
    const onEvent = (msg: MessageEvent) => {
      let e: SessionEvent;
      try {
        e = JSON.parse(msg.data) as SessionEvent;
      } catch {
        return;
      }
      if (e.type === 'error') {
        // A server-sent error is a message about the batch; the stream itself stays open.
        setError(e.message);
        return;
      }
      setError(undefined);
      if (e.type === 'apply_step') {
        setApplySteps((s) => upsert(s, { label: e.label, count: e.count, done: e.done }, (x) => x.label === e.label));
        return;
      }
      setView((v) => reduceBatch(v, e));
    };
    for (const t of EVENT_TYPES) es.addEventListener(t, onEvent as EventListener);
    // A dropped connection: EventSource reconnects by itself and the server sends a fresh snapshot.
    es.onerror = () => setError('Connection lost. Reconnecting…');
    return () => es.close();
  }, [batchId]);

  return { view, applySteps, error };
}
