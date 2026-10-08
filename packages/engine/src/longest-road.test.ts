import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { EdgeId, HexId, Seat, VertexId } from './ids';
import { longestRoadHolder, longestRoadLength, longestTrail, recomputeLongestRoad } from './longest-road';
import { buildState, validateInvariants } from './testing';
import type { GameState } from './state';
import { STANDARD_TOPOLOGY as T } from './topology';

function edgeBetween(a: VertexId, b: VertexId): EdgeId {
  const e = T.vertexEdges(a).find((x) => T.edgeVertices(x).includes(b));
  if (e === undefined) throw new Error(`${a} and ${b} are not adjacent`);
  return e;
}

/** Edges along a vertex walk. */
const walk = (...vs: VertexId[]): EdgeId[] => vs.slice(1).map((v, i) => edgeBetween(vs[i]!, v));

/** The 6 edges around a hex. */
function ring(h: HexId): EdgeId[] {
  const c = T.hexCorners(h);
  return c.map((v, i) => edgeBetween(v, c[(i + 1) % 6]!));
}

/** Zigzag along the top of a row of hexes: NW → N → NE of each hex (2 edges per hex). */
function topZigzag(...hs: HexId[]): VertexId[] {
  const vs: VertexId[] = [];
  for (const h of hs) {
    const [n, ne, , , , nw] = T.hexCorners(h);
    if (vs.length === 0) vs.push(nw!);
    vs.push(n!, ne!);
  }
  return vs;
}

const NONE = new Set<VertexId>();
const [N0, NE0, SE0, S0, SW0, NW0] = T.hexCorners('h:0,0') as [VertexId, VertexId, VertexId, VertexId, VertexId, VertexId];
/** The neighbour of a ring vertex that is not on the ring of h:0,0. */
const outward = (v: VertexId): VertexId => T.vertexNeighbours(v).find((n) => !T.hexCorners('h:0,0').includes(n))!;

describe('longestTrail fixtures (design §6 R12, AC15)', () => {
  it('no roads → 0; one road → 1', () => {
    expect(longestTrail([], NONE)).toBe(0);
    expect(longestTrail([walk(N0, NE0)[0]!], NONE)).toBe(1);
  });

  it('a straight run counts every road', () => {
    const run = topZigzag('h:-2,0', 'h:-1,0', 'h:0,0'); // 7 vertices, 6 edges
    expect(longestTrail(walk(...run), NONE)).toBe(6);
  });

  it('Y-branch: only the two longest arms count', () => {
    // Centre N0 with arms: N0→NE0→SE0→S0 (3), N0→NW0→SW0 (2), N0→outward (1).
    const roads = [...walk(N0, NE0, SE0, S0), ...walk(N0, NW0, SW0), ...walk(N0, outward(N0))];
    expect(longestTrail(roads, NONE)).toBe(5);
  });

  it('loop: a closed hex ring counts all 6', () => {
    expect(longestTrail(ring('h:0,0'), NONE)).toBe(6);
  });

  it('loop with tail: tail plus the whole ring', () => {
    const t1 = outward(N0);
    const t2 = T.vertexNeighbours(t1).find((v) => v !== N0)!;
    expect(longestTrail([...ring('h:0,0'), ...walk(N0, t1, t2)], NONE)).toBe(8);
  });

  it('figure-8: two adjacent rings (11 roads) are one trail', () => {
    const roads = [...new Set([...ring('h:0,0'), ...ring('h:1,0')])];
    expect(roads).toHaveLength(11);
    expect(longestTrail(roads, NONE)).toBe(11);
  });

  it('broken middle: an opponent building splits a run; an own building does not', () => {
    const run = topZigzag('h:-2,0', 'h:-1,0', 'h:0,0', 'h:1,0'); // 9 vertices, 8 edges
    const roads = walk(...run);
    expect(longestTrail(roads, NONE)).toBe(8);
    expect(longestTrail(roads, new Set([run[3]!]))).toBe(5); // 3 | 5
    expect(longestTrail(roads, new Set([run[4]!]))).toBe(4); // 4 | 4
    expect(longestTrail(roads, new Set([run[3]!, run[6]!]))).toBe(3); // 3 | 3 | 2
  });

  it('an opponent building at an end of the run does not shorten it', () => {
    const run = topZigzag('h:-2,0', 'h:-1,0', 'h:0,0');
    expect(longestTrail(walk(...run), new Set([run[0]!, run[6]!]))).toBe(6);
  });

  it('opponent on a ring vertex: the ring still counts (start and end there), but nothing passes through', () => {
    expect(longestTrail(ring('h:0,0'), new Set([N0]))).toBe(6);
    const t1 = outward(N0);
    const t2 = T.vertexNeighbours(t1).find((v) => v !== N0)!;
    const roads = [...ring('h:0,0'), ...walk(N0, t1, t2)];
    expect(longestTrail(roads, new Set([N0]))).toBe(6);
    expect(longestTrail(roads, new Set([S0]))).toBe(6); // with the tail, S0 would be interior: ring alone (S0→S0) wins
    expect(longestTrail(roads, new Set([t2]))).toBe(8); // blocked tail end is still an end
    expect(oracle(roads, new Set([S0]))).toBe(6);
  });

  it('opponent at the junction of a Y-branch cuts it into arms', () => {
    const roads = [...walk(N0, NE0, SE0, S0), ...walk(N0, NW0, SW0), ...walk(N0, outward(N0))];
    expect(longestTrail(roads, new Set([N0]))).toBe(3);
  });
});

describe('longestRoadLength(state, seat)', () => {
  it('uses only the seat’s roads and treats other seats’ settlements and cities as blocking', () => {
    const run = topZigzag('h:-2,0', 'h:-1,0', 'h:0,0', 'h:1,0');
    const roads: Partial<Record<EdgeId, Seat>> = {};
    for (const e of walk(...run)) roads[e] = 0;
    roads[walk(SE0, S0)[0]!] = 1;
    type At = readonly (readonly [VertexId, Seat])[];
    const pieces = (settlements: At, cities: At) =>
      ({ pieces: { roads, settlements: Object.fromEntries(settlements), cities: Object.fromEntries(cities) } }) as unknown as GameState;

    expect(longestRoadLength(pieces([], []), 0)).toBe(8);
    expect(longestRoadLength(pieces([], []), 1)).toBe(1);
    expect(longestRoadLength(pieces([[run[3]!, 0]], []), 0)).toBe(8);
    expect(longestRoadLength(pieces([[run[3]!, 2]], []), 0)).toBe(5);
    expect(longestRoadLength(pieces([], [[run[4]!, 1]]), 0)).toBe(4);
    expect(longestRoadLength(pieces([], []), 3)).toBe(0);
  });
});

/**
 * Brute-force oracle, independent of the DFS: the answer is the largest edge subset that one trail can cover.
 * A connected subset is one trail iff it has 0 or 2 odd-degree vertices (Euler). A blocked vertex may only be an end:
 * degree 1, or degree 2 as the start/end of a closed trail (then it is the only blocked vertex touched).
 */
function oracle(roads: readonly EdgeId[], blocked: ReadonlySet<VertexId>): number {
  const n = roads.length;
  const ends = roads.map((e) => T.edgeVertices(e));
  let best = 0;
  for (let mask = 1; mask < 1 << n; mask++) {
    const size = popcount(mask);
    if (size <= best) continue;
    const parent = new Map<VertexId, VertexId>();
    const find = (v: VertexId): VertexId => {
      const p = parent.get(v) ?? v;
      if (p === v) return v;
      const root = find(p);
      parent.set(v, root);
      return root;
    };
    const degree = new Map<VertexId, number>();
    for (let i = 0; i < n; i++) {
      if (!(mask & (1 << i))) continue;
      const [a, b] = ends[i]!;
      degree.set(a, (degree.get(a) ?? 0) + 1);
      degree.set(b, (degree.get(b) ?? 0) + 1);
      parent.set(find(a), find(b));
    }
    const roots = new Set([...degree.keys()].map(find));
    if (roots.size !== 1) continue;
    const odd = [...degree.values()].filter((d) => d % 2 === 1).length;
    if (odd !== 0 && odd !== 2) continue;
    const blockedDegrees = [...degree].filter(([v]) => blocked.has(v)).map(([, d]) => d);
    const ok = odd === 2 ? blockedDegrees.every((d) => d === 1) : blockedDegrees.length <= 1;
    if (ok) best = size;
  }
  return best;
}

function popcount(x: number): number {
  let c = 0;
  for (; x; x &= x - 1) c++;
  return c;
}

/** Random road networks of ≤ 15 edges: mostly grown from adjacent edges, sometimes a disconnected jump. */
const network = fc
  .record({
    start: fc.nat({ max: T.edges.length - 1 }),
    steps: fc.array(fc.record({ jump: fc.nat({ max: 9 }), pick: fc.nat() }), { maxLength: 14 }),
    blockPicks: fc.array(fc.nat(), { maxLength: 6 }),
  })
  .map(({ start, steps, blockPicks }) => {
    const roads: EdgeId[] = [T.edges[start]!];
    for (const { jump, pick } of steps) {
      const candidates =
        jump === 0
          ? T.edges.filter((e) => !roads.includes(e))
          : [...new Set(roads.flatMap((r) => T.edgeVertices(r).flatMap((v) => T.vertexEdges(v))))].filter(
              (e) => !roads.includes(e),
            );
      if (candidates.length > 0) roads.push(candidates[pick % candidates.length]!);
    }
    const touched = [...new Set(roads.flatMap((r) => T.edgeVertices(r)))];
    const blocked = new Set(blockPicks.map((p) => touched[p % touched.length]!));
    return { roads, blocked };
  });

describe('longestTrail equals a brute-force oracle (AC15 property)', () => {
  it('on random networks of ≤ 15 roads with opponent buildings', () => {
    fc.assert(
      fc.property(network, ({ roads, blocked }) => {
        expect(longestTrail(roads, blocked)).toBe(oracle(roads, blocked));
      }),
      { numRuns: 300 },
    );
  });

  it('the oracle agrees with every fixed fixture', () => {
    const roads = [...new Set([...ring('h:0,0'), ...ring('h:1,0')])];
    expect(oracle(roads, NONE)).toBe(11);
    expect(oracle(ring('h:0,0'), new Set([N0]))).toBe(6);
    expect(oracle([...walk(N0, NE0, SE0, S0), ...walk(N0, NW0, SW0), ...walk(N0, outward(N0))], NONE)).toBe(5);
  });
});

describe('longestRoadHolder: award order (design §6 R12)', () => {
  it('(1) the holder keeps it at ≥ 5 unless someone is strictly longer, including on a tie', () => {
    expect(longestRoadHolder(0, [5, 5, 0, 0])).toBe(0);
    expect(longestRoadHolder(0, [6, 5, 0, 0])).toBe(0);
    expect(longestRoadHolder(0, [5, 6, 0, 0])).toBe(1);
  });

  it('(2) otherwise the unique maximum ≥ 5 takes it', () => {
    expect(longestRoadHolder(null, [0, 5, 4, 0])).toBe(1);
    expect(longestRoadHolder(0, [4, 5, 3, 0])).toBe(1);
  });

  it('(3) otherwise it is set aside', () => {
    expect(longestRoadHolder(null, [5, 5, 0, 0])).toBeNull();
    expect(longestRoadHolder(0, [4, 6, 6, 0])).toBeNull();
    expect(longestRoadHolder(0, [4, 4, 0, 0])).toBeNull();
    expect(longestRoadHolder(null, [4, 0, 0])).toBeNull();
  });
});

describe('recomputeLongestRoad (AC15)', () => {
  // Three disjoint runs along the tops of rows r = 0, r = −1 and r = 2.
  const run0 = topZigzag('h:-2,0', 'h:-1,0', 'h:0,0'); // 6 edges
  const run1 = topZigzag('h:-1,-1', 'h:0,-1', 'h:1,-1'); // 6 edges
  const run2 = topZigzag('h:-2,2', 'h:-1,2', 'h:0,2'); // 6 edges
  const roads = (run: VertexId[], n: number) => walk(...run.slice(0, n + 1));
  const awardEvents = (s: GameState) => s.log.filter((e) => e.event.kind === 'awardChanged').map((e) => e.event);

  it('awards a first unique road of ≥ 5, refreshes every cache and logs awardChanged', () => {
    const s = buildState({ pieces: [{ seat: 0, roads: roads(run0, 5) }, { seat: 1, roads: roads(run1, 3) }] });
    expect(s.awards.longestRoad).toBe(0);
    const reset = { ...s, awards: { ...s.awards, longestRoad: null }, players: s.players.map((p) => ({ ...p, longestRoad: 0 })) };
    const next = recomputeLongestRoad(reset);
    expect(next.players.map((p) => p.longestRoad)).toEqual([5, 3, 0, 0]);
    expect(next.awards.longestRoad).toBe(0);
    expect(awardEvents(next)).toEqual([{ kind: 'awardChanged', award: 'longestRoad', from: null, to: 0 }]);
  });

  it('keeps the award with its holder on a tie, with no event', () => {
    const s = buildState({ pieces: [{ seat: 0, roads: roads(run0, 5) }, { seat: 1, roads: roads(run1, 5) }], awards: { longestRoad: 0 } });
    const next = recomputeLongestRoad(s);
    expect(next.awards.longestRoad).toBe(0);
    expect(next.log).toEqual(s.log);
  });

  it('moves on another seat’s turn when an opponent settlement breaks the holder’s road', () => {
    const s = buildState({
      pieces: [{ seat: 0, roads: roads(run0, 6) }, { seat: 1, roads: roads(run1, 5) }],
      turn: { active: 1 },
    });
    expect(s.awards.longestRoad).toBe(0);
    const broken = { ...s, pieces: { ...s.pieces, settlements: { ...s.pieces.settlements, [run0[3]!]: 1 as Seat } } };
    const next = recomputeLongestRoad(broken);
    expect(next.players.map((p) => p.longestRoad)).toEqual([3, 5, 0, 0]);
    expect(next.awards.longestRoad).toBe(1);
    expect(awardEvents(next)).toEqual([{ kind: 'awardChanged', award: 'longestRoad', from: 0, to: 1 }]);
  });

  it('sets the award aside on a tie among non-holders after a break', () => {
    const s = buildState({
      pieces: [{ seat: 0, roads: roads(run0, 6) }, { seat: 1, roads: roads(run1, 5) }, { seat: 2, roads: roads(run2, 5) }],
    });
    expect(s.awards.longestRoad).toBe(0);
    const broken = { ...s, pieces: { ...s.pieces, settlements: { [run0[3]!]: 3 as Seat } } };
    const next = recomputeLongestRoad(broken);
    expect(next.players.map((p) => p.longestRoad)).toEqual([3, 5, 5, 0]);
    expect(next.awards.longestRoad).toBeNull();
    expect(awardEvents(next)).toEqual([{ kind: 'awardChanged', award: 'longestRoad', from: 0, to: null }]);
  });

  it('sets the award aside when a break leaves nobody ≥ 5', () => {
    const s = buildState({ pieces: [{ seat: 0, roads: roads(run0, 5) }, { seat: 1, roads: roads(run1, 4) }] });
    const broken = { ...s, pieces: { ...s.pieces, settlements: { [run0[2]!]: 2 as Seat } } };
    const next = recomputeLongestRoad(broken);
    expect(next.awards.longestRoad).toBeNull();
    expect(next.players[0]!.longestRoad).toBe(3);
  });

  it('is the identity (same log, same award) when nothing changed, and never mutates its input', () => {
    const s = buildState({ pieces: [{ seat: 0, roads: roads(run0, 6) }] });
    const next = recomputeLongestRoad(s);
    expect(next.awards).toEqual(s.awards);
    expect(next.log).toBe(s.log);
    expect(next.players).toEqual(s.players);
  });
});

describe('buildState awards (D8)', () => {
  const run0 = topZigzag('h:-2,0', 'h:-1,0', 'h:0,0');
  const run1 = topZigzag('h:-1,-1', 'h:0,-1', 'h:1,-1');
  const tie = [{ seat: 0 as Seat, roads: walk(...run0.slice(0, 6)) }, { seat: 1 as Seat, roads: walk(...run1.slice(0, 6)) }];

  it('derives longest-road caches and a tie to no holder', () => {
    const s = buildState({ pieces: tie });
    expect(s.players.map((p) => p.longestRoad)).toEqual([5, 5, 0, 0]);
    expect(s.awards.longestRoad).toBeNull();
    expect(s.log).toEqual([]);
  });

  it('lets a given key override the derived holder (tied holders are valid)', () => {
    expect(buildState({ pieces: tie, awards: { longestRoad: 1 } }).awards).toEqual({ longestRoad: 1, largestArmy: null });
    expect(buildState({ playedDev: { 0: { knight: 3 }, 2: { knight: 3 } }, awards: { largestArmy: 2 } }).awards.largestArmy).toBe(2);
    expect(buildState({ playedDev: { 0: { knight: 3 } }, awards: { largestArmy: null }, allowInvariantViolations: true }).awards.largestArmy).toBeNull();
  });

  it('still applies validateInvariants to an override', () => {
    expect(() => buildState({ pieces: tie, awards: { longestRoad: 2 } })).toThrow(/award/);
    expect(() => buildState({ playedDev: { 0: { knight: 4 }, 1: { knight: 3 } }, awards: { largestArmy: 1 } })).toThrow(/award/);
    const s = buildState({ pieces: tie, awards: { longestRoad: 2 }, allowInvariantViolations: true });
    expect(validateInvariants(s).map((i) => i.code)).toEqual(['award', 'award']); // below 5, and strictly beaten
  });
});
