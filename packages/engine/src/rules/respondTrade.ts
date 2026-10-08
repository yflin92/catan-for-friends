// 'respondTrade' action handler (design §5.4, DR2). Reached only by a non-active seat in main. Records accept or
// decline for the open offer; a seat may change or re-send its response. No cards move.
import { emit } from '../log';
import { respondIssue } from './trade';
import type { ActionHandler, RuleModule } from './types';

export const respondTrade: ActionHandler<'respondTrade'> = (state, seat, action) => {
  const issue = respondIssue(state, seat, action.tradeId, action.accept);
  if (issue !== null || state.trade === null) return { ok: false, reason: issue ?? 'trade_not_found' };
  const responses = state.trade.responses.map((r, p) => (p === seat ? (action.accept ? 'accepted' : 'declined') : r));
  const next = { ...state, trade: { ...state.trade, responses } };
  return { ok: true, state: emit(next, { kind: 'tradeResponded', tradeId: action.tradeId, seat, accept: action.accept }) };
};

/** Registration in the rule registry (rules/index.ts). */
export const rule: RuleModule = { handlers: { respondTrade } };
