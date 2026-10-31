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
test('archive confidence below 0.85 queues', () => expect(decide(ans({ destination: { choice: 'archive', confidence: 0.84 } }), 30, T)).toEqual({ kind: 'queue', card: 'filing', suggestKeep: false }));
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
