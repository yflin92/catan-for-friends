// The in-game screen for C-4: board, setup placements, roll, builds with a confirmation step, and end turn. The UI
// offers only what view.legal allows and never changes the view itself: after an action it shows a pending state
// until the server's state and outcome arrive.
import { useState } from 'react';
import type { Action, EdgeId, HexId, VertexId } from '@hexlands/engine';
import type { OutcomeRecord } from '@hexlands/protocol';
import { Board } from '../board/Board';
import { edgeLabel, vertexLabel } from '../board/labels';
import type { PickMode } from '../board/legal-targets';
import { reasonText } from '../reasons';
import type { StoreSnapshot } from '../store';
import type { PlayerViewWire } from '../wire';
import { BUILD_COST, buildable, formatCounts, lastRoll, phasePick, shortfall, type BuildKind } from './turn-model';

export interface GameActions {
  act(action: Action): Promise<OutcomeRecord>;
}

export const OFFLINE_GAME_ACTIONS: GameActions = {
  act: () => Promise.resolve({ actionId: null, result: 'error', reasonCode: 'internal_error' }),
};

interface Proposal {
  readonly action: Action;
  readonly text: string;
}

const BUILD_LABEL: Readonly<Record<BuildKind, string>> = { road: 'Road', settlement: 'Settlement', city: 'City' };

export function GameScreen({ snapshot, view, actions }: { snapshot: StoreSnapshot; view: PlayerViewWire; actions: GameActions }) {
  const [buildMode, setBuildMode] = useState<BuildKind | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const waiting = snapshot.pending.size > 0;
  const { legal } = view;
  const forced = phasePick(view);
  const can = buildable(view);
  const activeMode: PickMode | null = forced ?? (buildMode !== null && can[buildMode] ? buildMode : null);
  const pick = proposal === null && !waiting ? activeMode : null;
  const hexes = view.board.hexes;
  const isSetup = legal.phase === 'setupSettlement' || legal.phase === 'setupRoad';

  const send = async (action: Action) => {
    setError(null);
    setProposal(null);
    const o = await actions.act(action);
    if (o.result !== 'ok') setError(reasonText(o.reasonCode));
    else setBuildMode(null);
  };

  const propose = (action: Action, text: string) => {
    setError(null);
    setProposal({ action, text });
  };

  const onPickVertex = (v: VertexId) => {
    if (activeMode === 'city') propose({ type: 'buildCity', vertex: v }, `Upgrade to a city at the ${vertexLabel(hexes, v)}?`);
    else propose({ type: 'placeSettlement', vertex: v }, `Place a settlement at the ${vertexLabel(hexes, v)}?`);
  };
  const onPickEdge = (e: EdgeId) => propose({ type: 'placeRoad', edge: e }, `Place a road on the ${edgeLabel(hexes, e)}?`);
  const onPickHex = (h: HexId) => void h;

  const roll = lastRoll(view);
  const myTurn = legal.seat === view.turn.active;
  const activeName = snapshot.room?.seats.find((s) => s.seat === view.turn.active)?.name ?? `Seat ${view.turn.active + 1}`;

  return (
    <main className="game">
      <div className="game-board">
        <Board view={view} pick={pick} onPickVertex={onPickVertex} onPickEdge={onPickEdge} onPickHex={onPickHex} />
      </div>
      <aside className="game-panel" aria-label="Your turn">
        <p className="turn-status" data-testid="turn-status">
          {myTurn ? statusText(view, activeMode) : `Waiting for ${activeName} (Seat ${view.turn.active + 1})…`}
        </p>
        {roll !== null && (
          <p className="dice" data-testid="dice">
            Rolled {roll.dice[0]} + {roll.dice[1]} = {roll.dice[0] + roll.dice[1]}
            {roll.gains !== null && <> · you got {formatCounts(roll.gains)}</>}
          </p>
        )}
        {waiting && (
          <p className="pending" role="status">
            Waiting for the server…
          </p>
        )}
        {error !== null && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {proposal !== null && (
          <div className="confirm" role="dialog" aria-label="Confirm">
            <p>{proposal.text}</p>
            <button type="button" className="primary" disabled={waiting} onClick={() => void send(proposal.action)}>
              Confirm
            </button>
            <button type="button" onClick={() => setProposal(null)}>
              Cancel
            </button>
          </div>
        )}
        {legal.rollDice && (
          <button type="button" className="primary" disabled={waiting} onClick={() => void send({ type: 'rollDice' })}>
            Roll dice
          </button>
        )}
        {!isSetup && legal.phase === 'main' && myTurn && (
          <div className="builds" role="group" aria-label="Build">
            {(['road', 'settlement', 'city'] as const).map((k) => {
              const missing = can[k] ? null : shortfall(BUILD_COST[k], view.hand);
              return (
                <button
                  key={k}
                  type="button"
                  aria-pressed={buildMode === k}
                  disabled={waiting || !can[k]}
                  onClick={() => {
                    setProposal(null);
                    setBuildMode(buildMode === k ? null : k);
                  }}
                >
                  <span className="build-name">{BUILD_LABEL[k]}</span>
                  <span className="build-cost">{formatCounts(BUILD_COST[k])}</span>
                  {missing !== null && <span className="build-missing">{missing}</span>}
                </button>
              );
            })}
          </div>
        )}
        {legal.endTurn && (
          <button type="button" disabled={waiting} onClick={() => void send({ type: 'endTurn' })}>
            End turn
          </button>
        )}
      </aside>
    </main>
  );
}

function statusText(view: PlayerViewWire, mode: PickMode | null): string {
  switch (view.legal.phase) {
    case 'setupSettlement':
      return 'Place your starting settlement.';
    case 'setupRoad':
      return 'Place a road next to your new settlement.';
    case 'preRoll':
      return 'Your turn: roll the dice.';
    case 'main':
      return mode === null ? 'Your turn: build, trade or end your turn.' : `Choose where to build a ${mode}.`;
    default:
      return 'Your turn.';
  }
}
