// 'maritimeTrade' action handler (design §6 R13, §3.8, AC16). Reached only by the active seat in main (dispatch
// precedence). The seat pays count × ratio of `give` and receives `count` of `receive` from the bank.
// Rejections, in order: malformed_action for a count that is not an integer (non-finite counts never reach the handler);
// invalid_trade for give = receive or a count < 1; invalid_trade when the hand does not hold count × ratio of `give`;
// bank_insufficient when the bank holds fewer than `count` of `receive`.
import { emit } from '../log';
import { maritimeRatio } from './maritime';
import type { ActionHandler, RuleModule } from './types';

export const maritimeTrade: ActionHandler<'maritimeTrade'> = (state, seat, { give, receive, count }) => {
  if (!Number.isInteger(count)) return { ok: false, reason: 'malformed_action' };
  if (give === receive || count < 1) return { ok: false, reason: 'invalid_trade' };
  const gave = count * maritimeRatio(state, seat, give);
  const player = state.players[seat]!;
  if (player.hand[give] < gave) return { ok: false, reason: 'invalid_trade' };
  if (state.bank[receive] < count) return { ok: false, reason: 'bank_insufficient' };

  const hand = { ...player.hand, [give]: player.hand[give] - gave };
  hand[receive] += count;
  const bank = { ...state.bank, [give]: state.bank[give] + gave };
  bank[receive] -= count;
  const traded = {
    ...state,
    bank,
    players: state.players.map((p, i) => (i === seat ? { ...p, hand } : p)),
  };
  return { ok: true, state: emit(traded, { kind: 'maritimeTraded', seat, give, gave, receive, received: count }) };
};

/** Registration in the rule registry (rules/index.ts). */
export const rule: RuleModule = { handlers: { maritimeTrade } };
