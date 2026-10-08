// Build and purchase costs (R3) and hand/bank arithmetic.
import type { Seat } from './ids';
import type { GameState, ResourceCounts } from './state';
import { RESOURCES } from './state';

const C = (brick: number, lumber: number, wool: number, grain: number, ore: number): ResourceCounts =>
  Object.freeze({ brick, lumber, wool, grain, ore });

export const COSTS = Object.freeze({
  road: C(1, 1, 0, 0, 0),
  settlement: C(1, 1, 1, 1, 0),
  city: C(0, 0, 0, 2, 3),
  devCard: C(0, 0, 1, 1, 1),
});

/** Whether `hand` holds at least `cost` of every resource. */
export function covers(hand: ResourceCounts, cost: ResourceCounts): boolean {
  return RESOURCES.every((r) => hand[r] >= cost[r]);
}

/** Moves `cost` from `seat`'s hand to the bank. The caller has checked covers(). */
export function payToBank(state: GameState, seat: Seat, cost: ResourceCounts): GameState {
  const minus = (a: ResourceCounts): ResourceCounts =>
    Object.fromEntries(RESOURCES.map((r) => [r, a[r] - cost[r]])) as unknown as ResourceCounts;
  const plus = (a: ResourceCounts): ResourceCounts =>
    Object.fromEntries(RESOURCES.map((r) => [r, a[r] + cost[r]])) as unknown as ResourceCounts;
  return {
    ...state,
    bank: plus(state.bank),
    players: state.players.map((p, i) => (i === seat ? { ...p, hand: minus(p.hand) } : p)),
  };
}
