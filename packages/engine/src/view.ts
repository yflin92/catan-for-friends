// Per-seat views (design §3.7, §3.7.1). view(state, seat) is the ONLY path from GameState to the wire (P3, AC25); it is
// the only code allowed to mint the PlayerView brand (ESLint no-restricted-syntax).
//
// Never in any view: devDeck, rng, another seat's hand types or unplayed dev-card types (before gameOver), hidden log
// entries, tokens, the seed.
import type { GameRules } from './config';
import type { LogEntry } from './events';
import type { HexId, Seat } from './ids';
import type { LegalActions } from './legal';
import type { Board, DevCardKind, GameState, Phase, PlayerState, ResourceCounts, TradeOffer } from './state';

declare const ViewBrand: unique symbol;
/** A PlayerViewData produced by view(); nothing else can create one. */
export type PlayerView = PlayerViewData & { readonly [ViewBrand]: true };

export interface PlayerViewData {
  readonly schemaVersion: 1;
  readonly you: Seat;
  readonly config: GameRules;
  readonly playerCount: 3 | 4;
  readonly board: Board;
  readonly robber: HexId;
  readonly pieces: GameState['pieces'];
  /** Public (R15). */
  readonly bank: ResourceCounts;
  /** Count only. */
  readonly devDeckCount: number;
  readonly players: readonly {
    readonly seat: Seat;
    readonly handCount: number;
    readonly devCardCount: number;
    readonly playedDev: PlayerState['playedDev'];
    readonly publicVp: number;
    readonly supply: PlayerState['supply'];
    readonly longestRoad: number;
    readonly discardOwed: number;
  }[];
  /** Your hand. */
  readonly hand: ResourceCounts;
  /** Your unplayed dev cards. */
  readonly devCards: readonly { readonly kind: DevCardKind; readonly playableNow: boolean }[];
  /** Your victory points. */
  readonly vp: { readonly public: number; readonly total: number };
  /** endsAfterDiscards is derived (design §3.7): phase is discard with then = 'autoRobberThenEnd'. It is not stored in
   *  GameState and does not affect stateHash. */
  readonly turn: GameState['turn'] & { readonly endsAfterDiscards: boolean };
  readonly phase: Phase;
  /** Offers are public. */
  readonly trade: TradeOffer | null;
  readonly awards: GameState['awards'];
  /** Entries with n > logCounter − 100 that are visible to you. The window is by n, so the public part is identical
   *  for every seat. */
  readonly log: readonly LogEntry[];
  readonly legal: LegalActions;
  /** Filled only in gameOver (F7, AC18). */
  readonly reveal: null | {
    readonly hands: readonly ResourceCounts[];
    readonly devCards: readonly (readonly DevCardKind[])[];
    readonly vp: readonly number[];
  };
}

/**
 * The seat-independent part of a view (TH13, AC31; normative):
 *   publicProjection(v) = v without {you, hand, devCards, vp, legal}, with log → publicLog (entries visible to 'all').
 *   publicProjectionHash(v) = lowercase hex SHA-256(utf8(canonicalJson(publicProjection(v)))).
 * Property: for every reachable s and seats p, q, publicProjectionHash(view(s,p)) === publicProjectionHash(view(s,q)).
 */
export interface PublicProjection {
  readonly schemaVersion: 1;
  readonly config: GameRules;
  readonly playerCount: 3 | 4;
  readonly board: Board;
  readonly robber: HexId;
  readonly pieces: GameState['pieces'];
  readonly bank: ResourceCounts;
  readonly devDeckCount: number;
  readonly players: PlayerViewData['players'];
  readonly turn: PlayerViewData['turn'];
  readonly phase: Phase;
  readonly trade: TradeOffer | null;
  readonly awards: GameState['awards'];
  readonly publicLog: readonly LogEntry[];
  readonly reveal: PlayerViewData['reveal'];
}
