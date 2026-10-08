// 'confirmTrade' action handler (design §5.4, DR2). Reached only by the active seat in main. Swaps the two sides
// between the proposer and one accepting partner, re-validated against current holdings, and closes the offer.
import { emit } from '../log';
import { confirmIssue, swap } from './trade';
import type { ActionHandler } from './types';

export const confirmTrade: ActionHandler<'confirmTrade'> = (state, _seat, action) => {
  const issue = confirmIssue(state, action.tradeId, action.partner);
  if (issue !== null || state.trade === null) return { ok: false, reason: issue ?? 'trade_not_found' };
  const swapped = { ...swap(state, state.trade, action.partner), trade: null };
  return { ok: true, state: emit(swapped, { kind: 'tradeResolved', tradeId: action.tradeId, outcome: 'confirmed', partner: action.partner }) };
};
