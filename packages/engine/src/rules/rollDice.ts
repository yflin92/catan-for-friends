// 'rollDice' action handler (R7, R8; AC7). Reached only by the active seat in preRoll. Two d6 come from the dice
// stream; a non-7 pays production and moves to main, a 7 hands over to startSeven.
import { setPhase } from '../internal/turn';
import { emit } from '../log';
import { drawDie } from '../rng';
import { payProduction, produce } from './production';
import { startSeven } from './seven';
import type { ActionHandler } from './types';

export const rollDice: ActionHandler<'rollDice'> = (state, seat) => {
  const [a, afterA] = drawDie(state.rng.dice);
  const [b, afterB] = drawDie(afterA);
  const dice = [a, b] as const;
  const rolled = { ...state, rng: { ...state.rng, dice: afterB }, turn: { ...state.turn, dice } };
  const zero = { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 };

  if (a + b === 7) {
    const gains = Array.from({ length: state.playerCount }, () => zero);
    const logged = emit(rolled, { kind: 'diceRolled', seat, dice, gains, shortage: [], auto: false });
    return { ok: true, state: startSeven(logged) };
  }
  const { gains, shortage } = produce(rolled, a + b);
  const paid = payProduction(rolled, gains);
  const logged = emit(paid, { kind: 'diceRolled', seat, dice, gains, shortage, auto: false });
  return { ok: true, state: setPhase(logged, { name: 'main' }) };
};
