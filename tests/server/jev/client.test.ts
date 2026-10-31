import { expect, test, vi } from 'vitest';
import { FakeJev, TypeSafeJev } from '../../../server/jev/client';
import { NOUL_IDS, type JevAnswers } from '../../../shared/types';
import { email, folders } from './fixtures';

test('TypeSafeJev maps option keys back to Dest and pins the model', async () => {
  const sdk = { systemOne: vi.fn().mockResolvedValue({ answers: {
    destination: { choice: 'label_0', confidence: 0.5, probabilities: { archive: 0.1, keep_in_inbox: 0.1, label_0: 0.8 } },
    ...Object.fromEntries(NOUL_IDS.map(id => [id, { noul: 0.2 }])) } }) };
  const a = await new TypeSafeJev('k', 'jev-1.14.0', sdk as any).ask(email, folders);
  expect(sdk.systemOne.mock.calls[0][0].model).toBe('jev-1.14.0');
  expect(a.destination).toEqual({ choice: 'label:Finance/Statements', confidence: 0.5, probabilities: { archive: 0.1, keep: 0.1, 'label:Finance/Statements': 0.8 } });
  expect(a.nouls.important).toBe(0.2);
});
test('probabilities for options missing from the response are left out', async () => {
  const sdk = { systemOne: vi.fn().mockResolvedValue({ answers: {
    destination: { choice: 'archive', confidence: 0.9, probabilities: { archive: 0.9 } },
    ...Object.fromEntries(NOUL_IDS.map(id => [id, { noul: 0 }])) } }) };
  const a = await new TypeSafeJev('k', 'm', sdk as any).ask(email, folders);
  expect(a.destination.probabilities).toEqual({ archive: 0.9 });
});
test('FakeJev returns canned answers by thread and throws for unknown', async () => {
  const canned = { destination: { choice: 'archive', confidence: 1, probabilities: {} }, nouls: {} } as unknown as JevAnswers;
  const f = new FakeJev({ t1: canned });
  expect(await f.ask(email, folders)).toBe(canned);
  await expect(f.ask({ ...email, threadId: 'zz' }, folders)).rejects.toThrow(/zz/);
});
