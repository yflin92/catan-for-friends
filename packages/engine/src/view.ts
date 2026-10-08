// Per-seat views (design §3.7, §3.7.1). view(state, seat) is the ONLY path from GameState to the wire (P3, AC25); it is
// the only code allowed to mint the PlayerView brand (ESLint no-restricted-syntax).
//
// Never in any view: devDeck, rng, another seat's hand types or unplayed dev-card types (before gameOver), hidden log
// entries, tokens, the seed.
import type { GameRules } from './config';
import type { LogEntry } from './events';
import { canonicalJson, sha256Hex, type CanonicalJsonObject } from './hash';
import type { HexId, Seat } from './ids';
import type { LegalActions } from './legal';
import { legalActions } from './legal-actions';
import { RESOURCES, type Board, type DevCardKind, type GameState, type Phase, type PlayerState, type ResourceCounts, type TradeOffer } from './state';
import { victoryPoints } from './victory';

/**
 * The fields the view hash and projection helpers rely on. PlayerView, PlayerViewData and protocol's parsed wire view
 * all satisfy it structurally (extra properties allowed; no index signature). Everything else is validated at runtime
 * by canonicalJson.
 */
export interface ViewLike {
  readonly schemaVersion: 1;
  readonly you: number;
  readonly log: readonly { readonly visibleTo: 'all' | readonly number[] }[];
}

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

/** Log entries with n > logCounter − LOG_WINDOW are shown (filtered by visibility). */
export const LOG_WINDOW = 100;

/**
 * The view keys that differ between seats. publicProjection removes exactly these (and replaces log with publicLog);
 * every other key passes through. A new seat-specific view field must be added here in the same release.
 */
export const PRIVATE_VIEW_KEYS = Object.freeze(['you', 'hand', 'devCards', 'vp', 'legal', 'log'] as const);

const DEV_PLAY: Readonly<Record<Exclude<DevCardKind, 'victoryPoint'>, (l: LegalActions) => boolean>> = {
  knight: (l) => l.playKnight,
  roadBuilding: (l) => l.playRoadBuilding,
  yearOfPlenty: (l) => l.playYearOfPlenty.length > 0,
  monopoly: (l) => l.playMonopoly,
};

const sum = (c: ResourceCounts): number => RESOURCES.reduce((n, r) => n + c[r], 0);
const visibleTo = (entry: LogEntry, seat: Seat): boolean => entry.visibleTo === 'all' || entry.visibleTo.includes(seat);

/**
 * What `seat` may see of `state` (design §3.7). Other seats appear as counts plus public fields. The log is the window
 * n > logCounter − LOG_WINDOW, filtered to entries this seat may see. A dev card is playableNow when legalActions offers
 * playing its kind (ownership is per kind, D17: every copy of that kind is playable if any one is); victory-point cards
 * never are. reveal is filled only in gameOver.
 * turn.endsAfterDiscards is derived here, not stored.
 */
export function view(state: GameState, seat: Seat): PlayerView {
  const legal = legalActions(state, seat);
  const me = state.players[seat]!;
  const phase = state.phase;
  const owed = phase.name === 'discard' ? phase.owed : [];
  const data: PlayerViewData = {
    schemaVersion: 1,
    you: seat,
    config: state.config,
    playerCount: state.playerCount,
    board: state.board,
    robber: state.robber,
    pieces: state.pieces,
    bank: state.bank,
    devDeckCount: state.devDeck.length,
    players: state.players.map((p, i) => ({
      seat: i as Seat,
      handCount: sum(p.hand),
      devCardCount: p.devCards.length,
      playedDev: p.playedDev,
      publicVp: victoryPoints(state, i as Seat).public,
      supply: p.supply,
      longestRoad: p.longestRoad,
      discardOwed: owed[i] ?? 0,
    })),
    hand: me.hand,
    devCards: me.devCards.map((c) => ({
      kind: c.kind,
      playableNow: c.kind !== 'victoryPoint' && DEV_PLAY[c.kind](legal),
    })),
    vp: victoryPoints(state, seat),
    turn: { ...state.turn, endsAfterDiscards: phase.name === 'discard' && phase.then === 'autoRobberThenEnd' },
    phase,
    trade: state.trade,
    awards: state.awards,
    log: state.log.filter((e) => e.n > state.logCounter - LOG_WINDOW && visibleTo(e, seat)),
    legal,
    reveal:
      phase.name === 'gameOver'
        ? {
            hands: state.players.map((p) => p.hand),
            devCards: state.players.map((p) => p.devCards.map((c) => c.kind)),
            vp: state.players.map((_, i) => victoryPoints(state, i as Seat).total),
          }
        : null,
  };
  return data as PlayerView;
}

/**
 * The seat-independent part of a view (§3.7.1), computed by omission: every key except PRIVATE_VIEW_KEYS passes through,
 * and log becomes publicLog (entries visible to 'all'). Unknown keys are kept, so a client and server running the same
 * version hash the same projection.
 */
export function publicProjection(v: PlayerViewData): PublicProjection;
export function publicProjection(v: ViewLike): CanonicalJsonObject;
export function publicProjection(v: ViewLike): PublicProjection | CanonicalJsonObject {
  const out: Record<string, unknown> = {};
  for (const [k, value] of Object.entries(v)) {
    if (!(PRIVATE_VIEW_KEYS as readonly string[]).includes(k)) out[k] = value;
  }
  out['publicLog'] = v.log.filter((e) => e.visibleTo === 'all');
  return out as CanonicalJsonObject;
}

/** Lowercase hex SHA-256 of utf8(canonicalJson(publicProjection(v))) (TH13): equal for every seat at the same state. */
export function publicProjectionHash(v: ViewLike): string {
  return sha256Hex(canonicalJson(publicProjection(v)));
}

/** publicProjectionHash(view(state, p)), which is the same for every seat p. */
export function publicProjectionHashOfState(state: GameState): string {
  return publicProjectionHash(view(state, 0));
}
