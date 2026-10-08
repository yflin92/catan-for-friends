// Shared development-card play rules (R10; design §6 Dev cards). Every non-VP card is played from the player's unplayed
// cards, at most one per turn, never on the turn it was bought. The phase (preRoll or main) and the active seat are
// enforced by dispatch precedence. Card-rule rejections are checked in this order: dev_card_not_owned →
// dev_card_bought_this_turn → dev_card_already_played.
import type { Seat } from '../ids';
import type { EngineReasonCode } from '../reasons';
import type { DevCardKind, GameState } from '../state';

export type PlayableKind = Exclude<DevCardKind, 'victoryPoint'>;

/** Why `seat` cannot play a `kind` card now, or null. */
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
 * Removes one playable `kind` card from `seat`'s hand, counts it as played, marks the turn's dev play and logs
 * devPlayed. The caller has checked devPlayIssue() and applies the card's effect afterwards.
 */
export function spendDevCard(state: GameState, seat: Seat, kind: PlayableKind): GameState {
  const players = state.players.map((p, i) => {
    if (i !== seat) return p;
    const at = p.devCards.findIndex((c) => c.kind === kind && c.boughtOnTurn !== state.turn.number);
    return {
      ...p,
      devCards: p.devCards.filter((_, j) => j !== at),
      playedDev: { ...p.playedDev, [kind]: p.playedDev[kind] + 1 },
    };
  });
  return { ...state, players, turn: { ...state.turn, devPlayed: true } };
}
