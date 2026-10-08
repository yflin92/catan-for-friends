// Legal-actions slice for player trades (design §3.6, DR2). Exact: every field is derived from the same checks the
// handlers use (trade.ts), so respond/confirm/cancel are listed exactly when reduce accepts them.
import { covers } from '../costs';
import { confirmablePartners, openOffer } from './trade';
import type { LegalSlice, RuleModule } from './types';

export const tradeSlice: LegalSlice = (state, seat) => {
  const main = state.phase.name === 'main';
  const t = openOffer(state);
  const active = seat === state.turn.active;
  const hand = state.players[seat]?.hand;
  const partners = t !== null && seat === t.from ? confirmablePartners(state) : [];
  return {
    proposeTrade: main && active,
    respondTrade: t !== null && !active && hand !== undefined ? { tradeId: t.id, canAccept: covers(hand, t.get) } : null,
    confirmTrade: t !== null && seat === t.from && partners.length > 0 ? { tradeId: t.id, partners } : null,
    cancelTrade: t !== null && seat === t.from ? t.id : null,
  };
};

/** Registration in the rule registry (rules/index.ts). */
export const rule: RuleModule = { slice: tradeSlice };
