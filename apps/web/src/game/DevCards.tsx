// Development cards (AC12–AC14): buy, the hand list with playableNow, and playing Knight, Road Building, Year of
// Plenty (only the pairs view.legal offers) and Monopoly. Victory point cards are listed and never playable.
import { useState } from 'react';
import { RESOURCES, type Action, type DevCardKind, type Resource } from '@hexlands/engine';
import { RESOURCE_NAME } from '../board/art';
import type { PlayerViewWire } from '../wire';

export const DEV_CARD_NAME: Readonly<Record<DevCardKind, string>> = {
  knight: 'Knight',
  roadBuilding: 'Road Building',
  yearOfPlenty: 'Year of Plenty',
  monopoly: 'Monopoly',
  victoryPoint: 'Victory Point',
};

export function DevCards({ view, busy, onAction }: { view: PlayerViewWire; busy: boolean; onAction(a: Action): void }) {
  const { legal } = view;
  const [choosing, setChoosing] = useState<'yearOfPlenty' | 'monopoly' | null>(null);
  const counts = new Map<DevCardKind, { total: number; playable: number }>();
  for (const c of view.devCards) {
    const e = counts.get(c.kind) ?? { total: 0, playable: 0 };
    counts.set(c.kind, { total: e.total + 1, playable: e.playable + (c.playableNow ? 1 : 0) });
  }
  const canPlay: Readonly<Record<Exclude<DevCardKind, 'victoryPoint'>, boolean>> = {
    knight: legal.playKnight,
    roadBuilding: legal.playRoadBuilding,
    yearOfPlenty: legal.playYearOfPlenty.length > 0,
    monopoly: legal.playMonopoly,
  };
  const play = (kind: Exclude<DevCardKind, 'victoryPoint'>) => {
    if (kind === 'knight') onAction({ type: 'playKnight' });
    else if (kind === 'roadBuilding') onAction({ type: 'playRoadBuilding' });
    else setChoosing(kind);
  };

  return (
    <section className="dev-cards" aria-label="Development cards">
      <h3>Development cards</h3>
      {view.devCards.length === 0 ? (
        <p className="hint">You have none.</p>
      ) : (
        <ul>
          {[...counts].map(([kind, n]) => (
            <li key={kind} data-dev-card={kind}>
              <span>
                {DEV_CARD_NAME[kind]} × {n.total}
              </span>
              {kind === 'victoryPoint' ? (
                <span className="hint">counts at the end</span>
              ) : (
                <button type="button" disabled={busy || !canPlay[kind]} onClick={() => play(kind)}>
                  Play {DEV_CARD_NAME[kind]}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {choosing === 'yearOfPlenty' && (
        <div className="confirm" role="dialog" aria-label="Year of Plenty">
          <p>Take two resources from the bank:</p>
          {legal.playYearOfPlenty.map(([a, b]) => (
            <button
              key={`${a}-${b}`}
              type="button"
              disabled={busy}
              onClick={() => {
                setChoosing(null);
                onAction({ type: 'playYearOfPlenty', take: [a, b] });
              }}
            >
              {a === b ? `2 ${RESOURCE_NAME[a].toLowerCase()}` : `${RESOURCE_NAME[a].toLowerCase()} + ${RESOURCE_NAME[b].toLowerCase()}`}
            </button>
          ))}
          <button type="button" onClick={() => setChoosing(null)}>
            Cancel
          </button>
        </div>
      )}
      {choosing === 'monopoly' && (
        <div className="confirm" role="dialog" aria-label="Monopoly">
          <p>Take every card of one resource from the other players:</p>
          {RESOURCES.map((r: Resource) => (
            <button
              key={r}
              type="button"
              disabled={busy}
              onClick={() => {
                setChoosing(null);
                onAction({ type: 'playMonopoly', resource: r });
              }}
            >
              {RESOURCE_NAME[r]}
            </button>
          ))}
          <button type="button" onClick={() => setChoosing(null)}>
            Cancel
          </button>
        </div>
      )}
      {legal.buyDevCard && (
        <button type="button" disabled={busy} onClick={() => onAction({ type: 'buyDevCard' })}>
          Buy development card <span className="build-cost">1 wool, 1 grain, 1 ore</span>
        </button>
      )}
    </section>
  );
}
