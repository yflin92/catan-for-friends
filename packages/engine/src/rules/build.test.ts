import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { apply, city, playSetup, road, settle, setupStart } from '../__fixtures__/play';
import { COSTS } from '../costs';
import type { Seat, VertexId } from '../ids';
import { legalActions } from '../legal-actions';
import { reduce } from '../reduce';
import type { GameState, ResourceCounts } from '../state';
import { RESOURCES } from '../state';
import { buildState, validateInvariants } from '../testing';
import { STANDARD_TOPOLOGY as T } from '../topology';

const ZERO: ResourceCounts = { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 };
const many = (n: number): ResourceCounts => ({ brick: n, lumber: n, wool: n, grain: n, ore: n });

/** Moves `cards` from the bank to `seat` (resources stay conserved). */
function fund(s: GameState, seat: Seat, cards: ResourceCounts): GameState {
  const take = Object.fromEntries(RESOURCES.map((r) => [r, Math.min(cards[r], s.bank[r])])) as unknown as ResourceCounts;
  return {
    ...s,
    bank: Object.fromEntries(RESOURCES.map((r) => [r, s.bank[r] - take[r]])) as unknown as ResourceCounts,
    players: s.players.map((p, i) =>
      i === seat ? { ...p, hand: Object.fromEntries(RESOURCES.map((r) => [r, p.hand[r] + take[r]])) as unknown as ResourceCounts } : p,
    ),
  };
}

/** A state after a full setup draft, in seat 0's main phase, with seat 0 funded. */
function mainAfterSetup(n: 3 | 4, picks: readonly number[], funds = many(4)): GameState {
  let k = 0;
  const end = playSetup(setupStart(n), (m) => picks[k++ % picks.length]! % m).states.at(-1)!;
  return fund({ ...end, phase: { name: 'main' }, turn: { ...end.turn, dice: [3, 4] } }, 0, funds);
}


describe('main-phase builds (R3, AC8)', () => {
  const s0 = mainAfterSetup(4, [0]);

  it('a road costs brick + lumber, moves hand → bank, uses supply and logs built{free:false}', () => {
    const e = legalActions(s0, 0).placeRoad[0]!;
    const r = reduce(s0, road(0, e));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const before = s0.players[0]!;
    const after = r.state.players[0]!;
    for (const res of RESOURCES) {
      expect(after.hand[res]).toBe(before.hand[res] - COSTS.road[res]);
      expect(r.state.bank[res]).toBe(s0.bank[res] + COSTS.road[res]);
    }
    expect(after.supply.roads).toBe(before.supply.roads - 1);
    expect(r.state.pieces.roads[e]).toBe(0);
    expect(r.events).toEqual([{ kind: 'built', seat: 0, piece: 'road', at: e, free: false }]);
  });

  it('a settlement costs brick + lumber + wool + grain and needs the seat’s road', () => {
    // seat 0: settlement v0 and roads v0–across–tip; tip is two edges from v0, so it is a legal site.
    const v0 = T.vertices[25]!;
    const eA = T.vertexEdges(v0)[0]!;
    const across = T.edgeVertices(eA).find((v) => v !== v0)!;
    const beyond = T.vertexEdges(across).find((e) => e !== eA)!;
    const tip = T.edgeVertices(beyond).find((v) => v !== across)!;
    const s = buildState({ phase: { name: 'main' }, pieces: [{ seat: 0, settlements: [v0], roads: [eA, beyond] }], hands: { 0: many(1) } });
    expect(legalActions(s, 0).placeSettlement).toContain(tip);
    const r = reduce(s, settle(0, tip));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.players[0]!.hand).toEqual({ brick: 0, lumber: 0, wool: 0, grain: 0, ore: 1 });
    expect(r.state.players[0]!.supply.settlements).toBe(s.players[0]!.supply.settlements - 1);
    expect(r.events).toEqual([{ kind: 'built', seat: 0, piece: 'settlement', at: tip, free: false }]);
    expect(validateInvariants(r.state)).toEqual([]);
  });

  it('a city costs 2 grain + 3 ore, replaces the settlement and returns it to supply', () => {
    const v = Object.entries(s0.pieces.settlements).find(([, seat]) => seat === 0)![0] as VertexId;
    const r = reduce(s0, city(0, v));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.state.players[0]!;
    expect(r.state.pieces.settlements[v]).toBeUndefined();
    expect(r.state.pieces.cities[v]).toBe(0);
    expect(p.supply).toEqual({ settlements: s0.players[0]!.supply.settlements + 1, cities: 3, roads: s0.players[0]!.supply.roads });
    expect(p.hand.grain).toBe(s0.players[0]!.hand.grain - 2);
    expect(p.hand.ore).toBe(s0.players[0]!.hand.ore - 3);
    expect(r.events).toEqual([{ kind: 'built', seat: 0, piece: 'city', at: v, free: false }]);
    expect(validateInvariants(r.state)).toEqual([]);
  });
});

/** Returns every card in `seat`'s hand to the bank. */
function strip(s: GameState, seat: Seat): GameState {
  const hand = s.players[seat]!.hand;
  return {
    ...s,
    bank: Object.fromEntries(RESOURCES.map((r) => [r, s.bank[r] + hand[r]])) as unknown as ResourceCounts,
    players: s.players.map((p, i) => (i === seat ? { ...p, hand: ZERO } : p)),
  };
}

describe('build rejections and precedence (AC6, AC8, §3.8)', () => {
  const poor = strip(mainAfterSetup(4, [0], ZERO), 0);
  const rich = mainAfterSetup(4, [0]);
  const ownSettlement = Object.entries(rich.pieces.settlements).find(([, seat]) => seat === 0)![0] as VertexId;
  const otherSettlement = Object.entries(rich.pieces.settlements).find(([, seat]) => seat === 1)![0] as VertexId;
  const noSupply = (s: GameState, piece: 'roads' | 'settlements' | 'cities'): GameState => ({
    ...s,
    // A targeted state: only the supply counter changes, to reach no_pieces_left directly.
    players: s.players.map((p, i) => (i === 0 ? { ...p, supply: { ...p.supply, [piece]: 0 } } : p)),
  });

  it('insufficient_resources for each build when one card is missing', () => {
    const e = legalActions(rich, 0).placeRoad[0]!;
    expect(reduce(poor, road(0, e))).toEqual({ ok: false, reason: 'insufficient_resources' });
    expect(reduce(fund(poor, 0, { ...ZERO, grain: 2, ore: 2 }), city(0, ownSettlement))).toEqual({
      ok: false,
      reason: 'insufficient_resources',
    });
  });

  it('no_pieces_left beats insufficient_resources, and comes after the site checks', () => {
    const e = legalActions(rich, 0).placeRoad[0]!;
    expect(reduce(noSupply(poor, 'roads'), road(0, e))).toEqual({ ok: false, reason: 'no_pieces_left' });
    expect(reduce(noSupply(poor, 'cities'), city(0, ownSettlement))).toEqual({ ok: false, reason: 'no_pieces_left' });
    const far = T.edges.find((x) => rich.pieces.roads[x] === undefined && reduce(rich, road(0, x)).ok === false)!;
    expect(reduce(noSupply(poor, 'roads'), road(0, far))).toEqual({ ok: false, reason: 'not_connected' });
  });

  it('settlement codes: occupied, distance_rule, not_connected (main needs an own road)', () => {
    expect(reduce(rich, settle(0, ownSettlement))).toEqual({ ok: false, reason: 'occupied' });
    expect(reduce(rich, settle(0, T.vertexNeighbours(ownSettlement)[0]!))).toEqual({ ok: false, reason: 'distance_rule' });
    const unconnected = T.vertices.find((v) =>
      T.vertexNeighbours(v).every((n) => rich.pieces.settlements[n] === undefined) &&
      rich.pieces.settlements[v] === undefined &&
      !T.vertexEdges(v).some((e) => rich.pieces.roads[e] === 0),
    )!;
    expect(reduce(rich, settle(0, unconnected))).toEqual({ ok: false, reason: 'not_connected' });
  });

  it('city codes: invalid_location unless on the seat’s own settlement', () => {
    expect(reduce(rich, city(0, otherSettlement))).toEqual({ ok: false, reason: 'invalid_location' });
    const empty = T.vertices.find((v) => rich.pieces.settlements[v] === undefined)!;
    expect(reduce(rich, city(0, empty))).toEqual({ ok: false, reason: 'invalid_location' });
    expect(reduce(rich, city(0, 'v:7,7,N'))).toEqual({ ok: false, reason: 'invalid_location' });
    const upgraded = apply(rich, city(0, ownSettlement));
    expect(reduce(fund(upgraded, 0, many(3)), city(0, ownSettlement))).toEqual({ ok: false, reason: 'invalid_location' });
  });

  it('road codes: invalid_location, occupied, never through an opponent’s building', () => {
    expect(reduce(rich, road(0, 'e:8,8,NE'))).toEqual({ ok: false, reason: 'invalid_location' });
    const taken = Object.keys(rich.pieces.roads)[0] as Parameters<typeof road>[1];
    expect(reduce(rich, road(0, taken))).toEqual({ ok: false, reason: 'occupied' });
    // seat 0 road ending at seat 1's building cannot be extended past it
    const v0 = T.vertices[25]!;
    const [eA] = T.vertexEdges(v0);
    const across = T.edgeVertices(eA!).find((v) => v !== v0)!;
    const beyond = T.vertexEdges(across).find((e) => e !== eA)!;
    const tip = T.edgeVertices(beyond).find((v) => v !== across)!;
    const past = T.vertexEdges(tip).find((e) => e !== beyond)!;
    const s = buildState({
      pieces: [{ seat: 0, settlements: [v0], roads: [eA!, beyond] }, { seat: 1, settlements: [tip] }],
      hands: { 0: many(2) },
    });
    expect(reduce(s, road(0, past))).toEqual({ ok: false, reason: 'not_connected' });
    expect(reduce(s, { by: 0, action: { type: 'placeRoad', edge: T.vertexEdges(v0).find((e) => e !== eA)! } }).ok).toBe(true);
  });

  it('only the active seat builds, and only in main', () => {
    const e = legalActions(rich, 0).placeRoad[0]!;
    expect(reduce(rich, road(1, e))).toEqual({ ok: false, reason: 'not_your_turn' });
    expect(reduce({ ...rich, phase: { name: 'preRoll' } }, road(0, e))).toEqual({ ok: false, reason: 'wrong_phase' });
  });
});

describe('build properties', () => {
  const arbPicks = fc.array(fc.nat(), { minLength: 8, maxLength: 8 });

  /** Plays up to `steps` random legal builds for the active seat. */
  function randomBuilds(start: GameState, choices: readonly number[]): GameState[] {
    const out = [start];
    let s = start;
    for (const c of choices) {
      const l = legalActions(s, 0);
      const options = [
        ...l.placeRoad.map((e) => road(0, e)),
        ...l.placeSettlement.map((v) => settle(0, v)),
        ...l.buildCity.map((v) => city(0, v)),
      ];
      if (options.length === 0) break;
      s = apply(s, options[c % options.length]!);
      out.push(s);
    }
    return out;
  }

  it('pieces on board + supply stay 5/4/15 and resources stay 19 per type (invariants after every build)', () => {
    fc.assert(
      fc.property(fc.constantFrom<3 | 4>(3, 4), arbPicks, fc.array(fc.nat(), { maxLength: 12 }), (n, picks, choices) => {
        for (const s of randomBuilds(mainAfterSetup(n, picks, many(6)), choices)) {
          expect(validateInvariants(s)).toEqual([]);
        }
      }),
      { numRuns: 60 },
    );
  });

  it('legal placeRoad / placeSettlement / buildCity ⇔ reduce, for every edge and vertex and every seat', () => {
    fc.assert(
      fc.property(fc.constantFrom<3 | 4>(3, 4), arbPicks, fc.array(fc.nat(), { maxLength: 6 }), fc.nat({ max: 3 }), (n, picks, choices, funding) => {
        const states = randomBuilds(mainAfterSetup(n, picks, many(funding + 1)), choices);
        const s = states.at(-1)!;
        for (const seat of Array.from({ length: n }, (_, i) => i as Seat)) {
          const l = legalActions(s, seat);
          for (const e of T.edges) expect(l.placeRoad.includes(e)).toBe(reduce(s, road(seat, e)).ok);
          for (const v of T.vertices) {
            expect(l.placeSettlement.includes(v)).toBe(reduce(s, settle(seat, v)).ok);
            expect(l.buildCity.includes(v)).toBe(reduce(s, city(seat, v)).ok);
          }
        }
      }),
      { numRuns: 40 },
    );
  });
});
