// A rolled 7 (R9; design §5.3, AC9): every seat holding more than discardLimit cards owes ⌊n/2⌋ and discards
// simultaneously, then the roller moves the robber. Discards commute: each one touches only its seat's hand, the bank
// and that seat's owed entry, and the phase leaves discard exactly once, on the discard that clears the last owed entry.
import { covers, payToBank } from '../costs';
import { setPhase } from '../internal/turn';
import { emit } from '../log';
import { RESOURCES, type GameState, type ResourceCounts } from '../state';
import { afterDiscard } from './absence';
import type { ActionHandler } from './types';

const total = (c: ResourceCounts): number => RESOURCES.reduce((n, r) => n + c[r], 0);

/** What each seat owes on a 7: ⌊n/2⌋ for a hand of n > discardLimit cards, else 0. */
export function owedOnSeven(state: GameState): number[] {
  return state.players.map((p) => {
    const n = total(p.hand);
    return n > state.config.discardLimit ? Math.floor(n / 2) : 0;
  });
}

/** Enters discard{owed, then:'moveRobber'} when any hand exceeds discardLimit, otherwise moveRobber{resume:'main'}. */
export function startSeven(state: GameState): GameState {
  const owed = owedOnSeven(state);
  return owed.some((n) => n > 0)
    ? setPhase(state, { name: 'discard', owed, then: 'moveRobber' })
    : setPhase(state, { name: 'moveRobber', resume: 'main' });
}

/**
 * 'discard' action handler. Reached in the discard phase from any seat. A seat that owes nothing → discard_not_required;
 * a negative count, a total other than the owed count, or cards not held → wrong_discard_count. The cards go to the bank, the seat's owed
 * entry becomes 0 and discarded{auto:false} is logged. When no seat owes any more, afterDiscard leaves the phase:
 * moveRobber{resume:'main'}, or for a skipped turn (then = 'autoRobberThenEnd') the auto-robber and the end of the turn.
 */
export const discard: ActionHandler<'discard'> = (state, seat, { cards }) => {
  const phase = state.phase;
  if (phase.name !== 'discard') return { ok: false, reason: 'wrong_phase' };
  const owed = phase.owed[seat] ?? 0;
  if (owed === 0) return { ok: false, reason: 'discard_not_required' };
  const hand = state.players[seat]!.hand;
  if (RESOURCES.some((r) => cards[r] < 0) || total(cards) !== owed || !covers(hand, cards)) {
    return { ok: false, reason: 'wrong_discard_count' };
  }

  const s = emit(payToBank(state, seat, cards), { kind: 'discarded', seat, cards, auto: false });
  const rest = phase.owed.map((n, i) => (i === seat ? 0 : n));
  return { ok: true, state: afterDiscard(setPhase(s, { ...phase, owed: rest })) };
};
