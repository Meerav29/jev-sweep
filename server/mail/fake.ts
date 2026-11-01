import type { Email, JevAnswers } from '../../shared/types';
import type { Candidate, MailProvider } from './provider';

export type FakeEmail = Email & { jev: JevAnswers; summary?: string[] };
export type FakeExpect = 'auto_archive' | 'proposed' | 'queue_filing' | 'queue_important';
/** A fixture row: a FakeEmail plus the policy branch the fixture intends for it. */
export type FixtureEmail = FakeEmail & { expect: FakeExpect };

const SYSTEM_LABELS = new Set(['INBOX', 'SPAM', 'TRASH', 'UNREAD', 'STARRED', 'IMPORTANT', 'SENT', 'DRAFT', 'CHAT']);
const DAY_MS = 86_400_000;

/** Turns the fixture file (with `daysAgo`) into emails with concrete ISO dates relative to `now`. */
export function loadFakeInbox(raw: unknown, now: Date): FixtureEmail[] {
  if (!Array.isArray(raw)) throw new Error('fake inbox fixture must be an array');
  return raw.map((row: Record<string, unknown>, i) => {
    const { daysAgo, ...rest } = row;
    if (typeof daysAgo !== 'number') throw new Error(`fake inbox item ${i} is missing a numeric daysAgo`);
    return { ...rest, date: new Date(now.getTime() - daysAgo * DAY_MS).toISOString() } as unknown as FixtureEmail;
  });
}

export class FakeMail implements MailProvider {
  public log: string[] = [];
  private threads = new Map<string, FakeEmail>();
  private labelNames = new Set<string>();

  constructor(fixture: FakeEmail[]) {
    for (const e of fixture) {
      this.threads.set(e.threadId, structuredClone(e));
      for (const k of Object.keys(e.jev.destination.probabilities)) {
        if (k.startsWith('label:')) this.labelNames.add(k.slice(6));
      }
    }
  }

  async listLabels(): Promise<string[]> {
    return [...this.labelNames].sort();
  }

  async listCandidates(_query: string, n: number, excluded: Map<string, string>): Promise<Candidate[]> {
    return [...this.threads.values()]
      .filter(t => t.labels.includes('INBOX') && excluded.get(t.threadId) !== t.latestMessageId)
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(0, n)
      .map(t => ({ threadId: t.threadId, latestMessageId: t.latestMessageId }));
  }

  async getThread(threadId: string): Promise<Email | null> {
    const t = this.threads.get(threadId);
    return t ? structuredClone(t) : null;
  }

  async archive(threadId: string): Promise<void> {
    this.log.push(`archive:${threadId}`);
    this.removeLabel(threadId, 'INBOX');
  }

  async unarchive(threadId: string): Promise<void> {
    this.log.push(`unarchive:${threadId}`);
    this.addLabelId(threadId, 'INBOX');
  }

  async addLabel(threadId: string, name: string): Promise<void> {
    if (SYSTEM_LABELS.has(name.toUpperCase()) || name.toUpperCase().startsWith('CATEGORY_')) {
      throw new Error(`Refusing to apply system label "${name}" as a folder`);
    }
    this.log.push(`label:${threadId}:${name}`);
    const known = [...this.labelNames].find(l => l.toLowerCase() === name.toLowerCase());
    const canonical = known ?? name;
    this.labelNames.add(canonical);
    this.addLabelId(threadId, canonical);
  }

  async star(threadId: string): Promise<void> {
    this.log.push(`star:${threadId}`);
    this.addLabelId(threadId, 'STARRED');
  }

  async markRead(threadId: string): Promise<void> {
    this.log.push(`read:${threadId}`);
    this.removeLabel(threadId, 'UNREAD');
    const t = this.threads.get(threadId);
    if (t) t.unread = false;
  }

  private addLabelId(threadId: string, label: string): void {
    const t = this.threads.get(threadId);
    if (t && !t.labels.includes(label)) t.labels.push(label);
  }

  private removeLabel(threadId: string, label: string): void {
    const t = this.threads.get(threadId);
    if (t) t.labels = t.labels.filter(l => l !== label);
  }
}
