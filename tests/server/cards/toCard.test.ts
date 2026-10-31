import { expect, test } from 'vitest';
import { toCard } from '../../../server/cards/toCard';
import { truncate } from '../../../server/mail/provider';
import { ans, email } from '../jev/fixtures';

test('top 3 options sorted, labels humanised', () => {
  const c = toCard(email, 4, ans({ destination: { choice: 'label:Finance/Statements', confidence: .5, probabilities: { 'label:Finance/Statements': .71, 'label:Finance/Bills due': .19, archive: .06, keep: .04 } } }), { kind: 'queue', card: 'filing', suggestKeep: false }, { why: 'Has a due date.' });
  expect(c.options.map(o => [o.label, o.p])).toEqual([['Finance/Statements', .71], ['Finance/Bills due', .19], ['Archive', .06]]);
  expect(c).toMatchObject({ kind: 'filing', n: 4, why: 'Has a due date.', suggestKeep: false, gmailUrl: 'https://mail.google.com/mail/u/0/#all/t1' });
});
test('keep label and ties keep object order, fewer than 3 returns what exists', () => {
  const c = toCard(email, 1, ans({ destination: { choice: 'keep', confidence: .5, probabilities: { keep: .5, archive: .5 } } }), { kind: 'queue', card: 'filing', suggestKeep: false }, {});
  expect(c.options).toEqual([{ dest: 'keep', label: 'Keep in inbox', p: .5 }, { dest: 'archive', label: 'Archive', p: .5 }]);
});
test('important card carries the summary', () => expect(toCard(email, 1, ans({}), { kind: 'queue', card: 'important', suggestKeep: true }, { summary: ['Due Nov 20'] })).toMatchObject({ kind: 'important', summary: ['Due Nov 20'], suggestKeep: true }));
test('jev failure gives no options', () => expect(toCard(email, 1, { ...ans({ destination: { probabilities: { archive: 1 } } }), failed: true }, { kind: 'queue', card: 'filing', suggestKeep: false }, {}).options).toEqual([]));
test('body is truncated to 600', () => expect(toCard({ ...email, body: 'x'.repeat(900) }, 1, ans({}), { kind: 'queue', card: 'filing', suggestKeep: false }, {}).body).toBe('x'.repeat(600)));
test('truncate cuts at max', () => { expect(truncate('abcdef', 3)).toBe('abc'); expect(truncate('ab', 3)).toBe('ab'); });
