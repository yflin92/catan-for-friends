// Legal-actions slice for the seven (design §3.6): discards for owing seats and robber moves for the active seat,
// exactly what the handlers accept. legal.moveRobber is never empty in moveRobber.
import { robberTargets } from '../internal/turn';
import { stealVictims } from './robber';
import type { LegalSlice, RuleModule } from './types';

export const robberSlice: LegalSlice = (state, seat) => {
  const phase = state.phase;
  const owed = phase.name === 'discard' ? (phase.owed[seat] ?? 0) : 0;
  return {
    discard: owed > 0 ? { count: owed } : null,
    moveRobber:
      phase.name === 'moveRobber' && seat === state.turn.active
        ? robberTargets(state).map((hex) => ({ hex, victims: stealVictims(state, hex, seat) }))
        : [],
  };
};

/** Registration in the rule registry (rules/index.ts). */
export const rule: RuleModule = { slice: robberSlice };
