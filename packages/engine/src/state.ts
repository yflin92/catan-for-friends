// Core game-state types (design §3.2). GameState is plain JSON: no Map, Set, Date, undefined or non-integer numbers.
// It holds server-only data (devDeck, rng) and reaches clients only through view() (design §3.7).
import type { GameRules } from './config';
import type { LogEntry } from './events';
import type { EdgeId, HexId, Seat, VertexId } from './ids';
import type { RngStream, RngStreamState } from './rng';

export type Resource = 'brick' | 'lumber' | 'wool' | 'grain' | 'ore';
/** Canonical resource order, used wherever resources are iterated or expanded (e.g. steal indices). */
export const RESOURCES: readonly Resource[] = Object.freeze(['brick', 'lumber', 'wool', 'grain', 'ore']);
/** Non-negative integer counts per resource. */
export type ResourceCounts = Readonly<Record<Resource, number>>;

export type Terrain = 'hills' | 'forest' | 'pasture' | 'fields' | 'mountains' | 'desert';
export const TERRAIN_YIELD: Readonly<Record<Exclude<Terrain, 'desert'>, Resource>> = Object.freeze({
  hills: 'brick',
  forest: 'lumber',
  pasture: 'wool',
  fields: 'grain',
  mountains: 'ore',
});

export type DevCardKind = 'knight' | 'roadBuilding' | 'yearOfPlenty' | 'monopoly' | 'victoryPoint';
/** 'generic' is a 3:1 harbor; a Resource is a 2:1 harbor for that resource. */
export type HarborKind = 'generic' | Resource;

export interface Board {
  readonly hexes: readonly { readonly id: HexId; readonly terrain: Terrain; readonly token: number | null }[];
  readonly harbors: readonly { readonly edge: EdgeId; readonly kind: HarborKind }[];
}

export type PhaseName =
  | 'setupSettlement'
  | 'setupRoad'
  | 'preRoll'
  | 'discard'
  | 'moveRobber'
  | 'main'
  | 'roadBuilding'
  | 'gameOver';

export type Phase =
  | { readonly name: 'setupSettlement'; readonly round: 1 | 2 }
  | { readonly name: 'setupRoad'; readonly round: 1 | 2; readonly from: VertexId }
  | { readonly name: 'preRoll' }
  /** owed[seat] = cards that seat still has to discard; 0 = none. */
  | { readonly name: 'discard'; readonly owed: readonly number[]; readonly then: 'moveRobber' | 'autoRobberThenEnd' }
  /** resume = 'preRoll' after a pre-roll Knight. */
  | { readonly name: 'moveRobber'; readonly resume: 'preRoll' | 'main' }
  | { readonly name: 'main' }
  | { readonly name: 'roadBuilding'; readonly remaining: 1 | 2; readonly resume: 'preRoll' | 'main' }
  | { readonly name: 'gameOver'; readonly winner: Seat };

/**
 * The single open player-to-player offer (ADR-0008). Invariant: trade ≠ null ⇒ phase = main ∧ from = turn.active.
 */
export interface TradeOffer {
  /** The offer id (R13): a per-game counter from state.nextTradeId, carried by respond/confirm/cancel. */
  readonly id: number;
  /** The proposer, always the active seat. */
  readonly from: Seat;
  /** Cards from → partner. */
  readonly give: ResourceCounts;
  /** Cards partner → from. */
  readonly get: ResourceCounts;
  /** Indexed by seat; the proposer's entry is 'self'. */
  readonly responses: readonly ('pending' | 'accepted' | 'declined' | 'self')[];
}

export interface PlayerState {
  readonly hand: ResourceCounts;
  /** Unplayed dev cards, including victory points. */
  readonly devCards: readonly { readonly kind: DevCardKind; readonly boughtOnTurn: number }[];
  readonly playedDev: Readonly<Record<Exclude<DevCardKind, 'victoryPoint'>, number>>;
  /** Pieces not on the board; starts at 5 / 4 / 15. */
  readonly supply: { readonly settlements: number; readonly cities: number; readonly roads: number };
  /** Cached longest-road length; recomputed on every road and settlement placement. */
  readonly longestRoad: number;
}

export interface GameState {
  readonly schemaVersion: 1;
  /** Frozen at start; part of stateHash (design §3.9). */
  readonly config: GameRules;
  readonly playerCount: 3 | 4;
  readonly board: Board;
  readonly robber: HexId;
  readonly pieces: {
    readonly settlements: Readonly<Record<VertexId, Seat>>;
    readonly cities: Readonly<Record<VertexId, Seat>>;
    readonly roads: Readonly<Record<EdgeId, Seat>>;
  };
  /** Indexed by seat. */
  readonly players: readonly PlayerState[];
  /** 19 of each resource at start. */
  readonly bank: ResourceCounts;
  /** SERVER ONLY. The next card drawn is the last element. */
  readonly devDeck: readonly DevCardKind[];
  readonly turn: {
    /** 0 during setup, 1.. afterwards. */
    readonly number: number;
    readonly active: Seat;
    readonly dice: readonly [number, number] | null;
    readonly devPlayed: boolean;
  };
  readonly phase: Phase;
  readonly trade: TradeOffer | null;
  readonly nextTradeId: number;
  readonly awards: { readonly longestRoad: Seat | null; readonly largestArmy: Seat | null };
  /** SERVER ONLY. */
  readonly rng: Readonly<Record<RngStream, RngStreamState>>;
  /** The last 200 entries. */
  readonly log: readonly LogEntry[];
  readonly logCounter: number;
}
