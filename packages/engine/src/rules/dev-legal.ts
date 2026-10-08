// Legal-actions slice for buying development cards and playing knights (design §3.6): exactly what the handlers
// accept.
import { COSTS, covers } from '../costs';
import { devPlayIssue } from './dev';
import type { LegalSlice, RuleModule } from './types';

export const devSlice: LegalSlice = (state, seat) => {
  const active = seat === state.turn.active;
  const phase = state.phase.name;
  const hand = state.players[seat]?.hand;
  return {
    buyDevCard: active && phase === 'main' && hand !== undefined && covers(hand, COSTS.devCard) && state.devDeck.length > 0,
    playKnight: active && (phase === 'preRoll' || phase === 'main') && devPlayIssue(state, seat, 'knight') === null,
  };
};

/** Registration in the rule registry (rules/index.ts). */
export const rule: RuleModule = { slice: devSlice };
