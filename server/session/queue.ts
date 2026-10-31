import type { QueueItem } from '../../shared/types';

// Priority: important first, then older (lower n) first.
function outranks(a: QueueItem, b: QueueItem): boolean {
  if (a.important !== b.important) return a.important;
  return a.n < b.n;
}

/**
 * Emails waiting for a human review card.
 * `front` holds unshifted items (most recent first) and always precedes `rest`,
 * which is kept in priority order.
 */
export class ReviewQueue {
  private front: QueueItem[] = [];
  private rest: QueueItem[] = [];

  constructor(items: QueueItem[] = []) {
    for (const i of items) this.push(i);
  }

  get size(): number {
    return this.front.length + this.rest.length;
  }

  has(threadId: string): boolean {
    return this.front.some((i) => i.threadId === threadId) || this.rest.some((i) => i.threadId === threadId);
  }

  push(i: QueueItem): void {
    if (this.has(i.threadId)) return;
    let at = this.rest.length;
    for (let k = 0; k < this.rest.length; k++) {
      if (outranks(i, this.rest[k])) {
        at = k;
        break;
      }
    }
    this.rest.splice(at, 0, i);
  }

  unshift(i: QueueItem): void {
    this.take(i.threadId);
    this.front.unshift(i);
  }

  shift(): QueueItem | undefined {
    if (this.front.length > 0) return this.front.shift();
    return this.rest.shift();
  }

  take(threadId: string): QueueItem | undefined {
    const f = this.front.findIndex((i) => i.threadId === threadId);
    if (f !== -1) return this.front.splice(f, 1)[0];
    const r = this.rest.findIndex((i) => i.threadId === threadId);
    if (r !== -1) return this.rest.splice(r, 1)[0];
    return undefined;
  }

  list(): QueueItem[] {
    return [...this.front, ...this.rest];
  }
}
