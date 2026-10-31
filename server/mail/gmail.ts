import { google, type gmail_v1 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import type { Email } from '../../shared/types';
import { extractBody, type GmailPayload, type MailProvider } from './provider';

export const RETRY_CONFIG = {
  retry: 4,
  statusCodesToRetry: [[429, 429], [500, 599]] as [number, number][],
  httpMethodsToRetry: ['GET', 'HEAD', 'PUT', 'OPTIONS', 'DELETE', 'POST'],
};
const PAGE_SIZE = 500;

type Message = gmail_v1.Schema$Message;

const header = (m: Message, name: string): string =>
  m.payload?.headers?.find(h => (h.name ?? '').toLowerCase() === name.toLowerCase())?.value ?? '';

/** Parses `"Name" <addr@host>`, `Name <addr@host>` or a bare address. */
function parseFrom(raw: string): { fromName: string; fromAddress: string } {
  const m = raw.match(/^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/);
  if (m) return { fromName: (m[1] ?? '').trim() || m[2].trim(), fromAddress: m[2].trim() };
  const addr = raw.trim();
  return { fromName: addr, fromAddress: addr };
}

const SYSTEM_LABEL_IDS = new Set(['INBOX', 'SPAM', 'TRASH', 'UNREAD', 'STARRED', 'IMPORTANT', 'SENT', 'DRAFT', 'CHAT']);
const NEVER_ADD = new Set(['SPAM', 'TRASH']);
const isSystemLabelId = (id: string): boolean => SYSTEM_LABEL_IDS.has(id) || id.startsWith('CATEGORY_');

/** Last line of defence: no modify call may ever add SPAM or TRASH. */
function assertSafeModify(body: gmail_v1.Schema$ModifyThreadRequest): void {
  for (const id of body.addLabelIds ?? []) {
    if (NEVER_ADD.has(id)) throw new Error(`Refusing to add label ${id}`);
  }
}

function httpStatus(err: unknown): number | undefined {
  const e = err as { status?: number; code?: number | string; response?: { status?: number } };
  if (typeof e?.status === 'number') return e.status;
  if (typeof e?.response?.status === 'number') return e.response.status;
  return typeof e?.code === 'number' ? e.code : undefined;
}

function latestMessage(messages: Message[]): Message {
  return messages.reduce((best, m) => (Number(m.internalDate ?? 0) >= Number(best.internalDate ?? 0) ? m : best), messages[0]);
}

export class GmailProvider implements MailProvider {
  private gmail: gmail_v1.Gmail;

  constructor(auth: OAuth2Client, client?: gmail_v1.Gmail) {
    this.gmail = client ?? google.gmail({ version: 'v1', auth, retryConfig: RETRY_CONFIG });
  }

  async listLabels(): Promise<string[]> {
    const labels = await this.allLabels();
    return labels
      .filter(l => l.type !== 'system' && l.name && !l.name.startsWith('[') && !l.name.includes('CATEGORY_'))
      .map(l => l.name as string);
  }

  async fetchBatch(query: string, n: number, excluded: Map<string, string>): Promise<Email[]> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const res = await this.gmail.users.threads.list({ userId: 'me', q: query, maxResults: PAGE_SIZE, pageToken });
      for (const t of res.data.threads ?? []) if (t.id) ids.push(t.id);
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);

    const names = new Map((await this.allLabels()).map(l => [l.id, l.name]));
    const out: Email[] = [];
    for (const id of ids.reverse()) { // Gmail lists newest first
      if (out.length >= n) break;
      let email: Email | null;
      try {
        email = await this.fetchThread(id, names);
      } catch (err) {
        if (httpStatus(err) === 404) continue; // deleted between list and get
        throw err;
      }
      if (email && excluded.get(id) !== email.latestMessageId) out.push(email);
    }
    return out;
  }

  async getThread(threadId: string): Promise<Email | null> {
    try {
      return await this.fetchThread(threadId, new Map((await this.allLabels()).map(l => [l.id, l.name])));
    } catch (err) {
      if (httpStatus(err) === 404) return null;
      throw err;
    }
  }

  archive(threadId: string): Promise<void> { return this.modify(threadId, { removeLabelIds: ['INBOX'] }); }
  unarchive(threadId: string): Promise<void> { return this.modify(threadId, { addLabelIds: ['INBOX'] }); }
  markRead(threadId: string): Promise<void> { return this.modify(threadId, { removeLabelIds: ['UNREAD'] }); }
  star(threadId: string): Promise<void> { return this.modify(threadId, { addLabelIds: ['STARRED'] }); }

  async addLabel(threadId: string, name: string): Promise<void> {
    const wanted = name.toLowerCase();
    const findUser = async () => (await this.allLabels()).find(l => l.type === 'user' && (l.name ?? '').toLowerCase() === wanted);
    let label = await findUser();
    if (!label) {
      try {
        label = (await this.gmail.users.labels.create({ userId: 'me', requestBody: { name } })).data;
      } catch (err) {
        if (httpStatus(err) !== 409) throw err;
        // Already exists (e.g. a retried create that succeeded): reuse it.
        label = await findUser();
        if (!label) throw err;
      }
    }
    if (!label.id) throw new Error(`Gmail returned no id for label "${name}"`);
    if (label.type === 'system' || isSystemLabelId(label.id)) {
      throw new Error(`Refusing to apply system label "${label.id}" as a folder`);
    }
    await this.modify(threadId, { addLabelIds: [label.id] });
  }

  private async modify(threadId: string, requestBody: gmail_v1.Schema$ModifyThreadRequest): Promise<void> {
    assertSafeModify(requestBody);
    await this.gmail.users.threads.modify({ userId: 'me', id: threadId, requestBody });
  }

  private async allLabels(): Promise<gmail_v1.Schema$Label[]> {
    const res = await this.gmail.users.labels.list({ userId: 'me' });
    return res.data.labels ?? [];
  }

  private async fetchThread(id: string, names: Map<string | null | undefined, string | null | undefined>): Promise<Email | null> {
    const res = await this.gmail.users.threads.get({ userId: 'me', id, format: 'full' });
    const messages = res.data.messages ?? [];
    if (messages.length === 0) return null;
    const m = latestMessage(messages);
    const labelIds = [...new Set(messages.flatMap(x => x.labelIds ?? []))];
    return {
      threadId: id,
      latestMessageId: m.id ?? '',
      ...parseFrom(header(m, 'From')),
      subject: header(m, 'Subject'),
      date: new Date(Number(m.internalDate ?? 0)).toISOString(),
      labels: labelIds.map(l => names.get(l) ?? l),
      body: m.payload ? extractBody(m.payload as GmailPayload) : '',
      unread: labelIds.includes('UNREAD'),
    };
  }
}
