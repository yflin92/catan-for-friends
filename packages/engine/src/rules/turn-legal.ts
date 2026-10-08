// Legal-actions slice for ending the turn (design §3.6): legal.endTurn is true exactly when reduce accepts endTurn.
import type { LegalSlice } from './types';

export const turnSlice: LegalSlice = (state, seat) => ({
  endTurn: state.phase.name === 'main' && seat === state.turn.active,
});
