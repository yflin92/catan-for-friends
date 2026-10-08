// buildState: builds any GameState from a declarative spec without playing to it (design §3.10, TH4).
import { generateBoard } from '../board';
import { DEFAULT_GAME_CONFIG, type GameRules } from '../config';
import type { EdgeId, HexId, Seat, VertexId } from '../ids';
import { longestRoadHolder, longestRoadLength } from '../longest-road';
import { RNG_STREAMS, seedStream, type RngStream, type RngStreamState } from '../rng';
import {
  RESOURCES,
  type Board,
  type DevCardKind,
  type GameState,
  type Phase,
  type PlayerState,
  type ResourceCounts,
  type TradeOffer,
} from '../state';
import { DEFAULT_TEST_BOARD } from './board';
import { deepFreeze } from './freeze';
import { DEV_CARD_COUNTS, PIECES_PER_SEAT, RESOURCE_TOTAL, validateInvariants } from './invariants';
import { scriptedStream } from './rng';

export interface StateSpec {
  readonly playerCount?: 3 | 4;
  readonly rules?: Partial<GameRules>;
  readonly board?: Board | { readonly seed: string };
  readonly robber?: HexId;
  readonly pieces?: readonly {
    readonly seat: Seat;
    readonly settlements?: readonly VertexId[];
    readonly cities?: readonly VertexId[];
    readonly roads?: readonly EdgeId[];
  }[];
  readonly hands?: Partial<Record<Seat, Partial<ResourceCounts>>>;
  readonly devCards?: Partial<Record<Seat, readonly { readonly kind: DevCardKind; readonly boughtOnTurn: number }[]>>;
  readonly playedDev?: Partial<Record<Seat, Partial<PlayerState['playedDev']>>>;
  /** Default: the remainder of the 25 cards, in DEFAULT_DECK_ORDER. */
  readonly devDeck?: readonly DevCardKind[];
  /** Default 'derived' = 19 − Σ hands, per resource. */
  readonly bank?: 'derived' | ResourceCounts;
  readonly turn?: Partial<GameState['turn']>;
  readonly phase?: Phase;
  readonly trade?: TradeOffer | null;
  /** Award holders. Each given key replaces the derived holder; omitted keys are derived (a tie derives to null). */
  readonly awards?: Partial<GameState['awards']>;
  /** Per stream: a seed string, or scripted values followed by sfc32 from `seed`. Unlisted streams use BUILD_SEED. */
  readonly rng?: Partial<Record<RngStream, string | { readonly scripted: readonly number[]; readonly seed?: string }>>;
  /** Default false: buildState throws when the built state violates an invariant. */
  readonly allowInvariantViolations?: boolean;
}

/** Seed for every stream the spec does not set. */
export const BUILD_SEED = 'buildState';

/** Kind order of the default deck. The deck draws from its end, so victory points come first. */
export const DEFAULT_DECK_ORDER: readonly DevCardKind[] = Object.freeze([
  'knight', 'roadBuilding', 'yearOfPlenty', 'monopoly', 'victoryPoint',
]);

const ZERO: ResourceCounts = Object.freeze({ brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 });
const NO_PLAYED: PlayerState['playedDev'] = Object.freeze({ knight: 0, roadBuilding: 0, yearOfPlenty: 0, monopoly: 0 });

/**
 * Builds a state from `spec`. Defaults:
 * - 4 players, DEFAULT_GAME_CONFIG.rules overlaid with `rules`;
 * - board DEFAULT_TEST_BOARD, robber on the board's desert. A `{seed}` board is the board createGame generates for
 *   that board-stream seed under these rules;
 * - empty hands, no dev cards, nothing played, no pieces; supply = 5/4/15 minus the pieces placed;
 * - bank 19 − Σ hands; dev deck = the cards not in hands or played, in DEFAULT_DECK_ORDER;
 * - phase main, turn {number: 1 (0 in a setup phase), active: 0, dice: null, devPlayed: false};
 * - no open offer; nextTradeId = open offer id + 1, else 1; empty log;
 * - every RNG stream seeded from BUILD_SEED.
 * Longest-road caches come from the engine's longestRoadLength. Unless `awards` sets them, Longest Road goes to the seat
 * that alone has the longest road, if ≥ 5 (longestRoadHolder with no previous holder), and Largest Army to the seat that
 * alone has the most played knights, if ≥ 3. validateInvariants still applies to the result.
 * The result is deep-frozen. Throws (test-only) when the state violates an invariant unless `allowInvariantViolations`.
 */
export function buildState(spec: StateSpec = {}): GameState {
  const playerCount = spec.playerCount ?? 4;
  const seats = Array.from({ length: playerCount }, (_, i) => i as Seat);
  const config: GameRules = { ...DEFAULT_GAME_CONFIG.rules, ...spec.rules };

  const board =
    spec.board === undefined
      ? DEFAULT_TEST_BOARD
      : 'seed' in spec.board
        ? generateBoard(seedStream(spec.board.seed, 'board'), config)[0]
        : spec.board;
  const desert = board.hexes.find((h) => h.terrain === 'desert');
  const robber = spec.robber ?? desert?.id;
  if (robber === undefined) throw new Error('buildState: the board has no desert, so spec.robber is required');

  const settlements: Record<VertexId, Seat> = {};
  const cities: Record<VertexId, Seat> = {};
  const roads: Record<EdgeId, Seat> = {};
  for (const p of spec.pieces ?? []) {
    for (const v of p.settlements ?? []) settlements[v] = p.seat;
    for (const v of p.cities ?? []) cities[v] = p.seat;
    for (const e of p.roads ?? []) roads[e] = p.seat;
  }
  const placed = (record: Record<string, Seat>, seat: Seat) => Object.values(record).filter((s) => s === seat).length;

  const players: PlayerState[] = seats.map((seat) => ({
    hand: { ...ZERO, ...spec.hands?.[seat] },
    devCards: [...(spec.devCards?.[seat] ?? [])],
    playedDev: { ...NO_PLAYED, ...spec.playedDev?.[seat] },
    supply: {
      settlements: PIECES_PER_SEAT.settlements - placed(settlements, seat),
      cities: PIECES_PER_SEAT.cities - placed(cities, seat),
      roads: PIECES_PER_SEAT.roads - placed(roads, seat),
    },
    longestRoad: 0,
  }));

  const bank =
    spec.bank === undefined || spec.bank === 'derived'
      ? Object.fromEntries(RESOURCES.map((r) => [r, RESOURCE_TOTAL - players.reduce((n, p) => n + p.hand[r], 0)]))
      : spec.bank;

  const devDeck = spec.devDeck ?? remainingDeck(players);

  const phase: Phase = spec.phase ?? { name: 'main' };
  const setup = phase.name === 'setupSettlement' || phase.name === 'setupRoad';
  const turn: GameState['turn'] = { number: setup ? 0 : 1, active: 0, dice: null, devPlayed: false, ...spec.turn };
  const trade = spec.trade ?? null;

  const rng = Object.fromEntries(RNG_STREAMS.map((s) => [s, streamFor(s, spec.rng?.[s])])) as Record<RngStream, RngStreamState>;

  const built: GameState = {
    schemaVersion: 1,
    config,
    playerCount,
    board,
    robber,
    pieces: { settlements, cities, roads },
    players,
    bank: bank as ResourceCounts,
    devDeck: [...devDeck],
    turn,
    phase,
    trade,
    nextTradeId: trade === null ? 1 : trade.id + 1,
    awards: { longestRoad: null, largestArmy: null },
    rng,
    log: [],
    logCounter: 0,
  };
  const lengths = seats.map((seat) => longestRoadLength(built, seat));
  const given = spec.awards ?? {};
  const state: GameState = {
    ...built,
    players: players.map((p, i) => ({ ...p, longestRoad: lengths[i]! })),
    awards: {
      longestRoad: 'longestRoad' in given ? (given.longestRoad ?? null) : longestRoadHolder(null, lengths),
      largestArmy: 'largestArmy' in given ? (given.largestArmy ?? null) : largestArmyHolder(players),
    },
  };

  if (!spec.allowInvariantViolations) {
    const issues = validateInvariants(state);
    if (issues.length > 0) {
      throw new Error(`buildState: invariant violations:\n${issues.map((i) => `  ${i.code}: ${i.detail}`).join('\n')}`);
    }
  }
  return deepFreeze(state);
}

/** The cards not in any hand or played, grouped in DEFAULT_DECK_ORDER. A kind over its total contributes none. */
function remainingDeck(players: readonly PlayerState[]): DevCardKind[] {
  return DEFAULT_DECK_ORDER.flatMap((kind) => {
    const used = players.reduce(
      (n, p) => n + p.devCards.filter((c) => c.kind === kind).length + (kind === 'victoryPoint' ? 0 : p.playedDev[kind]),
      0,
    );
    return Array<DevCardKind>(Math.max(0, DEV_CARD_COUNTS[kind] - used)).fill(kind);
  });
}

function largestArmyHolder(players: readonly PlayerState[]): Seat | null {
  const knights = players.map((p) => p.playedDev.knight);
  const max = Math.max(...knights);
  return max >= 3 && knights.filter((k) => k === max).length === 1 ? (knights.indexOf(max) as Seat) : null;
}

function streamFor(stream: RngStream, spec: string | { readonly scripted: readonly number[]; readonly seed?: string } | undefined): RngStreamState {
  if (spec === undefined) return seedStream(BUILD_SEED, stream);
  if (typeof spec === 'string') return seedStream(spec, stream);
  return scriptedStream(seedStream(spec.seed ?? BUILD_SEED, stream), spec.scripted);
}
