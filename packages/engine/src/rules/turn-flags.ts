// Per-turn flags (AC11). devPlayed lives in state.turn and beginTurn resets it. "Bought this turn" is derived: a dev
// card is unplayable on the turn number it was bought on, so it needs no reset.
import type { DevCardKind, GameState } from '../state';

export function boughtThisTurn(state: GameState, card: { readonly kind: DevCardKind; readonly boughtOnTurn: number }): boolean {
  return card.boughtOnTurn === state.turn.number;
}
