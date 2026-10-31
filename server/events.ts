import type { SessionEvent } from '../shared/types';

type Send = (e: SessionEvent) => void;

/** Fans a batch's events out to every live subscriber (one per open SSE stream). */
export class EventHub {
  private readonly subs = new Map<string, Set<Send>>();

  /** `onError` sees a subscriber's throw; the other subscribers still get the event. */
  constructor(private readonly onError: (e: unknown) => void = () => {}) {}

  subscribe(batchId: string, send: Send): () => void {
    let set = this.subs.get(batchId);
    if (!set) {
      set = new Set();
      this.subs.set(batchId, set);
    }
    // Wrapped so the same function subscribed twice gets two independent slots.
    const slot: Send = (e) => send(e);
    set.add(slot);
    return () => {
      const cur = this.subs.get(batchId);
      if (!cur) return;
      cur.delete(slot);
      if (cur.size === 0) this.subs.delete(batchId);
    };
  }

  emit(batchId: string, e: SessionEvent): void {
    const set = this.subs.get(batchId);
    if (!set) return;
    for (const send of [...set]) {
      try {
        send(e);
      } catch (err) {
        this.onError(err);
      }
    }
  }

  count(batchId: string): number {
    return this.subs.get(batchId)?.size ?? 0;
  }
}
