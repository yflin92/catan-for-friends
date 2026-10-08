// Discard on a 7 (AC9): choose exactly legal.discard.count cards from the hand. Each seat discards on its own; the
// server applies a discard only when the total is right.
import { useState } from 'react';
import { RESOURCES, type Resource, type ResourceCounts } from '@hexlands/engine';
import { RESOURCE_NAME } from '../board/art';
import { Dialog } from './Dialog';

const ZERO: ResourceCounts = { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 };

export function DiscardDialog({ count, hand, busy, onDiscard }: { count: number; hand: ResourceCounts; busy: boolean; onDiscard(cards: ResourceCounts): void }) {
  const [cards, setCards] = useState<ResourceCounts>(ZERO);
  const total = RESOURCES.reduce((n, r) => n + cards[r], 0);
  const set = (r: Resource, n: number) => setCards({ ...cards, [r]: Math.max(0, Math.min(hand[r], n)) });
  return (
    <Dialog label="Discard" className="confirm discard">
      <p>
        Discard {count} card{count === 1 ? '' : 's'} ({total}/{count} chosen).
      </p>
      {RESOURCES.filter((r) => hand[r] > 0).map((r) => (
        <div key={r} className="counter" data-resource={r}>
          <span>
            {RESOURCE_NAME[r]} ({hand[r]})
          </span>
          <button type="button" aria-label={`One less ${RESOURCE_NAME[r].toLowerCase()}`} disabled={cards[r] === 0} onClick={() => set(r, cards[r] - 1)}>
            −
          </button>
          <output>{cards[r]}</output>
          <button
            type="button"
            aria-label={`One more ${RESOURCE_NAME[r].toLowerCase()}`}
            disabled={cards[r] >= hand[r] || total >= count}
            onClick={() => set(r, cards[r] + 1)}
          >
            +
          </button>
        </div>
      ))}
      <button type="button" className="primary" disabled={busy || total !== count} onClick={() => onDiscard(cards)}>
        Discard
      </button>
    </Dialog>
  );
}
