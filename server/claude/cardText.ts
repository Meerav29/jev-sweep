import Anthropic from '@anthropic-ai/sdk';
import type { Email, JevAnswers } from '../../shared/types';
import { truncate } from '../mail/provider';

export interface CardText { why?: string; summary?: string[] }
export interface CardTextWriter { write(email: Email, a: JevAnswers, kind: 'filing' | 'important'): Promise<CardText> }

const SYSTEM = 'You write short helper text for an email triage card. Reply with JSON only: {"why": one sentence under 15 words saying why a human should decide this email} and, only if asked for a summary, {"summary": 2-4 bullets under 12 words each covering dates, amounts, requests and attachments}. Never invent facts that are not in the email.';

function parseCardText(raw: string): CardText {
  const body = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let v: unknown;
  try { v = JSON.parse(body); } catch { return {}; }
  if (typeof v !== 'object' || v === null) return {};
  const o = v as Record<string, unknown>;
  const out: CardText = {};
  if (typeof o.why === 'string') out.why = o.why;
  if (Array.isArray(o.summary) && o.summary.every((s) => typeof s === 'string')) out.summary = o.summary as string[];
  return out;
}

export class ClaudeWriter implements CardTextWriter {
  private client: Anthropic;
  constructor(apiKey: string, private model: string, client?: Anthropic) {
    this.client = client ?? new Anthropic({ apiKey });
  }
  async write(email: Email, a: JevAnswers, kind: 'filing' | 'important'): Promise<CardText> {
    const top = (Object.entries(a.destination.probabilities) as [string, number][])
      .sort((x, y) => y[1] - x[1]).slice(0, 2)
      .map(([d, p]) => `${d}: ${p.toFixed(2)}`).join(', ');
    const lines = [
      `Subject: ${email.subject}`,
      `From: ${email.fromName} <${email.fromAddress}>`,
      `Body: ${truncate(email.body, 2000)}`,
      `Jev's top destinations: ${top || 'none'} (confidence ${a.destination.confidence.toFixed(2)})`,
    ];
    if (kind === 'important') lines.push('Include a summary.');
    const res = await this.client.messages.create({
      model: this.model, max_tokens: 300, system: SYSTEM,
      messages: [{ role: 'user', content: lines.join('\n') }],
    });
    const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    return parseCardText(text);
  }
}

export class FakeWriter implements CardTextWriter {
  constructor(private summariesByThread: Record<string, string[]> = {}) {}
  async write(email: Email, _a: JevAnswers, kind: 'filing' | 'important'): Promise<CardText> {
    const out: CardText = { why: "Jev wasn't sure about this one." };
    const s = this.summariesByThread[email.threadId];
    if (kind === 'important' && s) out.summary = s;
    return out;
  }
}

export function withTimeout(w: CardTextWriter, ms: number): CardTextWriter {
  return {
    write(email, a, kind) {
      return new Promise<CardText>((resolve) => {
        const timer = setTimeout(() => resolve({}), ms);
        w.write(email, a, kind).then(resolve, () => resolve({})).finally(() => clearTimeout(timer));
      });
    },
  };
}
