// Shared development-card play rules (R10; design §6 Dev cards, D17). Every non-VP card is played from the player's
// unplayed cards, at most one per turn. Ownership is per kind: a kind is unplayable as bought-this-turn only when EVERY
// held copy of it was bought this turn, and a play consumes the copy with the lowest boughtOnTurn. The phase (preRoll or
// main) and the active seat are enforced by dispatch precedence. Card-rule rejections are checked in this order:
// dev_card_not_owned → dev_card_bought_this_turn → dev_card_already_played, and every play* handler checks them before
// any effect-specific rule (e.g. bank_insufficient).
import type { Seat } from '../ids';
import type { EngineReasonCode } from '../reasons';
import type { DevCardKind, GameState } from '../state';

export type PlayableKind = Exclude<DevCardKind, 'victoryPoint'>;

/** Why `seat` cannot play a `kind` card now, or null. legal.play* and view's playableNow use the same rule. */
export function devPlayIssue(
  state: GameState,
  seat: Seat,
  kind: PlayableKind,
): Extract<EngineReasonCode, 'dev_card_not_owned' | 'dev_card_bought_this_turn' | 'dev_card_already_played'> | null {
  const held = state.players[seat]?.devCards.filter((c) => c.kind === kind) ?? [];
  if (held.length === 0) return 'dev_card_not_owned';
  if (held.every((c) => c.boughtOnTurn === state.turn.number)) return 'dev_card_bought_this_turn';
  if (state.turn.devPlayed) return 'dev_card_already_played';
  return null;
}

/**
 * Removes `seat`'s `kind` card with the lowest boughtOnTurn (the earliest-held one on a tie), counts it as played and
 * marks the turn's dev play. The caller has checked devPlayIssue(), logs devPlayed and applies the card's effect.
 */
export function spendDevCard(state: GameState, seat: Seat, kind: PlayableKind): GameState {
  const players = state.players.map((p, i) => {
    if (i !== seat) return p;
    let at = -1;
    p.devCards.forEach((c, j) => {
      if (c.kind === kind && (at < 0 || c.boughtOnTurn < p.devCards[at]!.boughtOnTurn)) at = j;
    });
    return {
      ...p,
      devCards: p.devCards.filter((_, j) => j !== at),
      playedDev: { ...p.playedDev, [kind]: p.playedDev[kind] + 1 },
    };
  });
  return { ...state, players, turn: { ...state.turn, devPlayed: true } };
}
