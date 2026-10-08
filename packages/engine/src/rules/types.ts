// Handler contracts for the per-action rule modules. A handler runs only after the reducer's precedence checks pass
// (design §3.8). It returns the next state (appending events with emit) or a rejection; it must not mutate its input.
import type { Action, ActionType, SystemAction } from '../events';
import type { Seat } from '../ids';
import type { LegalActions } from '../legal';
import type { EngineReasonCode } from '../reasons';
import type { GameState } from '../state';

export type HandlerResult =
  | { readonly ok: true; readonly state: GameState }
  | { readonly ok: false; readonly reason: EngineReasonCode };

export type ActionHandler<T extends ActionType = ActionType> = (
  state: GameState,
  seat: Seat,
  action: Extract<Action, { type: T }>,
) => HandlerResult;

export type SystemHandler = (state: GameState, action: SystemAction) => HandlerResult;

export type ActionHandlers = { readonly [T in ActionType]: ActionHandler<T> };

/** A track's contribution to legalActions for an eligible seat. Fields it omits keep the empty defaults. */
export type LegalSlice = (
  state: GameState,
  seat: Seat,
) => Partial<Omit<LegalActions, 'seat' | 'phase' | 'bankStock'>>;

/** The result of an action type whose rule track has not landed yet. */
export const notImplemented: HandlerResult = Object.freeze({ ok: false, reason: 'wrong_phase' });
