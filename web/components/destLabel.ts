import type { Dest } from '../../shared/types';

/** A destination as the board and ticker name it. */
export function destLabel(d: Dest): string {
  if (d === 'archive') return 'Archived';
  if (d === 'keep') return 'Inbox';
  return d.slice('label:'.length);
}
