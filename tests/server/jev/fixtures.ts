import type { Email, Folder } from '../../../shared/types';

export const email: Email = {
  threadId: 't1', latestMessageId: 'm1', fromName: 'Ann', fromAddress: 'ann@example.com',
  subject: 'Hello', date: '2026-10-21T00:00:00Z', labels: ['INBOX', 'UNREAD'], body: 'hi there', unread: true,
};
export const folders: Folder[] = [
  { name: 'Finance/Statements', enabled: true, description: 'bank statements' },
  { name: 'Travel', enabled: false },
];

import { NOUL_IDS } from '../../../shared/types';
import type { JevAnswers, NoulId } from '../../../shared/types';
export function ans(o: { nouls?: Partial<Record<NoulId, number>>; destination?: Partial<JevAnswers['destination']> }): JevAnswers {
  const nouls = Object.fromEntries(NOUL_IDS.map((k) => [k, 0.1])) as Record<NoulId, number>;
  return {
    nouls: { ...nouls, ...o.nouls },
    destination: { choice: 'archive', confidence: 0.9, probabilities: {}, ...o.destination },
  };
}
