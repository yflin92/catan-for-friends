// Longest Road (design §6 R12, AC15). A seat's length is the longest edge-simple trail in its road graph that never
// passes through a vertex holding an opponent's building (it may start or end there). Exact DFS; a seat has ≤ 15 roads.
// recomputeLongestRoad refreshes every seat's cached length and the award; road and settlement placements call it, so
// the award can move on another seat's turn.
import type { EdgeId, Seat, VertexId } from './ids';
import { emit } from './log';
import type { GameState } from './state';
import { STANDARD_TOPOLOGY } from './topology';

/** Minimum length to hold Longest Road. */
export const LONGEST_ROAD_MIN = 5;

/**
 * Length of the longest trail (no edge used twice; vertices may repeat) over `roads`, where no interior vertex of the
 * trail is in `blocked`. `roads` are edge ids of the standard board.
 */
export function longestTrail(roads: readonly EdgeId[], blocked: ReadonlySet<VertexId>): number {
  const ends = roads.map((e) => STANDARD_TOPOLOGY.edgeVertices(e));
  const incident = new Map<VertexId, number[]>();
  ends.forEach(([a, b], i) => {
    for (const v of [a, b]) {
      const list = incident.get(v);
      if (list === undefined) incident.set(v, [i]);
      else list.push(i);
    }
  });

  let best = 0;
  const used = new Uint8Array(roads.length);
  // `at` is reached over at least one edge, so it is an interior vertex if the trail continues.
  const extend = (at: VertexId, length: number): void => {
    if (length > best) best = length;
    if (blocked.has(at)) return;
    for (const i of incident.get(at)!) {
      if (used[i]) continue;
      const [a, b] = ends[i]!;
      used[i] = 1;
      extend(a === at ? b : a, length + 1);
      used[i] = 0;
    }
  };
  ends.forEach(([a, b], i) => {
    used[i] = 1;
    extend(b, 1);
    extend(a, 1);
    used[i] = 0;
  });
  return best;
}

/** Longest Road length of `seat`: its roads, with every opponent settlement or city blocking passage. */
export function longestRoadLength(state: GameState, seat: Seat): number {
  const roads = (Object.keys(state.pieces.roads) as EdgeId[]).filter((e) => state.pieces.roads[e] === seat);
  const blocked = new Set<VertexId>();
  for (const buildings of [state.pieces.settlements, state.pieces.cities]) {
    for (const v of Object.keys(buildings) as VertexId[]) if (buildings[v] !== seat) blocked.add(v);
  }
  return longestTrail(roads, blocked);
}

/**
 * The Longest Road holder after a change, given the current holder and every seat's length (index = seat):
 * (1) the holder keeps it if its length is ≥ 5 and nobody is strictly longer; (2) otherwise the unique maximum ≥ 5
 * takes it; (3) otherwise it is set aside (null).
 */
export function longestRoadHolder(holder: Seat | null, lengths: readonly number[]): Seat | null {
  const max = Math.max(0, ...lengths);
  const own = holder === null ? 0 : (lengths[holder] ?? 0);
  if (holder !== null && own >= LONGEST_ROAD_MIN && own === max) return holder;
  const leaders = lengths.flatMap((l, s) => (l === max ? [s as Seat] : []));
  return max >= LONGEST_ROAD_MIN && leaders.length === 1 ? leaders[0]! : null;
}

/** Recomputes every seat's cached length and the award; logs awardChanged when the holder changes. */
export function recomputeLongestRoad(state: GameState): GameState {
  const lengths = state.players.map((_, s) => longestRoadLength(state, s as Seat));
  const from = state.awards.longestRoad;
  const to = longestRoadHolder(from, lengths);
  const next: GameState = {
    ...state,
    players: state.players.map((p, s) => (p.longestRoad === lengths[s] ? p : { ...p, longestRoad: lengths[s]! })),
    awards: from === to ? state.awards : { ...state.awards, longestRoad: to },
  };
  return from === to ? next : emit(next, { kind: 'awardChanged', award: 'longestRoad', from, to });
}
