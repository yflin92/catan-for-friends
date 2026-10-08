// 'rollDice' action handler (R7, R8; AC7). Reached only by the active seat in preRoll. Two d6 come from the dice
// stream; a non-7 pays production and moves to main, a 7 hands over to startSeven.
import type { Seat } from '../ids';
import { setPhase } from '../internal/turn';
import { emit } from '../log';
import { drawDie } from '../rng';
import { payProduction, produce } from './production';
import { startSeven } from './seven';
import type { GameState } from '../state';
import type { ActionHandler } from './types';

export const rollDice: ActionHandler<'rollDice'> = (state, seat) => {
  const { state: rolled, seven } = rollAndProduce(state, seat, false);
  return { ok: true, state: seven ? startSeven(rolled) : setPhase(rolled, { name: 'main' }) };
};

/**
 * Rolls two d6 from the dice stream for `seat`, records them on the turn, pays production unless it is a 7, and logs
 * diceRolled{auto}. The phase is unchanged; the caller moves on (main, or the 7 handling).
 */
export function rollAndProduce(state: GameState, seat: Seat, auto: boolean): { readonly state: GameState; readonly seven: boolean } {
  const [a, afterA] = drawDie(state.rng.dice);
  const [b, afterB] = drawDie(afterA);
  const dice = [a, b] as const;
  const rolled = { ...state, rng: { ...state.rng, dice: afterB }, turn: { ...state.turn, dice } };
  if (a + b === 7) {
    const zero = { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 };
    const gains = Array.from({ length: state.playerCount }, () => zero);
    return { state: emit(rolled, { kind: 'diceRolled', seat, dice, gains, shortage: [], auto }), seven: true };
  }
  const { gains, shortage } = produce(rolled, a + b);
  const paid = payProduction(rolled, gains);
  return { state: emit(paid, { kind: 'diceRolled', seat, dice, gains, shortage, auto }), seven: false };
}
