// 'buyDevCard' action handler (R10, AC12). Reached only by the active seat in main. Rejections follow design §3.8:
// insufficient_resources, then dev_deck_empty. The card drawn is the last element of the deck; only the buyer sees its
// kind (devBoughtDetail), everyone sees that a card was bought (devBought).
import { COSTS, covers, payToBank } from '../costs';
import { emit } from '../log';
import type { ActionHandler } from './types';

export const buyDevCard: ActionHandler<'buyDevCard'> = (state, seat) => {
  const player = state.players[seat];
  if (player === undefined) return { ok: false, reason: 'internal_error' };
  if (!covers(player.hand, COSTS.devCard)) return { ok: false, reason: 'insufficient_resources' };
  const card = state.devDeck.at(-1);
  if (card === undefined) return { ok: false, reason: 'dev_deck_empty' };

  let s = payToBank(state, seat, COSTS.devCard);
  s = {
    ...s,
    devDeck: s.devDeck.slice(0, -1),
    players: s.players.map((p, i) =>
      i === seat ? { ...p, devCards: [...p.devCards, { kind: card, boughtOnTurn: s.turn.number }] } : p,
    ),
  };
  s = emit(s, { kind: 'devBought', seat });
  s = emit(s, { kind: 'devBoughtDetail', seat, card });
  return { ok: true, state: s };
};
