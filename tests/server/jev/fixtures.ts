import type { Email, Folder } from '../../../shared/types';

export const email: Email = {
  threadId: 't1', latestMessageId: 'm1', fromName: 'Ann', fromAddress: 'ann@example.com',
  subject: 'Hello', date: '2026-10-21T00:00:00Z', labels: ['INBOX', 'UNREAD'], body: 'hi there', unread: true,
};
export const folders: Folder[] = [
  { name: 'Finance/Statements', enabled: true, description: 'bank statements' },
  { name: 'Travel', enabled: false },
];
