import type { JevAnswers, NoulId, Outcome, Thresholds } from '../../shared/types';

// Constants ported verbatim from inbox-triage/score.py decide().
const FINANCIAL_BLOCK = 0.5; // financial_exception / money_movement >= this: never archive
const HUMAN_BELOW = 0.5; // automated_sender < this: reads as human-written
const NEWSLETTER_BONUS = 0.05; // newsletters clear a 0.80 bar
const RECENT_PROMO_MIN = 0.95;
const RECENT_ATTENTION_MAX = 0.25;
const OLD_JUNK_MIN = 0.85;
const OLD_ATTENTION_MAX = 0.5;
const OLD_CLEAR_PROMO_MIN = 0.93;
const OLD_CLEAR_PROMO_ATTENTION_MAX = 0.65;
const NOREPLY_AUTOMATED_MIN = 0.9;
const NOREPLY_BULK_MIN = 0.5;
const DEV_BOT_MIN = 0.85;
const ROUTINE_FINANCIAL_MIN = 0.85;
const ROUTINE_FINANCIAL_EXCEPTION_MAX = 0.3;
const TRANSACTIONAL_MIN = 0.85;
const TRANSACTIONAL_AUTOMATED_MIN = 0.8;

// Policy v2 fixed bars (the tunable ones live in Thresholds).
const STALE_AUTOMATED_MIN = 0.9;
const STALE_NEEDS_REPLY_MAX = 0.3;
const STALE_FINANCIAL_MAX = 0.5;

/** True exactly where score.py decide() returns "archive". */
export function triageSaysArchive(n: Record<NoulId, number>, ageDays: number, recentDays: number): boolean {
  if (n.financial_exception >= FINANCIAL_BLOCK || n.money_movement >= FINANCIAL_BLOCK) return false;
  if (n.automated_sender < HUMAN_BELOW) return false;

  const junk = Math.max(n.bulk_marketing, n.newsletter + NEWSLETTER_BONUS);

  if (ageDays < recentDays) {
    return n.bulk_marketing >= RECENT_PROMO_MIN && n.needs_attention <= RECENT_ATTENTION_MAX;
  }

  if (junk >= OLD_JUNK_MIN && n.needs_attention <= OLD_ATTENTION_MAX) return true;
  if (
    n.bulk_marketing >= OLD_CLEAR_PROMO_MIN &&
    n.needs_attention <= OLD_CLEAR_PROMO_ATTENTION_MAX &&
    n.financial_exception < FINANCIAL_BLOCK
  ) return true;
  if (
    n.automated_sender >= NOREPLY_AUTOMATED_MIN &&
    n.bulk_marketing >= NOREPLY_BULK_MIN &&
    n.needs_attention <= OLD_ATTENTION_MAX
  ) return true;
  if (n.dev_bot >= DEV_BOT_MIN) return true;
  if (n.routine_financial >= ROUTINE_FINANCIAL_MIN && n.financial_exception <= ROUTINE_FINANCIAL_EXCEPTION_MAX) return true;
  if (n.transactional >= TRANSACTIONAL_MIN && n.automated_sender >= TRANSACTIONAL_AUTOMATED_MIN) return true;
  return false;
}

export function decide(a: JevAnswers, ageDays: number, t: Thresholds): Outcome {
  if (a.failed) return { kind: 'queue', card: 'filing', suggestKeep: false };

  const n = a.nouls;
  if (
    ageDays >= t.staleDays &&
    n.stale >= t.staleConfidence &&
    n.automated_sender >= STALE_AUTOMATED_MIN &&
    n.needs_reply < STALE_NEEDS_REPLY_MAX &&
    n.financial_exception < STALE_FINANCIAL_MAX &&
    n.money_movement < STALE_FINANCIAL_MAX
  ) return { kind: 'auto_archive' };

  if (n.important >= t.importantQueue) {
    return { kind: 'queue', card: 'important', suggestKeep: n.needs_reply >= t.needsReplyQueue };
  }
  if (n.needs_reply >= t.needsReplyQueue) return { kind: 'queue', card: 'filing', suggestKeep: true };

  const guard =
    n.financial_exception >= t.guardNoul ||
    n.money_movement >= t.guardNoul ||
    n.automated_sender < t.guardNoul ||
    n.important >= t.guardNoul;
  const { choice, confidence } = a.destination;

  const triageArchive = !guard && triageSaysArchive(n, ageDays, t.recentDays);

  // Junk: triage says archive and Jev does not want it kept. Similar folders split the vote, so a weak
  // pick means archive; a confident pick is proposed.
  // Needs an explicit keep probability: absent means Jev did not say, and 'keep' as the pick is a vote to keep.
  const keepP = a.destination.probabilities.keep;
  if (triageArchive && choice !== 'keep' && keepP !== undefined && keepP <= t.junkMaxKeep) {
    if (choice.startsWith('label:') && confidence >= t.proposeConfidence) return { kind: 'proposed', dest: choice };
    return { kind: 'auto_archive' };
  }

  if (
    triageArchive &&
    choice === 'archive' &&
    confidence >= t.autoArchiveConfidence
  ) return { kind: 'auto_archive' };

  if (!guard && choice !== 'archive' && confidence >= t.proposeConfidence) return { kind: 'proposed', dest: choice };

  return { kind: 'queue', card: 'filing', suggestKeep: false };
}
