// Commands, actions and log events (design §3.3).
import type { EdgeId, HexId, Seat, VertexId } from './ids';
import type { DevCardKind, PhaseName, Resource, ResourceCounts, TradeOffer } from './state';

export type Action =
  /** Setup and main. */
  | { readonly type: 'placeSettlement'; readonly vertex: VertexId }
  /** Setup, main and roadBuilding. */
  | { readonly type: 'placeRoad'; readonly edge: EdgeId }
  | { readonly type: 'buildCity'; readonly vertex: VertexId }
  | { readonly type: 'rollDice' }
  | { readonly type: 'discard'; readonly cards: ResourceCounts }
  /** Robber move and steal (R9); victim is null iff no opponent is eligible. */
  | { readonly type: 'moveRobber'; readonly hex: HexId; readonly victim: Seat | null }
  | { readonly type: 'buyDevCard' }
  | { readonly type: 'playKnight' }
  | { readonly type: 'playRoadBuilding' }
  | { readonly type: 'playYearOfPlenty'; readonly take: readonly [Resource, Resource] }
  | { readonly type: 'playMonopoly'; readonly resource: Resource }
  /** Receive `count` of `receive`, paying count × ratio of `give`. */
  | { readonly type: 'maritimeTrade'; readonly give: Resource; readonly receive: Resource; readonly count: number }
  /** Replaces any open offer. */
  | { readonly type: 'proposeTrade'; readonly give: ResourceCounts; readonly get: ResourceCounts }
  | { readonly type: 'respondTrade'; readonly tradeId: number; readonly accept: boolean }
  | { readonly type: 'confirmTrade'; readonly tradeId: number; readonly partner: Seat }
  | { readonly type: 'cancelTrade'; readonly tradeId: number }
  | { readonly type: 'endTurn' };
export type ActionType = Action['type'];

/** Issued only by the server (design §5.10, ADR-0014). */
export type SystemAction = { readonly type: 'skipSeat'; readonly seat: Seat; readonly reason: 'host' | 'timer' };

export type Command =
  | { readonly by: Seat; readonly action: Action }
  | { readonly by: 'system'; readonly action: SystemAction };

export type ActionGroup = 'setup' | 'turn' | 'build' | 'dev' | 'trade' | 'robber' | 'system' | 'lobby';

const TYPE_GROUPS: Readonly<Record<ActionType, ActionGroup>> = Object.freeze({
  placeSettlement: 'build',
  placeRoad: 'build',
  buildCity: 'build',
  rollDice: 'turn',
  endTurn: 'turn',
  discard: 'robber',
  moveRobber: 'robber',
  buyDevCard: 'dev',
  playKnight: 'dev',
  playRoadBuilding: 'dev',
  playYearOfPlenty: 'dev',
  playMonopoly: 'dev',
  maritimeTrade: 'trade',
  proposeTrade: 'trade',
  respondTrade: 'trade',
  confirmTrade: 'trade',
  cancelTrade: 'trade',
});

/**
 * The `catan.action.group` span attribute (design §9.3); never a metric label. `phase` is the phase the command was
 * validated against (pre-command), or null for lobby/control messages. Rules, in order: 'lobby' → lobby;
 * 'control' and skipSeat → system; a setup phase → setup; otherwise by action type.
 */
export function actionGroup(
  t: ActionType | SystemAction['type'] | 'lobby' | 'control',
  phase: PhaseName | null,
): ActionGroup {
  if (t === 'lobby') return 'lobby';
  if (t === 'control' || t === 'skipSeat') return 'system';
  if (phase === 'setupSettlement' || phase === 'setupRoad') return 'setup';
  return TYPE_GROUPS[t];
}

export type GameEvent =
  | {
      readonly kind: 'diceRolled';
      readonly seat: Seat;
      readonly dice: readonly [number, number];
      readonly gains: readonly ResourceCounts[];
      readonly shortage: readonly Resource[];
      readonly auto: boolean;
    }
  | { readonly kind: 'setupResources'; readonly seat: Seat; readonly gained: ResourceCounts }
  | {
      readonly kind: 'built';
      readonly seat: Seat;
      readonly piece: 'road' | 'settlement' | 'city';
      readonly at: VertexId | EdgeId;
      readonly free: boolean;
    }
  /** Public (A16). */
  | { readonly kind: 'discarded'; readonly seat: Seat; readonly cards: ResourceCounts; readonly auto: boolean }
  | {
      readonly kind: 'robberMoved';
      readonly seat: Seat;
      readonly hex: HexId;
      readonly victim: Seat | null;
      readonly auto: boolean;
    }
  /** Visible to all. */
  | { readonly kind: 'stole'; readonly seat: Seat; readonly victim: Seat }
  /** Visible to the thief and the victim only. */
  | { readonly kind: 'stoleDetail'; readonly seat: Seat; readonly victim: Seat; readonly resource: Resource }
  /** Visible to all. */
  | { readonly kind: 'devBought'; readonly seat: Seat }
  /** Visible to the buyer only. */
  | { readonly kind: 'devBoughtDetail'; readonly seat: Seat; readonly card: DevCardKind }
  | {
      readonly kind: 'devPlayed';
      readonly seat: Seat;
      readonly card: Exclude<DevCardKind, 'victoryPoint'>;
      readonly picks?: readonly Resource[];
      readonly taken?: readonly number[];
    }
  | {
      readonly kind: 'maritimeTraded';
      readonly seat: Seat;
      readonly give: Resource;
      readonly gave: number;
      readonly receive: Resource;
      readonly received: number;
    }
  | { readonly kind: 'tradeProposed'; readonly offer: TradeOffer; readonly replaced: number | null }
  | { readonly kind: 'tradeResponded'; readonly tradeId: number; readonly seat: Seat; readonly accept: boolean }
  /** 'withdrawn' = the phase left main with the offer open (R13, design §6.2 onPhaseExit); exitTo names the phase
   *  entered. */
  | {
      readonly kind: 'tradeResolved';
      readonly tradeId: number;
      readonly outcome: 'confirmed' | 'cancelled' | 'replaced' | 'withdrawn';
      readonly partner: Seat | null;
      readonly exitTo?: PhaseName;
    }
  | {
      readonly kind: 'awardChanged';
      readonly award: 'longestRoad' | 'largestArmy';
      readonly from: Seat | null;
      readonly to: Seat | null;
    }
  | { readonly kind: 'seatSkipped'; readonly seat: Seat; readonly reason: 'host' | 'timer' }
  | { readonly kind: 'turnEnded'; readonly seat: Seat; readonly turn: number; readonly reason: 'endTurn' | 'skipped' }
  | { readonly kind: 'gameOver'; readonly winner: Seat; readonly vp: readonly number[] };

/** Every private detail is a SEPARATE entry next to a public one (stole + stoleDetail, devBought + devBoughtDetail),
 *  so the public log is identical for every seat (design §3.7.1). */
export interface LogEntry {
  readonly n: number;
  readonly event: GameEvent;
  readonly visibleTo: 'all' | readonly Seat[];
}
