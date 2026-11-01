import type { QueueItem } from '../../shared/types';

/** The emails waiting behind the current card. A chip brings that email forward. */
export function QueueStrip({ queue, onJump }: { queue: QueueItem[]; onJump: (threadId: string) => void }) {
  if (queue.length === 0) return null;
  return (
    <div className="queue">
      <span className="ql">Waiting for you · <b>{queue.length}</b></span>
      <div className="qlist">
        {queue.map((q) => (
          <button key={q.threadId} type="button" className={`qchip${q.important ? ' red' : ''}`} onClick={() => onJump(q.threadId)}>
            <span>#{q.n}</span> {q.subject}
          </button>
        ))}
      </div>
    </div>
  );
}
