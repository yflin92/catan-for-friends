// 'proposeTrade' action handler (design §5.4; ADR-0008). Reached only by the active seat in main. A valid proposal
// replaces any open offer: the old one closes as tradeResolved{replaced}, then the new offer opens under the next id
// with every other seat's response 'pending'.
import { emit } from '../log';
import type { TradeOffer } from '../state';
import { proposeIssue } from './trade';
import type { ActionHandler, RuleModule } from './types';

export const proposeTrade: ActionHandler<'proposeTrade'> = (state, seat, action) => {
  const issue = proposeIssue(state, seat, action.give, action.get);
  if (issue !== null) return { ok: false, reason: issue };
  const old = state.trade;
  let next = old !== null ? emit({ ...state, trade: null }, { kind: 'tradeResolved', tradeId: old.id, outcome: 'replaced', partner: null }) : state;
  const offer: TradeOffer = {
    id: state.nextTradeId,
    from: seat,
    give: { ...action.give },
    get: { ...action.get },
    responses: Array.from({ length: state.playerCount }, (_, p) => (p === seat ? 'self' : 'pending')),
  };
  next = { ...next, trade: offer, nextTradeId: state.nextTradeId + 1 };
  return { ok: true, state: emit(next, { kind: 'tradeProposed', offer, replaced: old?.id ?? null }) };
};

/** Registration in the rule registry (rules/index.ts). */
export const rule: RuleModule = { handlers: { proposeTrade } };
