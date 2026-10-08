// Player-to-player trades (R13, AC17; design §5.4, ADR-0008, DR2). One open offer per game, carried in state.trade
// with a server-assigned id. The handlers and the legal slice share these checks, so legalActions ⇔ reduce holds by
// construction. Cards move only at confirm, directly between the two hands; the bank is never involved.
import { covers } from '../costs';
import type { Seat } from '../ids';
import type { EngineReasonCode } from '../reasons';
import type { GameState, ResourceCounts, TradeOffer } from '../state';
import { RESOURCES } from '../state';

type Issue = EngineReasonCode | null;

const handOf = (state: GameState, seat: Seat): ResourceCounts => {
  const p = state.players[seat];
  if (p === undefined) throw new Error(`no player for seat ${seat}`);
  return p.hand;
};

/** The open offer, or null when there is none or the game is not in main. */
export function openOffer(state: GameState): TradeOffer | null {
  return state.phase.name === 'main' ? state.trade : null;
}

/**
 * Why `seat` cannot propose {give, get}: invalid_trade for a negative count, an empty side, a resource on both sides,
 * or a `give` the proposer does not hold. Seat and phase are checked by dispatch.
 */
export function proposeIssue(state: GameState, seat: Seat, give: ResourceCounts, get: ResourceCounts): Issue {
  if (RESOURCES.some((r) => give[r] < 0 || get[r] < 0)) return 'invalid_trade';
  if (RESOURCES.every((r) => give[r] === 0) || RESOURCES.every((r) => get[r] === 0)) return 'invalid_trade';
  if (RESOURCES.some((r) => give[r] > 0 && get[r] > 0)) return 'invalid_trade';
  return covers(handOf(state, seat), give) ? null : 'invalid_trade';
}

/** Why `seat` cannot respond to offer `tradeId`: trade_not_found unless it is the open offer; accepting needs `get`. */
export function respondIssue(state: GameState, seat: Seat, tradeId: number, accept: boolean): Issue {
  const t = openOffer(state);
  if (t === null || t.id !== tradeId) return 'trade_not_found';
  return accept && !covers(handOf(state, seat), t.get) ? 'insufficient_resources' : null;
}

/** Whether the exchange with `partner` is covered by both hands right now. */
function exchangeCovered(state: GameState, t: TradeOffer, partner: Seat): boolean {
  return covers(handOf(state, t.from), t.give) && covers(handOf(state, partner), t.get);
}

/**
 * Why the proposer cannot confirm offer `tradeId` with `partner`: trade_not_found unless it is the open offer;
 * trade_not_accepted unless the partner's response is 'accepted'; trade_stale when current holdings no longer cover
 * either side.
 */
export function confirmIssue(state: GameState, tradeId: number, partner: Seat): Issue {
  const t = openOffer(state);
  if (t === null || t.id !== tradeId) return 'trade_not_found';
  if (partner >= state.playerCount || t.responses[partner] !== 'accepted') return 'trade_not_accepted';
  return exchangeCovered(state, t, partner) ? null : 'trade_stale';
}

/** Why the proposer cannot cancel offer `tradeId`: trade_not_found unless it is the open offer. */
export function cancelIssue(state: GameState, tradeId: number): Issue {
  const t = openOffer(state);
  return t === null || t.id !== tradeId ? 'trade_not_found' : null;
}

/** Seats that accepted the open offer and whose exchange is covered now, ascending (DR2). */
export function confirmablePartners(state: GameState): readonly Seat[] {
  const t = openOffer(state);
  if (t === null) return [];
  const out: Seat[] = [];
  for (let p = 0; p < state.playerCount; p++) {
    const seat = p as Seat;
    if (t.responses[seat] === 'accepted' && exchangeCovered(state, t, seat)) out.push(seat);
  }
  return out;
}

/** Moves `give` from the proposer to `partner` and `get` back. The caller has checked confirmIssue. */
export function swap(state: GameState, t: TradeOffer, partner: Seat): GameState {
  const move = (hand: ResourceCounts, out: ResourceCounts, inn: ResourceCounts): ResourceCounts =>
    Object.fromEntries(RESOURCES.map((r) => [r, hand[r] - out[r] + inn[r]])) as unknown as ResourceCounts;
  return {
    ...state,
    players: state.players.map((p, i) =>
      i === t.from ? { ...p, hand: move(p.hand, t.give, t.get) } : i === partner ? { ...p, hand: move(p.hand, t.get, t.give) } : p,
    ),
  };
}
