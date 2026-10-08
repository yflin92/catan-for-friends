import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { EdgeId, Seat, VertexId } from '../ids';
import { legalActions } from '../legal-actions';
import { reduce } from '../reduce';
import type { GameState } from '../state';
import { TERRAIN_YIELD } from '../state';
import { DEFAULT_TEST_BOARD, buildState, validateInvariants } from '../testing';
import { STANDARD_TOPOLOGY as T } from '../topology';
import { legalRoadSites, legalSettlementSites, roadSiteIssue, settlementSiteIssue } from './placement';

const setupStart = (playerCount: 3 | 4 = 4): GameState =>
  buildState({ playerCount, phase: { name: 'setupSettlement', round: 1 }, turn: { number: 0, active: 0 } });

const settle = (by: Seat, vertex: VertexId) => ({ by, action: { type: 'placeSettlement' as const, vertex } });
const road = (by: Seat, edge: EdgeId) => ({ by, action: { type: 'placeRoad' as const, edge } });

function apply(s: GameState, cmd: Parameters<typeof reduce>[1]): GameState {
  const r = reduce(s, cmd);
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
  return r.state;
}

/** Plays the whole draft, picking each placement from the legal lists with `pick`. Returns every intermediate state. */
function playSetup(start: GameState, pick: (n: number) => number): { states: GameState[]; order: Seat[] } {
  const states = [start];
  const order: Seat[] = [];
  let s = start;
  for (let i = 0; i < 2 * s.playerCount; i++) {
    const seat = s.turn.active;
    order.push(seat);
    const sites = legalActions(s, seat).placeSettlement;
    s = apply(s, settle(seat, sites[pick(sites.length)]!));
    states.push(s);
    const edges = legalActions(s, seat).placeRoad;
    s = apply(s, road(seat, edges[pick(edges.length)]!));
    states.push(s);
  }
  return { states, order };
}

const nonDesertHexes = (s: GameState, v: VertexId): number =>
  T.vertexHexes(v).filter((h) => s.board.hexes.find((x) => x.id === h)?.terrain !== 'desert').length;

describe('setup snake draft (R4, AC5)', () => {
  it.each<3 | 4>([3, 4])('runs 0..n-1 then n-1..0 and hands turn 1 to seat 0 (%i players)', (n) => {
    const { states, order } = playSetup(setupStart(n), () => 0);
    const expected = [...Array.from({ length: n }, (_, i) => i), ...Array.from({ length: n }, (_, i) => n - 1 - i)];
    expect(order).toEqual(expected);
    const end = states.at(-1)!;
    expect(end.phase).toEqual({ name: 'preRoll' });
    expect(end.turn).toEqual({ number: 1, active: 0, dice: null, devPlayed: false });
    for (const p of end.players) expect(p.supply).toEqual({ settlements: 3, cities: 4, roads: 13 });
    expect(Object.keys(end.pieces.settlements)).toHaveLength(2 * n);
    expect(Object.keys(end.pieces.roads)).toHaveLength(2 * n);
    for (const s of states) expect(validateInvariants(s)).toEqual([]);
  });

  it('alternates settlement and road, with the road phase remembering the settlement', () => {
    const s0 = setupStart(3);
    const v = legalActions(s0, 0).placeSettlement[0]!;
    const s1 = apply(s0, settle(0, v));
    expect(s1.phase).toEqual({ name: 'setupRoad', round: 1, from: v });
    expect(s1.turn.active).toBe(0);
  });

  it('pays only the round-2 settlement: one per adjacent non-desert hex (setupResources event)', () => {
    fc.assert(
      fc.property(fc.array(fc.nat(), { minLength: 20, maxLength: 20 }), (picks) => {
        let k = 0;
        const { states } = playSetup(setupStart(4), (n) => (picks[k++ % picks.length]! % n));
        const end = states.at(-1)!;
        for (const seat of [0, 1, 2, 3] as const) {
          const built = end.log.filter((e) => e.event.kind === 'built' && e.event.seat === seat && e.event.piece === 'settlement');
          const second = built[1]!.event as { at: VertexId };
          const total = Object.values(end.players[seat]!.hand).reduce((a, b) => a + b, 0);
          expect(total).toBe(nonDesertHexes(end, second.at));
        }
        const rewards = end.log.filter((e) => e.event.kind === 'setupResources');
        expect(rewards).toHaveLength(4);
      }),
      { numRuns: 50 },
    );
  });

  it('skips the desert and pays the right resources for a desert-adjacent vertex', () => {
    const desert = DEFAULT_TEST_BOARD.hexes.find((h) => h.terrain === 'desert')!.id;
    const v = T.hexCorners(desert).find((c) => T.vertexHexes(c).length === 3)!;
    const s = buildState({ playerCount: 3, phase: { name: 'setupSettlement', round: 2 }, turn: { number: 0, active: 2 } });
    const r = reduce(s, settle(2, v));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const expected = { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 };
    for (const h of T.vertexHexes(v)) {
      const terrain = DEFAULT_TEST_BOARD.hexes.find((x) => x.id === h)!.terrain;
      if (terrain !== 'desert') expected[TERRAIN_YIELD[terrain]] += 1;
    }
    expect(r.state.players[2]!.hand).toEqual(expected);
    expect(r.events.map((e) => e.kind)).toEqual(['built', 'setupResources']);
    expect(r.events[1]).toEqual({ kind: 'setupResources', seat: 2, gained: expected });
    expect(validateInvariants(r.state)).toEqual([]);
  });

  it('pays nothing for the round-1 settlement', () => {
    const s = setupStart(3);
    const r = reduce(s, settle(0, legalActions(s, 0).placeSettlement[0]!));
    expect(r.ok && r.state.players[0]!.hand).toEqual({ brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 });
    expect(r.ok && r.events.map((e) => e.kind)).toEqual(['built']);
  });
});

describe('setup rejections (AC5, AC6)', () => {
  const first = T.vertices[20]!;
  const placed = (): GameState =>
    buildState({
      playerCount: 3,
      phase: { name: 'setupSettlement', round: 1 },
      turn: { number: 0, active: 1 },
      pieces: [{ seat: 0, settlements: [first], roads: [T.vertexEdges(first)[0]!] }],
    });

  it('invalid_location for a well-formed off-board vertex or edge', () => {
    expect(reduce(placed(), settle(1, 'v:5,5,N'))).toEqual({ ok: false, reason: 'invalid_location' });
    const s = apply(placed(), settle(1, T.vertices[0]!));
    expect(reduce(s, road(1, 'e:9,9,W'))).toEqual({ ok: false, reason: 'invalid_location' });
  });

  it('occupied for a settlement on a building', () => {
    expect(reduce(placed(), settle(1, first))).toEqual({ ok: false, reason: 'occupied' });
  });

  it('distance_rule next to any building (R5)', () => {
    expect(reduce(placed(), settle(1, T.vertexNeighbours(first)[0]!))).toEqual({ ok: false, reason: 'distance_rule' });
  });

  it('needs no road connection during setup', () => {
    const far = legalSettlementSites(placed()).find((v) => !T.vertexEdges(v).some((e) => placed().pieces.roads[e] !== undefined))!;
    expect(reduce(placed(), settle(1, far)).ok).toBe(true);
  });

  it('not_connected for a setup road away from the new settlement', () => {
    const v = legalSettlementSites(placed()).at(-1)!;
    const s = apply(placed(), settle(1, v));
    const away = T.edges.find((e) => !T.edgeVertices(e).includes(v) && s.pieces.roads[e] === undefined)!;
    expect(reduce(s, road(1, away))).toEqual({ ok: false, reason: 'not_connected' });
  });

  it('occupied for a setup road on an edge another seat already holds', () => {
    // seat 0: settlement `first`, roads first–w and w–x. x is two edges from `first`, so seat 1 may settle there,
    // and the edge w–x touches x but is taken.
    const e1 = T.vertexEdges(first)[0]!;
    const w = T.edgeVertices(e1).find((v) => v !== first)!;
    const e2 = T.vertexEdges(w).find((e) => e !== e1)!;
    const x = T.edgeVertices(e2).find((v) => v !== w)!;
    const s0 = buildState({
      playerCount: 3,
      phase: { name: 'setupSettlement', round: 1 },
      turn: { number: 0, active: 1 },
      pieces: [{ seat: 0, settlements: [first], roads: [e1, e2] }],
    });
    const s = apply(s0, settle(1, x));
    expect(reduce(s, road(1, e2))).toEqual({ ok: false, reason: 'occupied' });
  });

  it('precedence: wrong piece for the phase → wrong_phase; wrong seat → not_your_turn', () => {
    const e = T.edges[0]!;
    expect(reduce(placed(), road(1, e))).toEqual({ ok: false, reason: 'wrong_phase' });
    expect(reduce(placed(), settle(2, T.vertices[0]!))).toEqual({ ok: false, reason: 'not_your_turn' });
    const s = apply(placed(), settle(1, T.vertices[0]!));
    expect(reduce(s, settle(1, T.vertices[40]!))).toEqual({ ok: false, reason: 'wrong_phase' });
  });

  it('location is checked before occupancy and distance', () => {
    expect(reduce(placed(), settle(1, 'v:9,9,S'))).toEqual({ ok: false, reason: 'invalid_location' });
  });
});

describe('setup legal actions ⇔ reduce (§3.6, AC6)', () => {
  const reachable = fc
    .record({ n: fc.constantFrom<3 | 4>(3, 4), steps: fc.nat({ max: 15 }), picks: fc.array(fc.nat(), { minLength: 16, maxLength: 16 }) })
    .map(({ n, steps, picks }) => {
      let k = 0;
      const { states } = playSetup(setupStart(n), (m) => (picks[k++]! % m));
      return states[Math.min(steps, states.length - 1)]!;
    });

  it('every vertex and edge is listed exactly when reduce accepts it, for every seat', () => {
    fc.assert(
      fc.property(reachable, (s) => {
        for (const seat of Array.from({ length: s.playerCount }, (_, i) => i as Seat)) {
          const l = legalActions(s, seat);
          for (const v of T.vertices) expect(l.placeSettlement.includes(v)).toBe(reduce(s, settle(seat, v)).ok);
          for (const e of T.edges) expect(l.placeRoad.includes(e)).toBe(reduce(s, road(seat, e)).ok);
        }
      }),
      { numRuns: 60 },
    );
  });

  it('a non-active seat gets no placements', () => {
    const s = setupStart(4);
    for (const seat of [1, 2, 3] as const) {
      expect(legalActions(s, seat).placeSettlement).toEqual([]);
      expect(legalActions(s, seat).placeRoad).toEqual([]);
    }
  });
});

describe('placement validators (R5, R6)', () => {
  const v0 = T.vertices[25]!;
  const [eA, eB] = T.vertexEdges(v0) as [EdgeId, EdgeId];
  const across = T.edgeVertices(eA).find((v) => v !== v0)!;
  const beyond = T.vertexEdges(across).find((e) => e !== eA)!;

  it('a road connects to its own network but never through an opponent’s building', () => {
    // seat 0: settlement v0, roads eA (v0–across) and beyond (across–tip). Seat 1 then builds on tip.
    const tip = T.edgeVertices(beyond).find((v) => v !== across)!;
    const past = T.vertexEdges(tip).find((e) => e !== beyond)!;
    const open = buildState({ pieces: [{ seat: 0, settlements: [v0], roads: [eA, beyond] }] });
    expect(roadSiteIssue(open, 0, past)).toBeNull();
    const blocked = buildState({ pieces: [{ seat: 0, settlements: [v0], roads: [eA, beyond] }, { seat: 1, settlements: [tip] }] });
    expect(roadSiteIssue(blocked, 0, past)).toBe('not_connected');
    expect(roadSiteIssue(blocked, 1, past)).toBeNull();
    expect(roadSiteIssue(blocked, 0, eB)).toBeNull();
  });

  it('settlement sites after setup must touch one of the seat’s roads', () => {
    const s = buildState({ pieces: [{ seat: 0, settlements: [v0], roads: [eA, beyond] }] });
    const tip = T.edgeVertices(beyond).find((v) => v !== across)!;
    expect(settlementSiteIssue(s, tip, 0)).toBeNull();
    expect(settlementSiteIssue(s, tip, 1)).toBe('not_connected');
    expect(legalSettlementSites(s, 0)).toEqual(T.vertices.filter((v) => settlementSiteIssue(s, v, 0) === null));
  });

  it('lists sites in canonical order', () => {
    const s = setupStart(3);
    expect(legalSettlementSites(s)).toEqual(T.vertices);
    const placedState = apply(s, settle(0, T.vertices[10]!));
    expect(legalRoadSites(placedState, 0, T.vertices[10]!)).toEqual(T.edges.filter((e) => T.edgeVertices(e).includes(T.vertices[10]!)));
  });
});
