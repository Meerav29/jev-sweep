import type { Email } from '../../shared/types';

/** A thread picked for a batch, before its full fetch. */
export interface Candidate { threadId: string; latestMessageId: string }

export interface MailProvider {
  /** User labels only: no system labels, no names starting with `[` or containing `CATEGORY_`. */
  listLabels(): Promise<string[]>;
  /**
   * Up to `n` threads matching `query`, oldest first, with each one's latest message id (no bodies).
   * Skips threads whose id is in `excluded` with the same latestMessageId. Fetch each in full with getThread.
   */
  listCandidates(query: string, n: number, excluded: Map<string, string>): Promise<Candidate[]>;
  getThread(threadId: string): Promise<Email | null>;
  archive(threadId: string): Promise<void>;
  unarchive(threadId: string): Promise<void>;
  addLabel(threadId: string, name: string): Promise<void>;
  star(threadId: string): Promise<void>;
  markRead(threadId: string): Promise<void>;
}

/** The slice of a Gmail message payload that body extraction needs. */
export interface GmailPayload {
  mimeType?: string | null;
  body?: { data?: string | null } | null;
  parts?: GmailPayload[] | null;
}

/** Cuts to exactly `max` characters, ending in an ellipsis when something was removed. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 0) return '';
  return s.slice(0, max - 1) + '…';
}

const decodeB64 = (data: string): string => Buffer.from(data, 'base64url').toString('utf8');
const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();

const NAMED_ENTITIES: Record<string, string> = { nbsp: ' ', lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (m, h: string) => safeCodePoint(parseInt(h, 16), m))
    .replace(/&#(\d+);/g, (m, d: string) => safeCodePoint(parseInt(d, 10), m))
    .replace(/&(nbsp|lt|gt|quot|apos);/gi, (_m, name: string) => NAMED_ENTITIES[name.toLowerCase()])
    .replace(/&amp;/gi, '&'); // last, so "&amp;lt;" decodes once to "&lt;"
}

function safeCodePoint(cp: number, fallback: string): string {
  return Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : fallback;
}

function htmlToText(html: string): string {
  const noBlocks = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(style|script|head)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  const withBreaks = noBlocks.replace(/<\/?(p|div|br|li|ul|ol|tr|td|th|table|h[1-6]|blockquote|section|article|hr)\b[^>]*>/gi, ' ');
  return collapse(decodeEntities(withBreaks.replace(/<[^>]*>/g, '')));
}

function collect(p: GmailPayload, out: { plain: string[]; html: string[] }): void {
  const type = (p.mimeType ?? '').toLowerCase();
  const data = p.body?.data;
  if (data && type === 'text/plain') out.plain.push(decodeB64(data));
  else if (data && type === 'text/html') out.html.push(decodeB64(data));
  for (const child of p.parts ?? []) collect(child, out);
}

/** Prefers text/plain; otherwise HTML stripped to text. Whitespace collapsed. */
export function extractBody(payload: GmailPayload): string {
  const found = { plain: [] as string[], html: [] as string[] };
  collect(payload, found);
  const plain = collapse(found.plain.join(' '));
  if (plain) return plain;
  return htmlToText(found.html.join(' '));
}
