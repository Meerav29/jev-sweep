import type { CardOption, CardSpec, Dest, Email, JevAnswers, Outcome } from '../../shared/types';
import type { CardText } from '../claude/cardText';
import { truncate } from '../mail/provider';

function label(d: Dest): string {
  if (d === 'archive') return 'Archive';
  if (d === 'keep') return 'Keep in inbox';
  return d.slice('label:'.length);
}

export function toCard(email: Email, n: number, a: JevAnswers, outcome: Extract<Outcome, { kind: 'queue' }>, text: CardText): CardSpec {
  const options: CardOption[] = a.failed ? [] : (Object.entries(a.destination.probabilities) as [Dest, number][])
    .map(([dest, p]) => ({ dest, label: label(dest), p }))
    .sort((x, y) => y.p - x.p) // stable: ties keep the probabilities object's order
    .slice(0, 3);
  return {
    kind: outcome.card, threadId: email.threadId, n, fromName: email.fromName, fromAddress: email.fromAddress,
    subject: email.subject, body: truncate(email.body, 600), why: text.why, summary: text.summary,
    options, suggestKeep: outcome.suggestKeep,
    gmailUrl: `https://mail.google.com/mail/u/0/#all/${email.threadId}`,
  };
}
