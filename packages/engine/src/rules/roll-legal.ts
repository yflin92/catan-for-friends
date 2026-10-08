// Legal-actions slice for rolling (design §3.6): legal.rollDice is true exactly when reduce accepts rollDice — the
// active seat in preRoll.
import type { LegalSlice, RuleModule } from './types';

export const rollSlice: LegalSlice = (state, seat) => ({
  rollDice: state.phase.name === 'preRoll' && seat === state.turn.active,
});

/** Registration in the rule registry (rules/index.ts). */
export const rule: RuleModule = { slice: rollSlice };
