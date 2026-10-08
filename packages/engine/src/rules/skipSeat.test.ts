import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Action, Command, GameEvent } from '../events';
import type { HexId, Seat, VertexId } from '../ids';
import { robberTargets } from '../internal/turn';
import type { LegalActions } from '../legal';
import { legalActions } from '../legal-actions';
import { reduce } from '../reduce';
import { RESOURCES, type GameState, type Phase, type Resource, type ResourceCounts } from '../state';
import { DEFAULT_TEST_BOARD, buildState, forceDice, validateInvariants, type StateSpec } from '../testing';
import { STANDARD_TOPOLOGY as T } from '../topology';
import { view } from '../view';
import { autoRobberHex } from './absence';

type Hand = Partial<Record<Resource, number>>;
const counts = (h: Hand): ResourceCounts => ({ brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0, ...h });
const total = (c: ResourceCounts): number => RESOURCES.reduce((n, r) => n + c[r], 0);
const skip = (seat: Seat, reason: 'host' | 'timer' = 'host'): Command => ({ by: 'system', action: { type: 'skipSeat', seat, reason } });
const act = (by: Seat, action: Action): Command => ({ by, action });

function ok(r: ReturnType<typeof reduce>): { state: GameState; events: readonly GameEvent[] } {
  if (!r.ok) throw new Error(`rejected: ${r.reason}`);
  expect(validateInvariants(r.state)).toEqual([]);
  return { state: r.state, events: r.events };
}
const kinds = (events: readonly GameEvent[]) => events.map((e) => e.kind);

const DESERT = DEFAULT_TEST_BOARD.hexes.find((h) => h.terrain === 'desert')!.id;
/** Every board hex, in canonical order. */
const HEXES = DEFAULT_TEST_BOARD.hexes.map((h) => h.id);

/** A 3-seat state with seat 0 active on turn 4. */
const at = (spec: StateSpec = {}): GameState => buildState({ playerCount: 3, turn: { number: 4, active: 0 }, ...spec });

/** Every legal field of `L` is empty, false or null (seat, phase and bankStock aside). */
function nothingLegal(L: LegalActions): boolean {
  const rest = Object.entries(L).filter(([k]) => k !== 'seat' && k !== 'phase' && k !== 'bankStock').map(([, v]) => v as unknown);
  return rest.every(
    (v) => v === false || v === null || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && Object.keys(v).length === 0),
  );
}

describe('skipSeat precedence (design §3.8)', () => {
  it.each<[string, Phase]>([
    ['setupSettlement', { name: 'setupSettlement', round: 1 } as Phase],
    ['setupRoad', { name: 'setupRoad', round: 1, from: 'v:0,0,N' } as unknown as Phase],
  ])('a skip during %s → skip_not_allowed', (_n, phase) => {
    const s = at({ phase, allowInvariantViolations: true });
    expect(reduce(s, skip(0))).toEqual({ ok: false, reason: 'skip_not_allowed' });
  });

  it('a non-active seat outside discard, or a discard seat that owes nothing → skip_not_allowed', () => {
    expect(reduce(at({ phase: { name: 'main' } }), skip(1))).toEqual({ ok: false, reason: 'skip_not_allowed' });
    const d = at({ phase: { name: 'discard', owed: [0, 4, 0], then: 'moveRobber' }, hands: { 1: { ore: 8 } } });
    expect(reduce(d, skip(2))).toEqual({ ok: false, reason: 'skip_not_allowed' });
  });
});

describe('skipSeat under each obligation (design §5.10)', () => {
  it('main: turnEnded{skipped} and the next seat begins; an open offer is withdrawn', () => {
    const s = at({
      phase: { name: 'main' },
      hands: { 0: { brick: 1 }, 1: { ore: 1 } },
      trade: { id: 3, from: 0, give: counts({ brick: 1 }), get: counts({ ore: 1 }), responses: ['self', 'pending', 'pending'] },
    });
    const { state, events } = ok(reduce(s, skip(0, 'timer')));
    expect(events).toEqual([
      { kind: 'seatSkipped', seat: 0, reason: 'timer' },
      { kind: 'turnEnded', seat: 0, turn: 4, reason: 'skipped' },
      { kind: 'tradeResolved', tradeId: 3, outcome: 'withdrawn', partner: null, exitTo: 'preRoll' },
    ]);
    expect(state.trade).toBeNull();
    expect(state.turn).toEqual({ number: 5, active: 1, dice: null, devPlayed: false });
    expect(state.phase).toEqual({ name: 'preRoll' });
  });

  it('preRoll, non-7: auto-roll with production (dice stream, auto:true), then the turn ends', () => {
    const hex = DEFAULT_TEST_BOARD.hexes.find((h) => h.token === 8 && h.id !== DESERT)!;
    const corner = T.hexCorners(hex.id)[0]!;
    const s = forceDice(at({ phase: { name: 'preRoll' }, pieces: [{ seat: 1, settlements: [corner] }] }), [[3, 5]]);
    const { state, events } = ok(reduce(s, skip(0)));
    expect(kinds(events)).toEqual(['seatSkipped', 'diceRolled', 'turnEnded']);
    expect(events[1]).toMatchObject({ kind: 'diceRolled', seat: 0, dice: [3, 5], auto: true });
    expect(total(state.players[1]!.hand)).toBeGreaterThan(0);
    expect(state.turn).toMatchObject({ number: 5, active: 1 });
  });

  it('preRoll, 7 with nobody over the limit: auto-roll, auto-robber, turn ends', () => {
    const s = forceDice(at({ phase: { name: 'preRoll' }, hands: { 1: { ore: 7 } } }), [[1, 6]]);
    const { state, events } = ok(reduce(s, skip(0)));
    expect(kinds(events)).toEqual(['seatSkipped', 'diceRolled', 'robberMoved', 'turnEnded']);
    expect(events[2]).toMatchObject({ kind: 'robberMoved', seat: 0, victim: null, auto: true });
    expect(state.robber).not.toBe(s.robber);
    expect(state.turn.number).toBe(5);
  });

  it('preRoll, 7 where only absent seats owe: every discard is automatic and the turn ends', () => {
    const s = forceDice(at({ phase: { name: 'preRoll' }, hands: { 0: { ore: 4, wool: 4 }, 1: { ore: 3 } } }), [[3, 4]]);
    const { state, events } = ok(reduce(s, skip(0)));
    expect(kinds(events)).toEqual(['seatSkipped', 'diceRolled', 'discarded', 'robberMoved', 'turnEnded']);
    expect(events[2]).toMatchObject({ kind: 'discarded', seat: 0, auto: true });
    expect(total(state.players[0]!.hand)).toBe(4);
    expect(state.turn.number).toBe(5);
  });

  it('preRoll, 7 with present and absent discarders: the skipped seat discards at once, the others still owe', () => {
    const s = forceDice(
      at({ phase: { name: 'preRoll' }, hands: { 0: { ore: 8 }, 1: { brick: 9 }, 2: { grain: 10 } } }),
      [[3, 4]],
    );
    const first = ok(reduce(s, skip(0)));
    expect(kinds(first.events)).toEqual(['seatSkipped', 'diceRolled', 'discarded']);
    expect(first.state.phase).toEqual({ name: 'discard', owed: [0, 4, 5], then: 'autoRobberThenEnd' });
    expect(first.state.turn.number).toBe(4);

    // Seat 2 is absent too: its discard is automatic, and the turn still waits for seat 1.
    const second = ok(reduce(first.state, skip(2)));
    expect(kinds(second.events)).toEqual(['seatSkipped', 'discarded']);
    expect(second.state.phase).toEqual({ name: 'discard', owed: [0, 4, 0], then: 'autoRobberThenEnd' });

    // Seat 1 is present: its own discard is the last one; the auto-robber runs and the skipped turn ends.
    const last = ok(reduce(second.state, act(1, { type: 'discard', cards: counts({ brick: 4 }) })));
    expect(kinds(last.events)).toEqual(['discarded', 'robberMoved', 'turnEnded']);
    expect(last.events[1]).toMatchObject({ kind: 'robberMoved', seat: 0, victim: null, auto: true });
    expect(last.events[2]).toEqual({ kind: 'turnEnded', seat: 0, turn: 4, reason: 'skipped' });
    expect(last.state.turn).toMatchObject({ number: 5, active: 1 });
    expect(last.state.phase).toEqual({ name: 'preRoll' });
  });

  it('moveRobber: the auto-robber, then `resume` (main) and the turn ends; no steal', () => {
    const s = at({ phase: { name: 'moveRobber', resume: 'main' }, hands: { 1: { ore: 3 } } });
    const { state, events } = ok(reduce(s, skip(0)));
    expect(kinds(events)).toEqual(['seatSkipped', 'robberMoved', 'turnEnded']);
    expect(state.players[1]!.hand.ore).toBe(3);
    expect(state.turn.number).toBe(5);
  });

  it('moveRobber{resume: preRoll} (a Knight before the roll): auto-robber, then auto-roll, then the turn ends', () => {
    const s = forceDice(at({ phase: { name: 'moveRobber', resume: 'preRoll' } }), [[2, 2]]);
    const { state, events } = ok(reduce(s, skip(0)));
    expect(kinds(events)).toEqual(['seatSkipped', 'robberMoved', 'diceRolled', 'turnEnded']);
    expect(state.turn.number).toBe(5);
  });

  it('the robber already on the desert moves to the first hex with no adjacent building', () => {
    const occupied = HEXES.find((h) => h !== DESERT)!;
    const s = at({ phase: { name: 'moveRobber', resume: 'main' }, robber: DESERT, pieces: [{ seat: 1, settlements: [T.hexCorners(occupied)[0]!] }] });
    const { state } = ok(reduce(s, skip(0)));
    const expected = robberTargets(s).find((h) => T.hexCorners(h).every((v) => s.pieces.settlements[v] === undefined && s.pieces.cities[v] === undefined));
    expect(state.robber).toBe(expected);
    expect(state.robber).not.toBe(DESERT);
    expect(state.robber).not.toBe(occupied);
  });

  it('roadBuilding partway through: the remaining free roads are forfeited and the turn ends', () => {
    const s = at({ phase: { name: 'roadBuilding', remaining: 1, resume: 'main' } });
    const roads = s.players[0]!.supply.roads;
    const { state, events } = ok(reduce(s, skip(0)));
    expect(kinds(events)).toEqual(['seatSkipped', 'turnEnded']);
    expect(state.players[0]!.supply.roads).toBe(roads);
    expect(state.turn.number).toBe(5);
  });

  it('roadBuilding{resume: preRoll}: forfeit, then auto-roll, then the turn ends', () => {
    const s = forceDice(at({ phase: { name: 'roadBuilding', remaining: 2, resume: 'preRoll' } }), [[1, 1]]);
    const { events } = ok(reduce(s, skip(0)));
    expect(kinds(events)).toEqual(['seatSkipped', 'diceRolled', 'turnEnded']);
  });

  it('an absent non-active discarder: its discard is automatic and the turn does not end', () => {
    const s = at({ phase: { name: 'discard', owed: [0, 4, 4], then: 'moveRobber' }, hands: { 1: { ore: 8 }, 2: { wool: 9 } } });
    const one = ok(reduce(s, skip(1)));
    expect(kinds(one.events)).toEqual(['seatSkipped', 'discarded']);
    expect(one.state.phase).toEqual({ name: 'discard', owed: [0, 0, 4], then: 'moveRobber' });
    const two = ok(reduce(one.state, skip(2)));
    expect(two.state.phase).toEqual({ name: 'moveRobber', resume: 'main' });
    expect(two.state.turn).toMatchObject({ number: 4, active: 0 });
  });

  it('the active seat skipped in discard while others owe: the turn ends after the last discard (DR4)', () => {
    const s = at({ phase: { name: 'discard', owed: [4, 4, 0], then: 'moveRobber' }, hands: { 0: { ore: 8 }, 1: { wool: 8 } } });
    const one = ok(reduce(s, skip(0)));
    expect(one.state.phase).toEqual({ name: 'discard', owed: [0, 4, 0], then: 'autoRobberThenEnd' });
    const two = ok(reduce(one.state, act(1, { type: 'discard', cards: counts({ wool: 4 }) })));
    expect(kinds(two.events)).toEqual(['discarded', 'robberMoved', 'turnEnded']);
    expect(two.state.turn.number).toBe(5);
  });
});

describe('auto-discard (absence stream)', () => {
  it('draws one absence index per card into the remaining hand, in canonical resource order', () => {
    // Hand expanded: [brick, lumber, lumber, ore × 5]; indices 7, 0, 1 → ore, brick, lumber (from [lumber, lumber, ore × 4]).
    const s = at({
      phase: { name: 'discard', owed: [0, 4, 0], then: 'moveRobber' },
      hands: { 1: { brick: 1, lumber: 2, ore: 5 } },
      rng: { absence: { scripted: [7, 0, 1, 0] } },
    });
    const { state, events } = ok(reduce(s, skip(1)));
    expect(events[1]).toEqual({ kind: 'discarded', seat: 1, cards: counts({ brick: 1, lumber: 2, ore: 1 }), auto: true });
    expect(state.players[1]!.hand).toEqual(counts({ ore: 4 }));
    expect(state.rng.dice).toEqual(s.rng.dice);
    expect(state.rng.steal).toEqual(s.rng.steal);
    expect(state.rng.absence).not.toEqual(s.rng.absence);
  });

  it('is deterministic for a given state and always discards exactly what is owed', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 6 }), { minLength: 5, maxLength: 5 }), fc.string(), (pile, seed) => {
        const hand = Object.fromEntries(RESOURCES.map((r, i) => [r, pile[i]! + 2])) as Hand;
        const n = total(counts(hand));
        const s = at({ phase: { name: 'discard', owed: [0, Math.floor(n / 2), 0], then: 'moveRobber' }, hands: { 1: hand }, rng: { absence: seed } });
        const a = ok(reduce(s, skip(1)));
        const b = ok(reduce(s, skip(1)));
        expect(a.state).toEqual(b.state);
        expect(total(a.state.players[1]!.hand)).toBe(n - Math.floor(n / 2));
      }),
      { numRuns: 100 },
    );
  });
});

describe('DR4: a skipped turn ends after discards', () => {
  it('endsAfterDiscards for every seat; the skipped seat is not revived; the last discard ends the turn without entering main', () => {
    const s = forceDice(at({ phase: { name: 'preRoll' }, hands: { 0: { ore: 2 }, 1: { brick: 8 } } }), [[5, 2]]);
    const skipped = ok(reduce(s, skip(0))).state;
    expect(skipped.phase).toEqual({ name: 'discard', owed: [0, 4, 0], then: 'autoRobberThenEnd' });
    for (const seat of [0, 1, 2] as const) expect(view(skipped, seat).turn.endsAfterDiscards).toBe(true);

    // The skipped seat reconnects: nothing is legal for it and its actions are refused.
    expect(nothingLegal(legalActions(skipped, 0))).toBe(true);
    expect(reduce(skipped, act(0, { type: 'endTurn' }))).toEqual({ ok: false, reason: 'discard_pending' });
    expect(reduce(skipped, act(0, { type: 'discard', cards: counts({ ore: 1 }) }))).toEqual({ ok: false, reason: 'discard_not_required' });

    const last = ok(reduce(skipped, act(1, { type: 'discard', cards: counts({ brick: 4 }) })));
    expect(last.events.some((e) => e.kind === 'robberMoved' && e.auto)).toBe(true);
    expect(last.state.turn.number).toBe(skipped.turn.number + 1);
    expect(last.state.phase).toEqual({ name: 'preRoll' });
    for (const seat of [0, 1, 2] as const) expect(view(last.state, seat).turn.endsAfterDiscards).toBe(false);
    // The skipped turn never reaches main: no state on the way had phase main for seat 0.
    expect(kinds(last.events)).toEqual(['discarded', 'robberMoved', 'turnEnded']);
  });
});

describe('auto-robber placement', () => {
  it('property: deterministic, always within robberTargets, always changes the hex', () => {
    const vertices = [...new Set(HEXES.flatMap((h) => T.hexCorners(h)))] as VertexId[];
    fc.assert(
      fc.property(
        fc.constantFrom(...HEXES),
        fc.uniqueArray(fc.constantFrom(...vertices), { maxLength: 8 }),
        fc.boolean(),
        (robber: HexId, spots, friendly) => {
          // Settlements that respect the distance rule, split between seats 1 and 2.
          const placed: VertexId[] = [];
          for (const v of spots) if (!placed.some((p) => p === v || T.vertexNeighbours(p).includes(v))) placed.push(v);
          const s = at({
            phase: { name: 'moveRobber', resume: 'main' },
            robber,
            rules: { friendlyRobber: { enabled: friendly, maxPublicVp: 2 } },
            pieces: [
              { seat: 1, settlements: placed.filter((_, i) => i % 2 === 0) },
              { seat: 2, settlements: placed.filter((_, i) => i % 2 === 1) },
            ],
            allowInvariantViolations: true,
          });
          const hex = autoRobberHex(s);
          expect(autoRobberHex(s)).toBe(hex);
          expect(hex).not.toBe(robber);
          expect(robberTargets(s)).toContain(hex);
          const r = reduce(s, skip(0));
          expect(r.ok && r.state.robber).toBe(hex);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('prefers the desert when it is a legal target', () => {
    const s = at({ phase: { name: 'moveRobber', resume: 'main' }, robber: HEXES.find((h) => h !== DESERT)! });
    expect(autoRobberHex(s)).toBe(DESERT);
  });
});
