import { expect, test } from 'vitest';
import { decide, triageSaysArchive } from '../../../server/policy/decide';
import { DEFAULT_SETTINGS, NOUL_IDS } from '../../../shared/types';
import type { JevAnswers, NoulId } from '../../../shared/types';

const T = DEFAULT_SETTINGS.thresholds;

function ans(o: { nouls?: Partial<Record<NoulId, number>>; destination?: Partial<JevAnswers['destination']> }): JevAnswers {
  const nouls = Object.fromEntries(NOUL_IDS.map((k) => [k, 0.1])) as Record<NoulId, number>;
  nouls.automated_sender = 0.95;
  nouls.bulk_marketing = 0.97;
  return {
    nouls: { ...nouls, ...o.nouls },
    destination: { choice: 'archive', confidence: 0.9, probabilities: {}, ...o.destination },
  };
}

test('obvious old promo auto-archives', () => expect(decide(ans({}), 30, T)).toEqual({ kind: 'auto_archive' }));
test('recent mail needs the strict promo bar', () => expect(decide(ans({ nouls: { bulk_marketing: 0.9 } }), 2, T).kind).toBe('queue'));
test('archive confidence below 0.85 queues when keep is plausible', () => expect(decide(ans({ destination: { choice: 'archive', confidence: 0.84, probabilities: { keep: 0.3 } } }), 30, T)).toEqual({ kind: 'queue', card: 'filing', suggestKeep: false }));
test('financial exception never auto-archives', () => expect(decide(ans({ nouls: { financial_exception: 0.5 } }), 30, T).kind).toBe('queue'));
test('human-written never auto-archives or proposes', () => expect(decide(ans({ nouls: { automated_sender: 0.4 }, destination: { choice: 'label:Travel', confidence: 0.9 } }), 30, T).kind).toBe('queue'));
test('important wins and goes to the important card', () => expect(decide(ans({ nouls: { important: 0.7, needs_reply: 0.8 } }), 30, T)).toEqual({ kind: 'queue', card: 'important', suggestKeep: true }));
test('needs reply queues with keep suggested', () => expect(decide(ans({ nouls: { needs_reply: 0.7 } }), 30, T)).toEqual({ kind: 'queue', card: 'filing', suggestKeep: true }));
test('confident folder is proposed, never applied', () => expect(decide(ans({ nouls: { bulk_marketing: 0.1 }, destination: { choice: 'label:Travel', confidence: 0.6 } }), 30, T)).toEqual({ kind: 'proposed', dest: 'label:Travel' }));
test('jev failure queues', () => expect(decide({ ...ans({}), failed: true }, 30, T).kind).toBe('queue'));
test('triageSaysArchive matches score.py for dev bots', () => expect(triageSaysArchive({ ...ans({}).nouls, bulk_marketing: 0.1, newsletter: 0.1, dev_bot: 0.85 }, 30, 7)).toBe(true));

test('triageSaysArchive: recent promo at 0.95 with low attention archives', () =>
  expect(triageSaysArchive({ ...ans({}).nouls, bulk_marketing: 0.95 }, 2, 7)).toBe(true));
test('triageSaysArchive: newsletter gets +0.05 (0.80 bar)', () =>
  expect(triageSaysArchive({ ...ans({}).nouls, bulk_marketing: 0.1, newsletter: 0.8 }, 30, 7)).toBe(true));
test('triageSaysArchive: stale transactional from automated sender archives', () =>
  expect(triageSaysArchive({ ...ans({}).nouls, bulk_marketing: 0.1, transactional: 0.85, automated_sender: 0.8 }, 30, 7)).toBe(true));
test('triageSaysArchive: no rule matched is false', () =>
  expect(triageSaysArchive({ ...ans({}).nouls, bulk_marketing: 0.1 }, 30, 7)).toBe(false));

// Policy v2: stale rule and junk rule.
const STALE = { stale: 0.9, automated_sender: 0.95 };
const staleAns = (nouls: Partial<Record<NoulId, number>> = {}, destination: Partial<JevAnswers['destination']> = {}) =>
  ans({ nouls: { bulk_marketing: 0.1, ...STALE, ...nouls }, destination: { choice: 'label:Travel', confidence: 0.3, ...destination } });

test('v2 defaults: staleDays 14, staleConfidence 0.85, junkMaxKeep 0.15', () =>
  expect([T.staleDays, T.staleConfidence, T.junkMaxKeep]).toEqual([14, 0.85, 0.15]));
test('stale rule: old, stale, automated mail auto-archives even with a folder pick', () =>
  expect(decide(staleAns(), 30, T)).toEqual({ kind: 'auto_archive' }));
test('stale rule beats important', () =>
  expect(decide(staleAns({ important: 0.9 }), 30, T)).toEqual({ kind: 'auto_archive' }));
test('stale rule does not fire below staleDays', () => {
  expect(decide(staleAns({ important: 0.9 }), 13, T)).toEqual({ kind: 'queue', card: 'important', suggestKeep: false });
  expect(decide(staleAns(), 14, T)).toEqual({ kind: 'auto_archive' });
});
test('stale rule: staleConfidence boundary', () => {
  expect(decide(staleAns({ stale: 0.85 }), 30, T)).toEqual({ kind: 'auto_archive' });
  expect(decide(staleAns({ stale: 0.84 }), 30, T).kind).not.toBe('auto_archive');
});
test('stale near-miss: automated_sender below 0.9', () =>
  expect(decide(staleAns({ automated_sender: 0.89, important: 0.9 }), 30, T).kind).toBe('queue'));
test('stale near-miss: needs_reply 0.3 or more', () =>
  expect(decide(staleAns({ needs_reply: 0.3 }), 30, T).kind).not.toBe('auto_archive'));
test('stale near-miss: needs_reply 0.8 queues for filing with keep', () =>
  expect(decide(staleAns({ needs_reply: 0.8 }), 30, T)).toEqual({ kind: 'queue', card: 'filing', suggestKeep: true }));
test('stale near-miss: financial_exception 0.5', () =>
  expect(decide(staleAns({ financial_exception: 0.5 }), 30, T).kind).toBe('queue'));
test('stale near-miss: money_movement 0.5', () =>
  expect(decide(staleAns({ money_movement: 0.5 }), 30, T).kind).toBe('queue'));
test('stale near-miss: a record (stale low) is not archived on staleness', () =>
  expect(decide(staleAns({ stale: 0.1 }), 30, T).kind).toBe('queue'));

const junkAns = (keep: number | undefined, choice: JevAnswers['destination']['choice'], confidence: number) =>
  ans({
    nouls: { stale: 0.05 },
    destination: { choice, confidence, probabilities: keep === undefined ? {} : { keep } },
  });

test('junk rule: triage-archive with a low-confidence folder pick auto-archives', () =>
  expect(decide(junkAns(0.05, 'label:Travel', 0.4), 30, T)).toEqual({ kind: 'auto_archive' }));
test('junk rule: a missing keep probability never fires it (queues for the owner)', () =>
  expect(decide(junkAns(undefined, 'label:Travel', 0.4), 30, T)).toEqual({ kind: 'queue', card: 'filing', suggestKeep: false }));
test('junk rule: choice keep is never auto-archived, even with keep 0.05 (it is proposed as keep)', () =>
  expect(decide(junkAns(0.05, 'keep', 0.9), 30, T)).toEqual({ kind: 'proposed', dest: 'keep' }));
test('junk rule: choice keep with weak confidence queues, never auto-archives', () =>
  expect(decide(junkAns(0.05, 'keep', 0.3), 30, T)).toEqual({ kind: 'queue', card: 'filing', suggestKeep: false }));
test('junk rule: confident folder pick is proposed', () =>
  expect(decide(junkAns(0.05, 'label:Travel', 0.7), 30, T)).toEqual({ kind: 'proposed', dest: 'label:Travel' }));
test('junk rule: confidence at proposeConfidence proposes, just below archives', () => {
  expect(decide(junkAns(0.05, 'label:Travel', 0.6), 30, T)).toEqual({ kind: 'proposed', dest: 'label:Travel' });
  expect(decide(junkAns(0.05, 'label:Travel', 0.59), 30, T)).toEqual({ kind: 'auto_archive' });
});
test('junk rule: junkMaxKeep boundary', () => {
  expect(decide(junkAns(0.15, 'label:Travel', 0.4), 30, T)).toEqual({ kind: 'auto_archive' });
  expect(decide(junkAns(0.16, 'label:Travel', 0.4), 30, T)).toEqual({ kind: 'queue', card: 'filing', suggestKeep: false });
});
test('junk rule does not fire when triage does not say archive', () =>
  expect(decide(ans({ nouls: { bulk_marketing: 0.1, stale: 0.05 }, destination: { choice: 'label:Travel', confidence: 0.4, probabilities: { keep: 0.05 } } }), 30, T).kind).toBe('queue'));
test('junk rule does not fire when guarded', () =>
  expect(decide(ans({ nouls: { important: 0.6, stale: 0.05 }, destination: { choice: 'label:Travel', confidence: 0.4, probabilities: { keep: 0.05 } } }), 30, T).kind).toBe('queue'));
test('archive confidence below 0.85 with keep unlikely is junk and auto-archives', () =>
  expect(decide(ans({ destination: { choice: 'archive', confidence: 0.84, probabilities: { keep: 0.05 } } }), 30, T)).toEqual({ kind: 'auto_archive' }));

// Mail someone may be waiting on is never archived by the junk rule.
const junkReply = (needsReply: number) =>
  ans({
    nouls: { stale: 0.05, needs_reply: needsReply },
    destination: { choice: 'label:Travel', confidence: 0.4, probabilities: { keep: 0.05 } },
  });
test('junk rule: needs_reply 0.29 still auto-archives', () =>
  expect(decide(junkReply(0.29), 30, T)).toEqual({ kind: 'auto_archive' }));
test('junk rule: needs_reply 0.3 does not auto-archive', () =>
  expect(decide(junkReply(0.3), 30, T).kind).not.toBe('auto_archive'));
test('junk rule: needs_reply 0.6 does not auto-archive', () =>
  expect(decide(junkReply(0.6), 30, T).kind).not.toBe('auto_archive'));

// Confident-archive branch (no keep figure, so the junk rule is skipped) has the same protection.
const confidentArchive = (needsReply: number) =>
  ans({ nouls: { stale: 0.05, needs_reply: needsReply }, destination: { choice: 'archive', confidence: 0.9, probabilities: {} } });
test('confident archive: needs_reply 0.29 still auto-archives', () =>
  expect(decide(confidentArchive(0.29), 30, T)).toEqual({ kind: 'auto_archive' }));
test('confident archive: needs_reply 0.3 does not auto-archive', () =>
  expect(decide(confidentArchive(0.3), 30, T).kind).not.toBe('auto_archive'));
test('confident archive: needs_reply 0.6 does not auto-archive', () =>
  expect(decide(confidentArchive(0.6), 30, T).kind).not.toBe('auto_archive'));
