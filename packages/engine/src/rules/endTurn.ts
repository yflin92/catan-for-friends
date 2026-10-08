// 'endTurn' action handler (design §6.1 main row, AC11). Reached only by the active seat in main (dispatch
// precedence). Logs turnEnded, then starts the next seat's turn (cyclic), which withdraws any open offer.
import type { Seat } from '../ids';
import { beginTurn } from '../internal/turn';
import { emit } from '../log';
import type { ActionHandler } from './types';

export const endTurn: ActionHandler<'endTurn'> = (state, seat) => {
  const ended = emit(state, { kind: 'turnEnded', seat, turn: state.turn.number, reason: 'endTurn' });
  const next = ((seat + 1) % state.playerCount) as Seat;
  return { ok: true, state: beginTurn(ended, next) };
};
