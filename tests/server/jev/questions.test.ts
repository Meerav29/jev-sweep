import { expect, test } from 'vitest';
import { ageDays, buildQuestions, buildState } from '../../../server/jev/questions';
import { NOUL_IDS } from '../../../shared/types';
import { email, folders } from './fixtures';

test('destination choice has archive, keep and one key per enabled folder', () => {
  const { questions, keyToDest } = buildQuestions(folders);
  expect(keyToDest).toEqual({ archive: 'archive', keep_in_inbox: 'keep', label_0: 'label:Finance/Statements' });
  expect(questions.destination.type).toBe('choice');
  expect(JSON.stringify(questions.destination)).toContain('bank statements');
  expect(JSON.stringify(questions.destination)).not.toContain('Travel');
});
test('folder without description still gets criteria text with its name', () => {
  const { questions } = buildQuestions([{ name: 'Travel', enabled: true }]);
  expect(JSON.stringify(questions.destination)).toContain('Move to the Gmail folder \\"Travel\\"');
});
test('asks every noul id', () => {
  expect(Object.keys(buildQuestions([]).questions).sort()).toEqual(['destination', ...NOUL_IDS].sort());
});
test('state truncates body to 2000 and includes folders + age', () => {
  const s = buildState({ ...email, body: 'x'.repeat(5000), date: '2026-10-21T00:00:00Z' }, folders, new Date('2026-10-31T00:00:00Z'));
  expect((s.body as string).length).toBe(2000);
  expect(s.age_days).toBe(10);
  expect(s.folders).toEqual([{ name: 'Finance/Statements', description: 'bank statements' }]);
  expect(s).toMatchObject({ from_name: 'Ann', from_address: 'ann@example.com', subject: 'Hello', gmail_labels: ['INBOX', 'UNREAD'] });
});
test('ageDays floors and never goes negative', () => {
  const now = new Date('2026-10-31T00:00:00Z');
  expect(ageDays('2026-10-29T12:00:00Z', now)).toBe(1);
  expect(ageDays('2026-11-02T00:00:00Z', now)).toBe(0);
});
