// The legal-actions descriptor (design §3.6, ADR-0003 rev 1.3).
//
// Contract (AC6, V11): an action is described by legalActions(s, p) ⇔ reduce(s, {by: p, action}).ok.
// For parametric actions (discard, proposeTrade, maritime count) the descriptor gives the parameter space and the
// reducer's validation is the oracle. An ineligible seat gets all-empty/false/null fields, except a non-active seat's
// respondTrade (AC11).
//
// Trade fields are EXACT (DR2):
//   respondTrade{tradeId, accept:false}.ok ⇔ legal.respondTrade?.tradeId === tradeId
//   respondTrade{tradeId, accept:true}.ok  ⇔ that ∧ legal.respondTrade.canAccept
//   confirmTrade{tradeId, partner}.ok      ⇔ legal.confirmTrade?.tradeId === tradeId ∧ partner ∈ legal.confirmTrade.partners
//   cancelTrade{tradeId}.ok                ⇔ legal.cancelTrade === tradeId
// Re-sending the same response is legal (an idempotent state change with a new seq).
import type { EdgeId, HexId, Seat, VertexId } from './ids';
import type { PhaseName, Resource, ResourceCounts } from './state';

export interface LegalActions {
  readonly seat: Seat;
  readonly phase: PhaseName;
  readonly placeSettlement: readonly VertexId[];
  readonly placeRoad: readonly EdgeId[];
  readonly buildCity: readonly VertexId[];
  readonly rollDice: boolean;
  readonly endTurn: boolean;
  readonly buyDevCard: boolean;
  readonly playKnight: boolean;
  readonly playRoadBuilding: boolean;
  /** Only pairs the bank can pay (AC14b). */
  readonly playYearOfPlenty: readonly (readonly [Resource, Resource])[];
  readonly playMonopoly: boolean;
  readonly discard: { readonly count: number } | null;
  readonly moveRobber: readonly { readonly hex: HexId; readonly victims: readonly Seat[] }[];
  /** Give-resource → ratio, for each resource of which ≥ 1 unit is affordable. */
  readonly maritime: Readonly<Partial<Record<Resource, 2 | 3 | 4>>>;
  readonly bankStock: ResourceCounts;
  /** Active seat in phase main; a new proposal replaces any open offer. */
  readonly proposeTrade: boolean;
  /** Non-null iff an offer is open AND this seat is a non-active addressee. Decline is always legal when non-null;
   *  accept is legal iff canAccept (this seat's current hand ⊇ offer.get). */
  readonly respondTrade: { readonly tradeId: number; readonly canAccept: boolean } | null;
  /** Non-null iff this seat is the proposer AND ≥ 1 partner is confirmable now. partners = seats whose response is
   *  'accepted' AND, with current holdings, proposer hand ⊇ offer.give AND partner hand ⊇ offer.get. Ascending seat
   *  order; never empty. */
  readonly confirmTrade: { readonly tradeId: number; readonly partners: readonly Seat[] } | null;
  /** The open offer's id for its proposer; cancel is always legal then. */
  readonly cancelTrade: number | null;
}
