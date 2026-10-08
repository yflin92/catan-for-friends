// Largest Army (R11, design §6). The award needs at least LARGEST_ARMY_MIN played knights; a holder keeps it on a tie
// and loses it only to a seat with strictly more.
import type { Seat } from './ids';
import { emit } from './log';
import type { GameState } from './state';

export const LARGEST_ARMY_MIN = 3;

/** Re-evaluates the award after `seat` played a knight, logging awardChanged when it moves. */
export function updateLargestArmy(state: GameState, seat: Seat): GameState {
  const knights = (s: Seat) => state.players[s]?.playedDev.knight ?? 0;
  const holder = state.awards.largestArmy;
  if (holder === seat || knights(seat) < LARGEST_ARMY_MIN) return state;
  if (holder !== null && knights(seat) <= knights(holder)) return state;
  const moved: GameState = { ...state, awards: { ...state.awards, largestArmy: seat } };
  return emit(moved, { kind: 'awardChanged', award: 'largestArmy', from: holder, to: seat });
}
