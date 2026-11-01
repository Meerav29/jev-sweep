import { choice, noul, type Question } from '@typesafe-ai/sdk';
import type { Dest, Email, Folder, NoulId } from '../../shared/types';

const BODY_LIMIT = 2000;
const DAY_MS = 86_400_000;

/** Whole days between `dateIso` and `now`, floored, never negative. */
export function ageDays(dateIso: string, now: Date): number {
  const ms = now.getTime() - new Date(dateIso).getTime();
  return Math.max(0, Math.floor(ms / DAY_MS));
}

export function buildState(email: Email, folders: Folder[], now: Date): Record<string, unknown> {
  return {
    from_name: email.fromName,
    from_address: email.fromAddress,
    subject: email.subject,
    date: email.date,
    age_days: ageDays(email.date, now),
    today: now.toISOString().slice(0, 10),
    gmail_labels: email.labels,
    body: email.body.slice(0, BODY_LIMIT),
    folders: folders.filter(f => f.enabled).map(f => (f.description ? { name: f.name, description: f.description } : { name: f.name })),
  };
}

// important / needs_reply / stale: spec section 6.3 (important and stale are age-aware). The other nine inbox-triage nouls are verbatim from inbox-triage/score.py.
const NOUL_INSTRUCTIONS: Record<NoulId, string> = {
  important: 'Does this email contain something this person needs to know or do **today** (a deadline, '
    + 'appointment, bill, security problem, or request) given how old it is?',
  needs_reply: 'Is a real person waiting for a reply from this person?',
  bulk_marketing: "Is this a bulk promotional or marketing email (sales, discounts, "
    + "product announcements, 'we miss you', surveys/feedback requests, contests) "
    + 'sent to many recipients rather than written to this person?',
  newsletter: 'Is this a newsletter, digest or editorial mailing (Substack, '
    + 'Beehiiv, news roundup, curated reading list, blog update)?',
  automated_sender: 'Is this sent by an automated system or no-reply style sender '
    + 'rather than a human writing to this person individually?',
  needs_attention: 'Would a reasonable person want to keep this visible: a message '
    + 'from a real person, something needing a reply or action, a bill or payment, '
    + 'security or account alert, order/shipping/travel/booking confirmation, '
    + 'receipt, school, work, job application or interview, or legal/medical/financial matter?',
  routine_financial: 'Is this a routine, recurring financial notification that needs '
    + 'no action: a regular monthly account statement or balance notice, an upcoming '
    + "autopay/SIP installment reminder, or a credit-monitoring 'you have alerts / "
    + "view your report' nudge?",
  financial_exception: 'Is this a financial email that is NOT routine and may need '
    + 'attention: fraud or suspicious-activity alert, failed/declined/returned or '
    + 'overdue payment, low balance, tax document, loan or interest-rate or terms '
    + 'change, account closure/lock, or any one-off financial event?',
  money_movement: 'Is this a confirmation or notice of money or securities '
    + 'actually moving: a stock/ETF/crypto trade, a transfer, deposit, withdrawal '
    + 'or payment made or received?',
  transactional: 'Is this a transactional message about a specific order, '
    + 'delivery, booking, rental, ride or receipt?',
  dev_bot: 'Is this an automated status or update notification from a '
    + 'developer platform, CI system or coding agent (deploys, builds, pull-request '
    + 'or issue bot activity, usage notices, agent/routine run summaries from '
    + 'Vercel, GitHub, Supabase, Netlify, Cloudflare, Sentry, Linear, Claude agents '
    + 'and similar)?',
  stale: "Given today's date and how old this email is, has the event, deadline, offer, alert, code, delivery or "
    + 'announcement it is about already passed, so that it no longer matters? Examples: past maintenance or outages, '
    + 'expired codes and sign-in alerts that were never acted on, ended sales and webinars, past appointments, '
    + 'deliveries that already arrived, old onboarding or welcome mail. Mail that stays useful as a record '
    + '(receipts, contracts, tax documents, statements) is not stale.',
};

export function buildQuestions(folders: Folder[]): { questions: Record<string, Question>; keyToDest: Record<string, Dest> } {
  const keyToDest: Record<string, Dest> = { archive: 'archive', keep_in_inbox: 'keep' };
  const criteria: Record<string, string> = {
    archive: 'Remove it from the inbox without filing it anywhere; nothing here needs attention.',
    keep_in_inbox: 'Leave it in the inbox because the person should see it.',
  };
  folders.filter(f => f.enabled).forEach((f, i) => {
    const key = `label_${i}`;
    keyToDest[key] = `label:${f.name}`;
    criteria[key] = `Move to the Gmail folder "${f.name}"${f.description ? `: ${f.description}` : ''}`;
  });
  const questions: Record<string, Question> = {
    destination: choice('Where should this email go?', criteria),
  };
  for (const [id, text] of Object.entries(NOUL_INSTRUCTIONS)) questions[id] = noul(text);
  return { questions, keyToDest };
}
