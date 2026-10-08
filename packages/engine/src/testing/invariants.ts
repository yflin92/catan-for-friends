// Global state invariants (design §3.10, AC19): the oracle every property test checks after each action.
import type { Seat, VertexId } from '../ids';
import { RESOURCES, type DevCardKind, type GameState } from '../state';
import { STANDARD_TOPOLOGY, isEdgeId, isVertexId } from '../topology';

export interface InvariantIssue {
  readonly code: string;
  readonly detail: string;
}

/** Copies of each resource in the game (bank + hands). */
export const RESOURCE_TOTAL = 19;
/** Pieces per seat (board + supply). */
export const PIECES_PER_SEAT = Object.freeze({ settlements: 5, cities: 4, roads: 15 });
/** The 25 development cards by kind (deck + hands + played). */
export const DEV_CARD_COUNTS: Readonly<Record<DevCardKind, number>> = Object.freeze({
  knight: 14, roadBuilding: 2, yearOfPlenty: 2, monopoly: 2, victoryPoint: 5,
});
const LONGEST_ROAD_MIN = 5;
const LARGEST_ARMY_MIN = 3;

const isCount = (n: unknown): boolean => typeof n === 'number' && Number.isInteger(n) && n >= 0;

/**
 * Checks `state` against the global invariants and returns every violation found (empty = consistent). Issue codes:
 * - `player_count`: players.length ≠ playerCount;
 * - `negative_count`: a hand, bank, supply or played-dev-card entry that is not a non-negative integer;
 * - `resource_total`: bank + hands ≠ 19 for a resource;
 * - `piece_location`: a piece on an id that is not on the board, owned by a seat outside the game, or a settlement and a
 *   city on the same vertex;
 * - `piece_total`: board + supply ≠ 5 settlements / 4 cities / 15 roads for a seat;
 * - `dev_card_total`: deck + hands + played ≠ 14/2/2/2/5 for a kind;
 * - `distance_rule`: two buildings on adjacent vertices;
 * - `award`: an award holder outside the game, below its threshold (Longest Road 5, Largest Army 3) or strictly beaten
 *   by another seat; or no holder while one seat alone meets the threshold with the strict maximum;
 * - `robber`: the robber is not on a hex of the board;
 * - `trade`: an open offer outside phase main, not from the active seat, or with an id ≥ nextTradeId.
 */
export function validateInvariants(state: GameState): readonly InvariantIssue[] {
  const issues: InvariantIssue[] = [];
  const add = (code: string, detail: string) => issues.push({ code, detail });
  const seats = Array.from({ length: state.playerCount }, (_, i) => i as Seat);
  const inGame = (s: unknown): boolean => typeof s === 'number' && Number.isInteger(s) && s >= 0 && s < state.playerCount;

  if (state.players.length !== state.playerCount) {
    add('player_count', `${state.players.length} players for playerCount ${state.playerCount}`);
  }

  for (const r of RESOURCES) {
    if (!isCount(state.bank[r])) add('negative_count', `bank ${r} = ${state.bank[r]}`);
    let total = state.bank[r];
    state.players.forEach((p, s) => {
      if (!isCount(p.hand[r])) add('negative_count', `seat ${s} hand ${r} = ${p.hand[r]}`);
      total += p.hand[r];
    });
    if (total !== RESOURCE_TOTAL) add('resource_total', `${r}: bank + hands = ${total}, expected ${RESOURCE_TOTAL}`);
  }

  const { settlements, cities, roads } = state.pieces;
  const placed = state.players.map(() => ({ settlements: 0, cities: 0, roads: 0 }));
  const count = (kind: keyof typeof PIECES_PER_SEAT, id: string, owner: unknown, valid: boolean) => {
    if (!valid) add('piece_location', `${kind} on ${id}, which is not on the board`);
    if (!inGame(owner)) add('piece_location', `${kind} on ${id} owned by seat ${String(owner)}, not in the game`);
    else if (placed[owner as number]) placed[owner as number]![kind]++;
  };
  for (const [v, s] of Object.entries(settlements)) count('settlements', v, s, isVertexId(v));
  for (const [v, s] of Object.entries(cities)) {
    count('cities', v, s, isVertexId(v));
    if (v in settlements) add('piece_location', `both a settlement and a city on ${v}`);
  }
  for (const [e, s] of Object.entries(roads)) count('roads', e, s, isEdgeId(e));
  state.players.forEach((p, s) => {
    for (const kind of ['settlements', 'cities', 'roads'] as const) {
      if (!isCount(p.supply[kind])) add('negative_count', `seat ${s} supply ${kind} = ${p.supply[kind]}`);
      const total = (placed[s]?.[kind] ?? 0) + p.supply[kind];
      if (total !== PIECES_PER_SEAT[kind]) {
        add('piece_total', `seat ${s} ${kind}: board + supply = ${total}, expected ${PIECES_PER_SEAT[kind]}`);
      }
    }
  });

  state.players.forEach((p, s) => {
    for (const [kind, n] of Object.entries(p.playedDev)) {
      if (!isCount(n)) add('negative_count', `seat ${s} playedDev ${kind} = ${n}`);
    }
  });

  for (const kind of Object.keys(DEV_CARD_COUNTS) as DevCardKind[]) {
    let total = state.devDeck.filter((k) => k === kind).length;
    for (const p of state.players) {
      total += p.devCards.filter((c) => c.kind === kind).length;
      if (kind !== 'victoryPoint') total += p.playedDev[kind];
    }
    if (total !== DEV_CARD_COUNTS[kind]) {
      add('dev_card_total', `${kind}: deck + hands + played = ${total}, expected ${DEV_CARD_COUNTS[kind]}`);
    }
  }

  const buildings = [...Object.keys(settlements), ...Object.keys(cities)].filter(isVertexId);
  const occupied = new Set<VertexId>(buildings);
  for (const v of STANDARD_TOPOLOGY.vertices) {
    if (!occupied.has(v)) continue;
    for (const n of STANDARD_TOPOLOGY.vertexNeighbours(v)) {
      if (occupied.has(n) && STANDARD_TOPOLOGY.vertices.indexOf(n) > STANDARD_TOPOLOGY.vertices.indexOf(v)) {
        add('distance_rule', `buildings on adjacent vertices ${v} and ${n}`);
      }
    }
  }

  checkAward('longestRoad', state.awards.longestRoad, seats.map((s) => state.players[s]?.longestRoad ?? 0), LONGEST_ROAD_MIN);
  checkAward('largestArmy', state.awards.largestArmy, seats.map((s) => state.players[s]?.playedDev.knight ?? 0), LARGEST_ARMY_MIN);
  function checkAward(award: string, holder: Seat | null, values: readonly number[], min: number): void {
    const max = Math.max(0, ...values);
    if (holder === null) {
      const leaders = values.filter((v) => v === max);
      if (max >= min && leaders.length === 1) add('award', `${award}: no holder, but seat ${values.indexOf(max)} alone has ${max}`);
      return;
    }
    if (!inGame(holder)) {
      add('award', `${award}: holder seat ${holder} is not in the game`);
      return;
    }
    const own = values[holder] ?? 0;
    if (own < min) add('award', `${award}: holder seat ${holder} has ${own} < ${min}`);
    if (max > own) add('award', `${award}: holder seat ${holder} has ${own}, seat ${values.indexOf(max)} has ${max}`);
  }

  if (!state.board.hexes.some((h) => h.id === state.robber)) add('robber', `robber on ${state.robber}, not a board hex`);

  const { trade } = state;
  if (trade !== null) {
    if (state.phase.name !== 'main') add('trade', `offer ${trade.id} open in phase ${state.phase.name}`);
    if (trade.from !== state.turn.active) add('trade', `offer ${trade.id} from seat ${trade.from}, active seat is ${state.turn.active}`);
    if (trade.id >= state.nextTradeId) add('trade', `offer id ${trade.id} ≥ nextTradeId ${state.nextTradeId}`);
  }
  return issues;
}
