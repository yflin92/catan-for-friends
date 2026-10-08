// Test drivers that play legal moves through reduce, for building realistic states.
import type { EdgeId, Seat, VertexId } from '../ids';
import { legalActions } from '../legal-actions';
import { reduce } from '../reduce';
import type { Command } from '../events';
import type { GameState } from '../state';
import { buildState } from '../testing';

export const settle = (by: Seat, vertex: VertexId): Command => ({ by, action: { type: 'placeSettlement', vertex } });
export const road = (by: Seat, edge: EdgeId): Command => ({ by, action: { type: 'placeRoad', edge } });
export const city = (by: Seat, vertex: VertexId): Command => ({ by, action: { type: 'buildCity', vertex } });

/** reduce, throwing if the command is rejected. */
export function apply(s: GameState, cmd: Command): GameState {
  const r = reduce(s, cmd);
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
  return r.state;
}

/** A fresh n-player state at the start of the setup draft. */
export const setupStart = (playerCount: 3 | 4 = 4): GameState =>
  buildState({ playerCount, phase: { name: 'setupSettlement', round: 1 }, turn: { number: 0, active: 0 } });

/** Plays the whole setup draft, picking each placement from the legal lists with `pick(listLength)`. Returns every
 *  intermediate state and the seat order of the settlement placements. */
export function playSetup(start: GameState, pick: (n: number) => number): { states: GameState[]; order: Seat[] } {
  const states = [start];
  const order: Seat[] = [];
  let s = start;
  for (let i = 0; i < 2 * s.playerCount; i++) {
    const seat = s.turn.active;
    order.push(seat);
    const sites = legalActions(s, seat).placeSettlement;
    s = apply(s, settle(seat, sites[pick(sites.length)]!));
    states.push(s);
    const edges = legalActions(s, seat).placeRoad;
    s = apply(s, road(seat, edges[pick(edges.length)]!));
    states.push(s);
  }
  return { states, order };
}
