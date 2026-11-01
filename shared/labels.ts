import type { Dest } from './types';

const SYSTEM_LABELS = new Set(['INBOX', 'SPAM', 'TRASH', 'UNREAD', 'STARRED', 'IMPORTANT', 'SENT', 'DRAFT', 'CHAT']);

/** Gmail owns these names, so they can't be made into folders. */
export function isSystemLabel(name: string): boolean {
  const u = name.trim().toUpperCase();
  return SYSTEM_LABELS.has(u) || u.startsWith('CATEGORY_');
}

/** "Archive" in any case means the archive action, never a label. */
export function isArchiveName(name: string): boolean {
  return name.trim().toLowerCase() === 'archive';
}

/** The destination a typed folder name stands for. */
export function folderDest(name: string): Dest {
  return isArchiveName(name) ? 'archive' : `label:${name}`;
}
