import type React from 'react';
import type { CardSpec, Dest } from '../../shared/types';
import { FilingCard } from './FilingCard';
import { ImportantCard } from './ImportantCard';

/**
 * Gen UI step 3. The server's decide() picked an outcome and toCard() built a typed CardSpec;
 * this registry is the fixed, hand-written set of components that can draw one.
 */
export interface CardProps {
  card: CardSpec;
  /** Every folder the "Other folder…" picker offers. */
  folders: string[];
  /** Called once per card. A returned promise that rejects shows its message on the card and unlocks it. */
  onChoose: (dest: Dest, opts?: { star?: boolean }) => void | Promise<void>;
  /** Where this card sits in the batch, for the "Batch 2 · #4 of 20" line. */
  context?: { batchNo: number; total: number };
}

export const CARD_REGISTRY: Record<CardSpec['kind'], React.FC<CardProps>> = {
  filing: FilingCard,
  important: ImportantCard,
};

/** The one place a CardSpec turns into UI. */
export function GeneratedCard(props: CardProps) {
  const Card = CARD_REGISTRY[props.card.kind];
  return Card ? <Card {...props} /> : null;
}
