// The reducer (design §3.4, §3.8, ADR-0003): pure and total. It never throws (any exception becomes internal_error)
// and never mutates its input.
import type { ReduceResult } from './api';
import type { Command } from './events';
import { eligibleSeats } from './eligible';
import { checkVictory } from './internal/turn';
import { eventsSince } from './log';
import { ACTION_HANDLERS, SYSTEM_HANDLER } from './rules';
import { PHASE_ACTIONS, maySubmit } from './rules/phases';
import type { ActionHandler, ActionHandlers, HandlerResult, SystemHandler } from './rules/types';
import type { GameState } from './state';
import { parseCommand } from './validate';

export interface ReducerParts {
  readonly actions: ActionHandlers;
  readonly system: SystemHandler;
  /** Runs last on every successful command (checkVictory). */
  readonly finalize: (state: GameState) => GameState;
}

/**
 * Builds a reducer over the given handlers. Rejection precedence (exactly one code per rejection):
 * - Seat commands: malformed_action → game_over → discard_pending → wrong_phase (no seat may submit the type in this
 *   phase) → not_your_turn (the phase allows it, but not from this seat) → handler (D18).
 * - System commands (skipSeat): malformed_action → game_over → skip_not_allowed (setup phases, a seat the game is not
 *   waiting on, or a non-active seat outside discard) → handler.
 */
export function createReducer(parts: ReducerParts): (state: GameState, cmd: Command) => ReduceResult {
  return (state, cmd) => {
    try {
      const command = parseCommand(state, cmd);
      if (command === null) return { ok: false, reason: 'malformed_action' };
      if (state.phase.name === 'gameOver') return { ok: false, reason: 'game_over' };

      let result: HandlerResult;
      if (command.by === 'system') {
        const { seat } = command.action;
        const phase = state.phase.name;
        if (
          phase === 'setupSettlement' ||
          phase === 'setupRoad' ||
          !eligibleSeats(state).includes(seat) ||
          (seat !== state.turn.active && phase !== 'discard')
        ) {
          return { ok: false, reason: 'skip_not_allowed' };
        }
        result = parts.system(state, command.action);
      } else {
        const { by: seat, action } = command;
        if (state.phase.name === 'discard' && action.type !== 'discard') return { ok: false, reason: 'discard_pending' };
        if (!PHASE_ACTIONS[state.phase.name].includes(action.type)) return { ok: false, reason: 'wrong_phase' };
        if (!maySubmit(state, seat, action.type)) return { ok: false, reason: 'not_your_turn' };
        const handler = parts.actions[action.type] as ActionHandler;
        result = handler(state, seat, action);
      }

      if (!result.ok) return result;
      const next = parts.finalize(result.state);
      return { ok: true, state: next, events: eventsSince(state, next) };
    } catch {
      return { ok: false, reason: 'internal_error' };
    }
  };
}

const defaultReduce = createReducer({ actions: ACTION_HANDLERS, system: SYSTEM_HANDLER, finalize: checkVictory });

/** Applies one command. Malformed input → malformed_action; any internal exception → internal_error. */
export function reduce(state: GameState, cmd: Command): ReduceResult {
  return defaultReduce(state, cmd);
}
