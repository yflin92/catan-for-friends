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

/**
 * What one rule module registers (rules/index.ts collects these): handlers for its action types and/or the legal-actions
 * slice it contributes. Slices are phase-disjoint: for any state and seat, no two slices return the same field, so
 * the order they are merged in never matters (rules/registry.test.ts checks this).
 */
export interface RuleModule {
  readonly handlers?: Partial<ActionHandlers>;
  readonly slice?: LegalSlice;
}

/**
 * The handler map built from the registered modules. Each action type has exactly one handler; a duplicate throws. A
 * type no module handles gets the notImplemented stub (wrong_phase).
 */
export function collectHandlers(modules: readonly RuleModule[], types: readonly ActionType[]): ActionHandlers {
  const out: Partial<Record<ActionType, ActionHandler>> = {};
  for (const m of modules) {
    for (const [type, handler] of Object.entries(m.handlers ?? {}) as [ActionType, ActionHandler][]) {
      if (out[type] !== undefined) throw new Error(`rule registry: two handlers for ${type}`);
      out[type] = handler;
    }
  }
  for (const t of types) out[t] ??= () => notImplemented;
  return Object.freeze(out) as ActionHandlers;
}

/** The registered slices, in module order. */
export function collectSlices(modules: readonly RuleModule[]): readonly LegalSlice[] {
  return Object.freeze(modules.flatMap((m) => (m.slice ? [m.slice] : [])));
}
