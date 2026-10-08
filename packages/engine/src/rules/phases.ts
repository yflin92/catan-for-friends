// Which action types each phase accepts (design §6.1), and which seats may submit them (AC11).
import type { ActionType } from '../events';
import type { Seat } from '../ids';
import type { GameState, PhaseName } from '../state';

const PLAY_DEV: readonly ActionType[] = ['playKnight', 'playRoadBuilding', 'playYearOfPlenty', 'playMonopoly'];

export const PHASE_ACTIONS: Readonly<Record<PhaseName, readonly ActionType[]>> = {
  setupSettlement: ['placeSettlement'],
  setupRoad: ['placeRoad'],
  preRoll: ['rollDice', ...PLAY_DEV],
  discard: ['discard'],
  moveRobber: ['moveRobber'],
  main: [
    'placeSettlement', 'placeRoad', 'buildCity', 'buyDevCard', ...PLAY_DEV, 'maritimeTrade',
    'proposeTrade', 'respondTrade', 'confirmTrade', 'cancelTrade', 'endTurn',
  ],
  roadBuilding: ['placeRoad'],
  gameOver: [],
};

/**
 * Whether `seat` may submit `type` at all right now (the not_your_turn check). Trade responses come only from
 * non-active seats. A discard may come from any seat in any phase, so it is gated by phase only: outside the discard
 * phase it is wrong_phase for every seat, and inside it the handler answers discard_not_required for a seat that owes
 * nothing (D18b). Everything else comes from the active seat.
 */
export function maySubmit(state: GameState, seat: Seat, type: ActionType): boolean {
  if (type === 'respondTrade') return seat !== state.turn.active;
  if (type === 'discard') return true;
  return seat === state.turn.active;
}
