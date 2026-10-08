// Internal turn-machine contracts (design §6.2). Not part of the public API: the engine entry does not re-export this
// module and dependency-cruiser forbids importing internal/* from outside packages/engine/src.
import type { HexId, Seat } from '../ids';
import { emit } from '../log';
import type { GameState, Phase, PhaseName } from '../state';
import { STANDARD_TOPOLOGY } from '../topology';
import { victoryPoints } from '../victory';

/** The ONLY writer of state.phase. When the phase name changes it first calls onPhaseExit. */
export function setPhase(state: GameState, next: Phase): GameState {
  const from = state.phase.name;
  const exited = next.name !== from ? onPhaseExit(state, from, next.name) : state;
  return { ...exited, phase: next };
}

/** Phase-exit hook. Leaving main with an open offer clears it and logs tradeResolved{outcome:'withdrawn', exitTo}
 *  (R13). Otherwise the identity. */
export function onPhaseExit(state: GameState, from: PhaseName, to: PhaseName): GameState {
  if (from !== 'main' || state.trade === null) return state;
  const tradeId = state.trade.id;
  return emit({ ...state, trade: null }, { kind: 'tradeResolved', tradeId, outcome: 'withdrawn', partner: null, exitTo: to });
}

/**
 * Victory check (R14, D3). Called last on every successful reduce and inside beginTurn. Outside the setup phases and
 * gameOver, if the ACTIVE seat's total VP (hidden VP cards included) reaches config.vpTarget: setPhase(gameOver{winner})
 * (which withdraws any open offer) and log gameOver{winner, vp} with every seat's total. A seat that reaches the target
 * off-turn does not win until beginTurn makes it active.
 */
export function checkVictory(state: GameState): GameState {
  const phase = state.phase.name;
  if (phase === 'gameOver' || phase === 'setupSettlement' || phase === 'setupRoad') return state;
  const winner = state.turn.active;
  if (victoryPoints(state, winner).total < state.config.vpTarget) return state;
  const vp = state.players.map((_, s) => victoryPoints(state, s as Seat).total);
  return emit(setPhase(state, { name: 'gameOver', winner }), { kind: 'gameOver', winner, vp });
}

/** Starts `seat`'s turn: turn = {number + 1, active: seat, dice: null, devPlayed: false}, phase preRoll (withdrawing any
 *  open offer), then checkVictory, so a seat already at the target wins before preRoll accepts any action. */
export function beginTurn(state: GameState, seat: Seat): GameState {
  const turned: GameState = {
    ...state,
    turn: { number: state.turn.number + 1, active: seat, dice: null, devPlayed: false },
  };
  return checkVictory(setPhase(turned, { name: 'preRoll' }));
}

/**
 * Legal robber destinations (design §5.3(4), §6.2), in canonical hex index order (row-major: r ascending, then q
 * ascending). Every board hex except the robber's. With friendlyRobber enabled, hexes touching a building of a seat
 * other than the mover (turn.active) whose public VP ≤ maxPublicVp are excluded, unless that leaves none (R9 fallback),
 * in which case every hex except the robber's is legal. Never empty on a standard board. legalActions, the moveRobber
 * handler and the auto-robber all use this list.
 */
export function robberTargets(state: GameState): readonly HexId[] {
  const others = state.board.hexes
    .map((h) => h.id)
    .filter((id) => id !== state.robber)
    .sort(compareHexIds);
  const { enabled, maxPublicVp } = state.config.friendlyRobber;
  if (!enabled) return others;
  const shielded = (seat: Seat) => seat !== state.turn.active && victoryPoints(state, seat).public <= maxPublicVp;
  const allowed = others.filter((h) => !buildingOwnersOn(state, h).some(shielded));
  return allowed.length > 0 ? allowed : others;
}

/** The seats owning a settlement or city on a corner of `hex`, ascending and without repeats. */
export function buildingOwnersOn(state: GameState, hex: HexId): readonly Seat[] {
  const owners = new Set<Seat>();
  for (const v of STANDARD_TOPOLOGY.hexCorners(hex)) {
    const owner = state.pieces.settlements[v] ?? state.pieces.cities[v];
    if (owner !== undefined) owners.add(owner);
  }
  return [...owners].sort((a, b) => a - b);
}

function compareHexIds(a: HexId, b: HexId): number {
  const [qa, ra] = a.slice(2).split(',').map(Number) as [number, number];
  const [qb, rb] = b.slice(2).split(',').map(Number) as [number, number];
  return ra - rb || qa - qb;
}
