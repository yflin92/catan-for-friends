// 'cancelTrade' action handler (design §5.4). Reached only by the active seat in main; closes the open offer.
import { emit } from '../log';
import { cancelIssue } from './trade';
import type { ActionHandler } from './types';

export const cancelTrade: ActionHandler<'cancelTrade'> = (state, _seat, action) => {
  const issue = cancelIssue(state, action.tradeId);
  if (issue !== null) return { ok: false, reason: issue };
  return { ok: true, state: emit({ ...state, trade: null }, { kind: 'tradeResolved', tradeId: action.tradeId, outcome: 'cancelled', partner: null }) };
};
