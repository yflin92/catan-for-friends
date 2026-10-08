// The in-game screen for C-4: board, setup placements, roll, builds with a confirmation step, and end turn. The UI
// offers only what view.legal allows and never changes the view itself: after an action it shows a pending state
// until the server's state and outcome arrive.
import { useState } from 'react';
import type { Action, EdgeId, HexId, ResourceCounts, Seat, VertexId } from '@hexlands/engine';
import type { OutcomeRecord } from '@hexlands/protocol';
import { Board } from '../board/Board';
import { RESOURCE_NAME } from '../board/art';
import { edgeLabel, hexName, vertexLabel } from '../board/labels';
import type { PickMode } from '../board/legal-targets';
import { reasonText } from '../reasons';
import type { StoreSnapshot } from '../store';
import type { LogEntryWire, PlayerViewWire } from '../wire';
import { DevCards } from './DevCards';
import { DiscardDialog } from './DiscardDialog';
import { LogPanel } from './LogPanel';
import { PlayersPanel } from './PlayersPanel';
import { WinScreen } from './WinScreen';
import { seatName } from './names';
import { TradePanel } from './TradePanel';
import { BUILD_COST, buildable, formatCounts, lastRoll, lastSteal, phasePick, shortfall, type BuildKind } from './turn-model';

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

export function GameScreen({
  snapshot,
  view,
  actions,
  log,
}: {
  snapshot: StoreSnapshot;
  view: PlayerViewWire;
  actions: GameActions;
  /** Every log entry seen since load; defaults to the view's own window. */
  log?: readonly LogEntryWire[];
}) {
  const [buildMode, setBuildMode] = useState<BuildKind | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [robberHex, setRobberHex] = useState<{ hex: HexId; victims: readonly Seat[] } | null>(null);
  const waiting = snapshot.pending.size > 0;
  const { legal } = view;
  const forced = phasePick(view);
  const can = buildable(view);
  const activeMode: PickMode | null = forced ?? (buildMode !== null && can[buildMode] ? buildMode : null);
  const pick = proposal === null && robberHex === null && !waiting ? activeMode : null;
  const hexes = view.board.hexes;
  const isSetup = legal.phase === 'setupSettlement' || legal.phase === 'setupRoad';

  const send = async (action: Action) => {
    setError(null);
    setProposal(null);
    setRobberHex(null);
    const modeAtSend = buildMode;
    const o = await actions.act(action);
    if (o.result !== 'ok') setError(reasonText(o.reasonCode));
    // A build mode picked while the outcome was in flight is kept; only the mode the action was sent from resets.
    else setBuildMode((m) => (m === modeAtSend ? null : m));
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
  const onPickHex = (h: HexId) => {
    const target = legal.moveRobber.find((m) => m.hex === h);
    if (target === undefined) return;
    setError(null);
    // The victim is null exactly when nobody on the hex can be robbed (view.legal lists no victims).
    if (target.victims.length === 0) propose({ type: 'moveRobber', hex: h, victim: null }, `Move the robber to ${hexName(hexes, h)}? Nobody there can be robbed.`);
    else setRobberHex({ hex: h, victims: target.victims });
  };
  const owed = view.players.filter((p) => p.discardOwed > 0);
  const steal = lastSteal(view);

  const roll = lastRoll(view);
  const myTurn = legal.seat === view.turn.active;
  const activeName = snapshot.room?.seats.find((s) => s.seat === view.turn.active)?.name ?? `Seat ${view.turn.active + 1}`;

  return (
    <main className="game">
      <div className="game-board">
        <WinScreen view={view} room={snapshot.room} />
        <Board view={view} pick={pick} onPickVertex={onPickVertex} onPickEdge={onPickEdge} onPickHex={onPickHex} />
      </div>
      <aside className="game-panel" aria-label="Your turn">
        <PlayersPanel view={view} room={snapshot.room} />
        <p className="turn-status" data-testid="turn-status">
          {view.phase.name === 'gameOver'
            ? 'The game is over.'
            : myTurn
              ? statusText(view, activeMode)
              : `Waiting for ${activeName} (Seat ${view.turn.active + 1})…`}
        </p>
        {roll !== null && (
          <p className="dice" data-testid="dice">
            Rolled {roll.dice[0]} + {roll.dice[1]} = {roll.dice[0] + roll.dice[1]}
            {roll.gains !== null && <> · you got {formatCounts(roll.gains)}</>}
          </p>
        )}
        {steal !== null && (
          <p className="steal" data-testid="steal">
            {stealText(steal, view.you, (seat) => seatName(snapshot.room, seat as Seat))}
          </p>
        )}
        {view.phase.name === 'discard' && owed.length > 0 && legal.discard === null && (
          <p className="waiting-discards" role="status">
            Waiting for discards: {owed.map((p) => `${seatName(snapshot.room, p.seat)} (${p.discardOwed})`).join(', ')}
          </p>
        )}
        {legal.discard !== null && (
          <DiscardDialog
            key={`${view.turn.number}-${legal.discard.count}`}
            count={legal.discard.count}
            hand={view.hand}
            busy={waiting}
            onDiscard={(cards: ResourceCounts) => void send({ type: 'discard', cards })}
          />
        )}
        {robberHex !== null && (
          <div className="confirm" role="dialog" aria-label="Choose who to rob">
            <p>Rob a card from:</p>
            {robberHex.victims.map((victim) => (
              <button
                key={victim}
                type="button"
                disabled={waiting}
                onClick={() => void send({ type: 'moveRobber', hex: robberHex.hex, victim })}
              >
                {seatName(snapshot.room, victim)}
              </button>
            ))}
            <button type="button" onClick={() => setRobberHex(null)}>
              Cancel
            </button>
          </div>
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
        {(legal.phase === 'main' || view.trade !== null) && (
          <TradePanel view={view} room={snapshot.room} busy={waiting} onAction={(a) => void send(a)} />
        )}
        <DevCards view={view} busy={waiting} onAction={(a) => void send(a)} />
        {legal.endTurn && (
          <button type="button" disabled={waiting} onClick={() => void send({ type: 'endTurn' })}>
            End turn
          </button>
        )}
        <LogPanel entries={log ?? view.log} you={view.you} room={snapshot.room} />
      </aside>
    </main>
  );
}

function stealText(s: { thief: number; victim: number; resource: string | null }, you: number, name: (seat: number) => string): string {
  const what = s.resource !== null ? `1 ${RESOURCE_NAME[s.resource as keyof typeof RESOURCE_NAME].toLowerCase()}` : 'a card';
  if (s.thief === you) return `You stole ${what} from ${name(s.victim)}.`;
  if (s.victim === you) return `${name(s.thief)} stole ${what} from you.`;
  return `${name(s.thief)} stole a card from ${name(s.victim)}.`;
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
    case 'moveRobber':
      return 'Move the robber to a new hex.';
    case 'roadBuilding':
      return view.phase.name === 'roadBuilding' ? `Place a free road (${view.phase.remaining} left).` : 'Place a free road.';
    case 'discard':
      return view.legal.discard !== null ? `Discard ${view.legal.discard.count} cards.` : 'Waiting for discards.';
    case 'gameOver':
      return 'The game is over.';
    default:
      return 'Your turn.';
  }
}
