// Victory (R14, D3, AC18): checkVictory after every successful command and inside beginTurn; game_over afterwards; the
// reveal at gameOver; and the VP-consistency invariants.
import { describe, expect, it } from 'vitest';
import type { Command } from './events';
import type { EdgeId, HexId, VertexId } from './ids';
import { checkVictory } from './internal/turn';
import { reduce } from './reduce';
import type { GameState } from './state';
import { buildState, validateInvariants } from './testing';
import { STANDARD_TOPOLOGY as T } from './topology';
import { view } from './view';
import { victoryPoints } from './victory';

const COSTS = { settlement: { brick: 1, lumber: 1, wool: 1, grain: 1 }, city: { ore: 3, grain: 2 } };

function edgeBetween(a: VertexId, b: VertexId): EdgeId {
  const e = T.vertexEdges(a).find((x) => T.edgeVertices(x).includes(b));
  if (!e) throw new Error(`no edge ${a}–${b}`);
  return e;
}
const walk = (vs: readonly VertexId[]): EdgeId[] => vs.slice(1).map((v, i) => edgeBetween(vs[i]!, v));
/** The top zigzag (NW, N, NE corners) along a row of hexes. */
function topZigzag(...hs: HexId[]): VertexId[] {
  const vs: VertexId[] = [];
  for (const h of hs) {
    const [n, ne, , , , nw] = T.hexCorners(h);
    if (vs.at(-1) !== nw) vs.push(nw!);
    vs.push(n!, ne!);
  }
  return vs;
}
/** `count` vertices pairwise ≥ 2 apart and not adjacent to anything in `avoid`. */
function spreadVertices(count: number, avoid: ReadonlySet<VertexId>): VertexId[] {
  const taken = new Set<VertexId>();
  const blocked = (v: VertexId) => avoid.has(v) || taken.has(v) || T.vertexNeighbours(v).some((n) => taken.has(n) || avoid.has(n));
  for (const v of T.vertices) {
    if (taken.size === count) break;
    if (!blocked(v)) taken.add(v);
  }
  return [...taken];
}
const ok = (s: GameState, cmd: Command): GameState => {
  const r = reduce(s, cmd);
  if (!r.ok) throw new Error(`rejected ${JSON.stringify(cmd)}: ${r.reason}`);
  return r.state;
};
const kinds = (before: GameState, after: GameState) => after.log.filter((e) => e.n > before.logCounter).map((e) => e.event.kind);

describe('checkVictory on the active seat (R14)', () => {
  // Seat 0: three settlements and a hidden VP card (4 VP total) plus the cost of a city; the upgrade makes 5.
  const [s0, s1, s2, s3] = spreadVertices(4, new Set()) as [VertexId, VertexId, VertexId, VertexId];
  const fourSettlements = [s0, s1, s2, s3];
  const upgrade: Command = { by: 0, action: { type: 'buildCity', vertex: s0 } };
  const atFour = (extra: Partial<Parameters<typeof buildState>[0]> = {}) =>
    buildState({
      rules: { vpTarget: 5 },
      pieces: [{ seat: 0, settlements: [s0, s1, s2] }],
      devCards: { 0: [{ kind: 'victoryPoint', boughtOnTurn: 0 }] },
      hands: { 0: COSTS.city },
      ...extra,
    });

  it('ends the game when the active seat reaches the target with its own action, counting hidden VP cards', () => {
    const before = atFour();
    expect(victoryPoints(before, 0)).toEqual({ public: 3, total: 4 });
    const r = reduce(before, upgrade);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.phase).toEqual({ name: 'gameOver', winner: 0 });
    expect(victoryPoints(r.state, 0)).toEqual({ public: 4, total: 5 });
    expect(r.events.at(-1)).toEqual({ kind: 'gameOver', winner: 0, vp: [5, 0, 0, 0] });
    expect(r.state.log.at(-1)?.visibleTo).toBe('all');
  });

  it('withdraws an open offer when the game ends from main', () => {
    const before = atFour({
      hands: { 0: { ...COSTS.city, brick: 1 }, 1: { ore: 1 } },
      trade: { id: 3, from: 0, give: { brick: 1, lumber: 0, wool: 0, grain: 0, ore: 0 }, get: { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 1 }, responses: ['self', 'pending', 'pending', 'pending'] },
    });
    const after = ok(before, upgrade);
    expect(after.trade).toBeNull();
    expect(kinds(before, after)).toEqual(['built', 'tradeResolved', 'gameOver']);
    expect(after.log.find((e) => e.event.kind === 'tradeResolved')?.event).toMatchObject({ outcome: 'withdrawn', exitTo: 'gameOver' });
  });

  it('answers every later command with game_over and changes nothing', () => {
    const over = ok(atFour(), upgrade);
    const later: Command[] = [
      { by: 0, action: { type: 'endTurn' } },
      { by: 1, action: { type: 'rollDice' } },
      { by: 0, action: { type: 'buildCity', vertex: s1 } },
      { by: 'system', action: { type: 'skipSeat', seat: 1, reason: 'host' } },
    ];
    for (const cmd of later) expect(reduce(over, cmd)).toEqual({ ok: false, reason: 'game_over' });
  });

  it('fills the reveal in every view at gameOver and hides VP cards before it', () => {
    const before = atFour({
      devCards: { 0: [{ kind: 'victoryPoint', boughtOnTurn: 0 }], 1: [{ kind: 'victoryPoint', boughtOnTurn: 0 }] },
    });
    expect(view(before, 1).players[0]?.publicVp).toBe(3);
    expect(view(before, 0).players[1]?.publicVp).toBe(0);
    expect(view(before, 0).reveal).toBeNull();
    const over = ok(before, upgrade);
    for (const seat of [0, 1, 2, 3] as const) {
      const v = view(over, seat);
      expect(v.reveal?.vp).toEqual([5, 1, 0, 0]);
      expect(v.reveal?.devCards[0]).toEqual(['victoryPoint']);
      expect(v.reveal?.devCards[1]).toEqual(['victoryPoint']);
      expect(v.players[0]?.publicVp).toBe(4);
    }
  });

  it('wins at exactly the target, never below it, and never in setup', () => {
    const below = buildState({ rules: { vpTarget: 5 }, pieces: [{ seat: 0, settlements: fourSettlements }] });
    expect(checkVictory(below)).toBe(below);
    const atTarget = buildState({
      rules: { vpTarget: 5 },
      pieces: [{ seat: 0, settlements: fourSettlements.slice(0, 3), cities: [] }],
      devCards: { 0: [{ kind: 'victoryPoint', boughtOnTurn: 0 }, { kind: 'victoryPoint', boughtOnTurn: 0 }] },
      allowInvariantViolations: true,
    });
    expect(checkVictory(atTarget).phase).toEqual({ name: 'gameOver', winner: 0 });
    const inSetup = { ...atTarget, phase: { name: 'setupSettlement', round: 2 } as const };
    expect(checkVictory(inSetup)).toBe(inSetup);
    const over = checkVictory(atTarget);
    expect(checkVictory(over)).toBe(over);
  });
});

describe('D3: a seat that reaches the target off-turn wins at its turn start, before rolling', () => {
  // V38a's TLC counterexample: seat 0 (active) breaks seat 2's Longest Road; the award moves to seat 1, which is then
  // at the target while it is not its turn.
  const run2 = topZigzag('h:-2,0', 'h:-1,0', 'h:0,0'); // 7 vertices, 6 edges: seat 2 holds Longest Road
  const run1 = topZigzag('h:-1,-1', 'h:0,-1', 'h:1,-1'); // 6 edges
  const cut = run2[3]!;
  const spur = T.vertexNeighbours(cut).find((n) => !run2.includes(n))!;
  const seat1Settlements = spreadVertices(3, new Set([...run2, spur, ...run1]));

  const before = buildState({
    rules: { vpTarget: 5 },
    pieces: [
      { seat: 0, roads: [edgeBetween(cut, spur)] },
      { seat: 1, settlements: seat1Settlements, roads: walk(run1.slice(0, 6)) },
      { seat: 2, roads: walk(run2) },
    ],
    hands: { 0: COSTS.settlement },
    turn: { active: 0 },
  });

  it('starts from a consistent state: seat 2 holds Longest Road, seat 1 is one award short', () => {
    expect(validateInvariants(before)).toEqual([]);
    expect(before.awards.longestRoad).toBe(2);
    expect(victoryPoints(before, 1).total).toBe(3);
  });

  it('moves the award to seat 1 off-turn without ending the game, then ends it in beginTurn before seat 1 can roll', () => {
    const afterCut = ok(before, { by: 0, action: { type: 'placeSettlement', vertex: cut } });
    expect(afterCut.awards.longestRoad).toBe(1);
    expect(victoryPoints(afterCut, 1).total).toBe(5);
    expect(afterCut.phase.name).toBe('main');
    expect(validateInvariants(afterCut)).toEqual([]);

    const afterEnd = ok(afterCut, { by: 0, action: { type: 'endTurn' } });
    expect(afterEnd.turn.active).toBe(1);
    expect(afterEnd.phase).toEqual({ name: 'gameOver', winner: 1 });
    expect(kinds(afterCut, afterEnd).at(-1)).toBe('gameOver');
    expect(reduce(afterEnd, { by: 1, action: { type: 'rollDice' } })).toEqual({ ok: false, reason: 'game_over' });
  });
});

describe('VP invariants (validateInvariants)', () => {
  it('flags an active seat at the target outside gameOver', () => {
    const s = buildState({
      rules: { vpTarget: 5 },
      pieces: [{ seat: 0, settlements: spreadVertices(5, new Set()) }],
      allowInvariantViolations: true,
    });
    expect(validateInvariants(s).map((i) => i.code)).toContain('victory');
    expect(validateInvariants({ ...s, phase: { name: 'gameOver', winner: 0 } }).map((i) => i.code)).not.toContain('victory');
    expect(validateInvariants({ ...s, turn: { ...s.turn, active: 1 } }).map((i) => i.code)).not.toContain('victory');
  });

  it('agrees with victoryPoints for awards, cities and VP cards', () => {
    const run = topZigzag('h:-2,0', 'h:-1,0', 'h:0,0');
    const s = buildState({
      pieces: [{ seat: 2, settlements: [run[0]!], cities: [run[4]!], roads: walk(run.slice(0, 6)) }],
      playedDev: { 2: { knight: 3 } },
      devCards: { 2: [{ kind: 'victoryPoint', boughtOnTurn: 0 }] },
    });
    expect(victoryPoints(s, 2)).toEqual({ public: 1 + 2 + 2 + 2, total: 8 });
    expect(validateInvariants(s).filter((i) => i.code === 'victory_points')).toEqual([]);
  });
});
