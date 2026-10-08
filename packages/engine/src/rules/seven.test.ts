import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Action, Command } from '../events';
import { stateHash } from '../hash';
import type { HexId, Seat, VertexId } from '../ids';
import { robberTargets } from '../internal/turn';
import { legalActions } from '../legal-actions';
import { reduce } from '../reduce';
import { RESOURCES, type GameState, type Phase, type Resource, type ResourceCounts } from '../state';
import { DEFAULT_TEST_BOARD, buildState, enumerateLegalActions, forceDice, scriptRng, validateInvariants } from '../testing';
import { STANDARD_TOPOLOGY as T } from '../topology';
import { victoryPoints } from '../victory';

type Hand = Partial<Record<Resource, number>>;
type Pieces = NonNullable<Parameters<typeof buildState>[0]>['pieces'];

const counts = (h: Hand): ResourceCounts => ({ brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0, ...h });
const total = (c: ResourceCounts): number => RESOURCES.reduce((n, r) => n + c[r], 0);
const cmd = (by: Seat, action: Action): Command => ({ by, action });
const discard = (by: Seat, cards: Hand): Command => cmd(by, { type: 'discard', cards: counts(cards) });
const rob = (by: Seat, hex: HexId, victim: Seat | null): Command => cmd(by, { type: 'moveRobber', hex, victim });
const ok = (r: ReturnType<typeof reduce>): GameState => {
  if (!r.ok) throw new Error(`rejected: ${r.reason}`);
  return r.state;
};
const events = (s: GameState) => s.log.map((e) => e.event);

const DESERT = DEFAULT_TEST_BOARD.hexes.find((h) => h.terrain === 'desert')!.id;
/** A producing hex and two of its corners that are not adjacent (N and S). */
const HEX = DEFAULT_TEST_BOARD.hexes.find((h) => h.terrain !== 'desert')!.id;
const [N, , , S] = T.hexCorners(HEX) as [VertexId, VertexId, VertexId, VertexId];
/** A hex sharing no corner with HEX. */
const FAR = DEFAULT_TEST_BOARD.hexes.find(
  (h) => h.id !== DESERT && !T.hexCorners(h.id).some((v) => T.hexCorners(HEX).includes(v)),
)!.id;

/** A 3-seat state, seat 0 active on turn 4. */
const seven = (spec: Parameters<typeof buildState>[0] = {}): GameState =>
  buildState({ playerCount: 3, turn: { number: 4, active: 0 }, ...spec });

describe('a rolled 7 (R9, AC9)', () => {
  it('every hand over discardLimit owes ⌊n/2⌋ and the phase becomes discard{then: moveRobber}', () => {
    const s = forceDice(
      seven({ phase: { name: 'preRoll' }, hands: { 0: { ore: 8 }, 1: { brick: 4, wool: 5 }, 2: { grain: 7 } } }),
      [[3, 4]],
    );
    const r = ok(reduce(s, cmd(0, { type: 'rollDice' })));
    expect(r.phase).toEqual({ name: 'discard', owed: [4, 4, 0], then: 'moveRobber' });
    expect(events(r).map((e) => e.kind)).toEqual(['diceRolled']);
  });

  it('nobody over the limit goes straight to moveRobber{resume: main}', () => {
    const s = forceDice(seven({ phase: { name: 'preRoll' }, hands: { 0: { ore: 7 }, 1: { brick: 7 } } }), [[1, 6]]);
    expect(ok(reduce(s, cmd(0, { type: 'rollDice' }))).phase).toEqual({ name: 'moveRobber', resume: 'main' });
  });

  it('follows config.discardLimit', () => {
    const s = forceDice(seven({ phase: { name: 'preRoll' }, rules: { discardLimit: 3 }, hands: { 1: { ore: 4 }, 2: { ore: 3 } } }), [[2, 5]]);
    expect(ok(reduce(s, cmd(0, { type: 'rollDice' }))).phase).toEqual({ name: 'discard', owed: [0, 2, 0], then: 'moveRobber' });
  });
});

describe('discard (AC9)', () => {
  const PHASE: Phase = { name: 'discard', owed: [4, 5, 0], then: 'moveRobber' };
  const base = () => seven({ phase: PHASE, hands: { 0: { ore: 8 }, 1: { brick: 6, wool: 4 }, 2: { grain: 2 } } });

  it('discard_not_required for a seat that owes nothing', () => {
    expect(reduce(base(), discard(2, { grain: 1 }))).toEqual({ ok: false, reason: 'discard_not_required' });
    expect(reduce(base(), discard(2, {}))).toEqual({ ok: false, reason: 'discard_not_required' });
  });

  it('wrong_discard_count for a wrong total or cards not held', () => {
    expect(reduce(base(), discard(0, { ore: 3 }))).toEqual({ ok: false, reason: 'wrong_discard_count' });
    expect(reduce(base(), discard(0, { ore: 5 }))).toEqual({ ok: false, reason: 'wrong_discard_count' });
    expect(reduce(base(), discard(0, { ore: 3, brick: 1 }))).toEqual({ ok: false, reason: 'wrong_discard_count' });
    expect(reduce(base(), discard(1, { wool: 5 }))).toEqual({ ok: false, reason: 'wrong_discard_count' });
  });

  it('wrong_discard_count for a negative count, even when the total matches (D18)', () => {
    expect(reduce(base(), discard(0, { ore: 5, brick: -1 }))).toEqual({ ok: false, reason: 'wrong_discard_count' });
    expect(reduce(base(), discard(1, { brick: 6, wool: -1 }))).toEqual({ ok: false, reason: 'wrong_discard_count' });
  });

  it('D18 codes around the discard phase', () => {
    // In discard: a non-owing seat's discard → discard_not_required (not not_your_turn); any other type → discard_pending.
    expect(reduce(base(), discard(2, { grain: 1 }))).toEqual({ ok: false, reason: 'discard_not_required' });
    expect(reduce(base(), cmd(2, { type: 'endTurn' }))).toEqual({ ok: false, reason: 'discard_pending' });
    // After it: a late discard → wrong_phase from every seat; a robber move from a non-mover → not_your_turn.
    const robber = seven({ phase: { name: 'moveRobber', resume: 'main' }, hands: { 1: { ore: 2 } } });
    for (const seat of [0, 1, 2] as const) expect(reduce(robber, discard(seat, { ore: 1 }))).toEqual({ ok: false, reason: 'wrong_phase' });
    expect(reduce(robber, rob(1, FAR, null))).toEqual({ ok: false, reason: 'not_your_turn' });
  });

  it('pays the bank, zeroes that seat’s entry, logs discarded publicly and waits for the others', () => {
    const s = base();
    const r = ok(reduce(s, discard(1, { brick: 3, wool: 2 })));
    expect(r.players[1]!.hand).toEqual(counts({ brick: 3, wool: 2 }));
    expect(r.bank.brick).toBe(s.bank.brick + 3);
    expect(r.bank.wool).toBe(s.bank.wool + 2);
    expect(r.phase).toEqual({ ...PHASE, owed: [4, 0, 0] });
    expect(r.log.at(-1)).toMatchObject({
      event: { kind: 'discarded', seat: 1, cards: counts({ brick: 3, wool: 2 }), auto: false },
      visibleTo: 'all',
    });
    expect(reduce(r, discard(1, { brick: 1 }))).toEqual({ ok: false, reason: 'discard_not_required' });
    expect(validateInvariants(r)).toEqual([]);
  });

  it('every other action meanwhile is discard_pending, the roller’s included', () => {
    expect(reduce(base(), rob(0, FAR, null))).toEqual({ ok: false, reason: 'discard_pending' });
    expect(reduce(base(), cmd(0, { type: 'endTurn' }))).toEqual({ ok: false, reason: 'discard_pending' });
  });

  it('the last discard enters moveRobber{resume: main} exactly once', () => {
    const a = ok(reduce(base(), discard(0, { ore: 4 })));
    expect(a.phase.name).toBe('discard');
    const b = ok(reduce(a, discard(1, { brick: 5 })));
    expect(b.phase).toEqual({ name: 'moveRobber', resume: 'main' });
    expect(reduce(b, discard(0, { ore: 1 }))).toEqual({ ok: false, reason: 'wrong_phase' });
  });

  it('legal.discard is {count: owed} for owing seats and null otherwise', () => {
    const s = base();
    expect([0, 1, 2].map((seat) => legalActions(s, seat as Seat).discard)).toEqual([{ count: 4 }, { count: 5 }, null]);
    expect(legalActions(seven({ hands: { 0: { ore: 9 } } }), 0).discard).toBeNull();
  });
});

describe('discard properties (V14)', () => {
  const arbHands = fc.array(
    fc.record({ brick: fc.nat({ max: 4 }), lumber: fc.nat({ max: 4 }), wool: fc.nat({ max: 4 }), grain: fc.nat({ max: 4 }), ore: fc.nat({ max: 4 }) }),
    { minLength: 4, maxLength: 4 },
  );

  /** Discards the first `owed` cards of each owing seat's hand in canonical order. */
  const discardsFor = (s: GameState): Command[] => {
    if (s.phase.name !== 'discard') return [];
    const { owed } = s.phase;
    return s.players.flatMap((p, seat) => {
      let left = owed[seat] ?? 0;
      if (left === 0) return [];
      const cards = Object.fromEntries(RESOURCES.map((r) => {
        const n = Math.min(left, p.hand[r]);
        left -= n;
        return [r, n];
      })) as Hand;
      return [discard(seat as Seat, cards)];
    });
  };

  it('discards in any order reach the same state (log order aside) and enter moveRobber once', () => {
    fc.assert(
      fc.property(arbHands, fc.nat(), (hands, k) => {
        const s0 = forceDice(
          buildState({ playerCount: 4, phase: { name: 'preRoll' }, turn: { number: 3, active: 1 }, rules: { discardLimit: 5 }, hands: Object.fromEntries(hands.map((h, i) => [i, h])) }),
          [[3, 4]],
        );
        const s = ok(reduce(s0, cmd(1, { type: 'rollDice' })));
        const cmds = discardsFor(s);
        const orders = [cmds, [...cmds].reverse(), cmds.map((_, i) => cmds[(i + k) % cmds.length]!)];
        const ends = orders.map((order) => {
          let st = s;
          for (const [i, c] of order.entries()) {
            st = ok(reduce(st, c));
            expect(st.phase.name).toBe(i === order.length - 1 ? 'moveRobber' : 'discard');
            expect(validateInvariants(st)).toEqual([]);
          }
          return st;
        });
        const sansLog = (st: GameState) => stateHash({ ...st, log: [] });
        const discarded = (st: GameState) => events(st).filter((e) => e.kind === 'discarded').map((e) => JSON.stringify(e)).sort();
        for (const end of ends) {
          expect(end.phase).toEqual({ name: 'moveRobber', resume: 'main' });
          expect(sansLog(end)).toBe(sansLog(ends[0]!));
          expect(discarded(end)).toEqual(discarded(ends[0]!));
        }
      }),
      { numRuns: 150 },
    );
  });

  it('every enumerated legal discard is accepted, for every seat', () => {
    const s = seven({ phase: { name: 'discard', owed: [0, 2, 1], then: 'moveRobber' }, hands: { 1: { brick: 2, ore: 2 }, 2: { wool: 1, grain: 1 } } });
    for (const seat of [0, 1, 2] as const) {
      const all = enumerateLegalActions(s, seat).filter((a) => a.type === 'discard');
      expect(all.length).toBe([0, 3, 2][seat]);
      for (const a of all) expect(reduce(s, cmd(seat, a)).ok).toBe(true);
    }
  });
});

describe('moveRobber (R9, AC10)', () => {
  const MOVE: Phase = { name: 'moveRobber', resume: 'main' };
  const pieces: Pieces = [{ seat: 1, settlements: [N] }, { seat: 2, cities: [S] }];
  const base = (spec: Parameters<typeof buildState>[0] = {}) =>
    seven({ phase: MOVE, pieces, hands: { 1: { brick: 1, ore: 2 }, 2: { wool: 1 } }, ...spec });

  it('robber_must_move for the current hex', () => {
    expect(reduce(base(), rob(0, DESERT, null))).toEqual({ ok: false, reason: 'robber_must_move' });
  });

  it('invalid_robber_hex for a hex off the board', () => {
    expect(reduce(base(), rob(0, 'h:4,0', null))).toEqual({ ok: false, reason: 'invalid_robber_hex' });
  });

  it('invalid_steal_target: no building there, no cards, the mover, or null while someone qualifies', () => {
    expect(reduce(base(), rob(0, HEX, 0))).toEqual({ ok: false, reason: 'invalid_steal_target' });
    expect(reduce(base(), rob(0, FAR, 1))).toEqual({ ok: false, reason: 'invalid_steal_target' });
    expect(reduce(base(), rob(0, HEX, null))).toEqual({ ok: false, reason: 'invalid_steal_target' });
    expect(reduce(base({ hands: { 1: { brick: 1 } } }), rob(0, HEX, 2))).toEqual({ ok: false, reason: 'invalid_steal_target' });
    const mine = seven({ phase: MOVE, pieces: [{ seat: 0, settlements: [N] }], hands: { 0: { ore: 3 } } });
    expect(reduce(mine, rob(0, HEX, 0))).toEqual({ ok: false, reason: 'invalid_steal_target' });
    expect(reduce(mine, rob(0, HEX, null)).ok).toBe(true);
  });

  it('victim null moves the robber with no steal when nobody qualifies', () => {
    const r = ok(reduce(base(), rob(0, FAR, null)));
    expect(r.robber).toBe(FAR);
    expect(r.players).toEqual(base().players);
    expect(events(r)).toEqual([{ kind: 'robberMoved', seat: 0, hex: FAR, victim: null, auto: false }]);
    expect(r.phase).toEqual({ name: 'main' });
  });

  it('steals the steal-stream index of the victim’s hand in canonical resource order', () => {
    // seat 1 holds [brick, ore, ore]: index 0 → brick, index 2 → ore
    for (const [i, resource] of [[0, 'brick'], [1, 'ore'], [2, 'ore']] as const) {
      const s = scriptRng(base(), 'steal', [i]);
      const r = ok(reduce(s, rob(0, HEX, 1)));
      expect(r.players[0]!.hand[resource]).toBe(1);
      expect(r.players[1]!.hand[resource]).toBe(s.players[1]!.hand[resource] - 1);
      expect(total(r.players[1]!.hand)).toBe(2);
      expect(r.log.map((e) => [e.event, e.visibleTo])).toEqual([
        [{ kind: 'robberMoved', seat: 0, hex: HEX, victim: 1, auto: false }, 'all'],
        [{ kind: 'stole', seat: 0, victim: 1 }, 'all'],
        [{ kind: 'stoleDetail', seat: 0, victim: 1, resource }, [0, 1]],
      ]);
      expect(r.rng.steal).not.toEqual(s.rng.steal);
      expect(validateInvariants(r)).toEqual([]);
    }
  });

  it('only the thief and the victim see which card moved', () => {
    const r = ok(reduce(base(), rob(0, HEX, 2)));
    const detail = r.log.find((e) => e.event.kind === 'stoleDetail')!;
    expect(detail.visibleTo).toEqual([0, 2]);
  });

  it('returns to the phase it resumes: preRoll after a pre-roll knight', () => {
    const r = ok(reduce(base({ phase: { name: 'moveRobber', resume: 'preRoll' } }), rob(0, FAR, null)));
    expect(r.phase).toEqual({ name: 'preRoll' });
  });

  it('legal.moveRobber lists every target with its victims, for the active seat only', () => {
    const s = base();
    const l = legalActions(s, 0).moveRobber;
    expect(l.map((m) => m.hex)).toEqual(robberTargets(s));
    expect(l).toHaveLength(DEFAULT_TEST_BOARD.hexes.length - 1);
    expect(l.find((m) => m.hex === HEX)!.victims).toEqual([1, 2]);
    expect(l.find((m) => m.hex === FAR)!.victims).toEqual([]);
    expect(legalActions(s, 1).moveRobber).toEqual([]);
  });
});

describe('friendly robber and the R9 fallback (U5)', () => {
  const FRIENDLY = { friendlyRobber: { enabled: true, maxPublicVp: 2 } };
  const MOVE: Phase = { name: 'moveRobber', resume: 'main' };

  it('excludes hexes touching another seat with public VP ≤ maxPublicVp (invalid_robber_hex)', () => {
    const s = seven({ phase: MOVE, rules: FRIENDLY, pieces: [{ seat: 1, settlements: [N] }], hands: { 1: { ore: 1 } } });
    expect(victoryPoints(s, 1).public).toBe(1);
    const shielded = T.vertexHexes(N);
    expect(robberTargets(s).some((h) => shielded.includes(h))).toBe(false);
    expect(robberTargets(s)).toContain(FAR);
    expect(reduce(s, rob(0, HEX, 1))).toEqual({ ok: false, reason: 'invalid_robber_hex' });
    expect(reduce(s, rob(0, FAR, null)).ok).toBe(true);
  });

  it('never shields the mover, nor a seat above maxPublicVp', () => {
    const own = seven({ phase: MOVE, rules: FRIENDLY, pieces: [{ seat: 0, settlements: [N] }] });
    expect(robberTargets(own)).toContain(HEX);
    const big = seven({ phase: MOVE, rules: FRIENDLY, pieces: [{ seat: 1, cities: [N] }], hands: { 1: { ore: 1 } } });
    expect(victoryPoints(big, 1).public).toBe(2);
    expect(robberTargets(big)).not.toContain(HEX);
    const bigger = seven({ phase: MOVE, rules: FRIENDLY, pieces: [{ seat: 1, cities: [N, S] }], hands: { 1: { ore: 1 } } });
    expect(robberTargets(bigger)).toContain(HEX);
    expect(reduce(bigger, rob(0, HEX, 1)).ok).toBe(true);
  });

  it('lifts the exclusion when it would forbid every other hex', () => {
    // Settlements of seats 1 and 2 (1–2 VP each) touching every hex but the robber's.
    const chosen: VertexId[] = [];
    const covered = new Set<HexId>([DESERT]);
    for (const need of [3, 2, 1]) {
      for (const v of T.vertices) {
        if (chosen.some((c) => c === v || T.vertexNeighbours(c).includes(v))) continue;
        const fresh = T.vertexHexes(v).filter((h) => !covered.has(h));
        if (fresh.length < need) continue;
        chosen.push(v);
        fresh.forEach((h) => covered.add(h));
      }
    }
    expect(covered.size).toBe(19);
    expect(chosen.length).toBeLessThanOrEqual(10);
    const pieces: Pieces = [
      { seat: 1, settlements: chosen.filter((_, i) => i % 2 === 0) },
      { seat: 2, settlements: chosen.filter((_, i) => i % 2 === 1) },
    ];
    const vp = Math.max(...[1, 2].map((seat) => pieces.find((p) => p.seat === seat)!.settlements!.length));
    const s = seven({ phase: MOVE, rules: { vpTarget: 10, friendlyRobber: { enabled: true, maxPublicVp: vp } }, pieces });
    const all = DEFAULT_TEST_BOARD.hexes.map((h) => h.id).filter((h) => h !== DESERT);
    expect([...robberTargets(s)].sort()).toEqual([...all].sort());
    expect(legalActions(s, 0).moveRobber).toHaveLength(18);
    const target = robberTargets(s)[0]!;
    expect(reduce(s, rob(0, target, null)).ok).toBe(true);
    // One VP more for seat 1 than allowed un-shields its hexes, so the exclusion applies again.
    const tighter = seven({ phase: MOVE, rules: { vpTarget: 10, friendlyRobber: { enabled: true, maxPublicVp: vp - 1 } }, pieces });
    expect(robberTargets(tighter).length).toBeGreaterThan(0);
    expect(robberTargets(tighter).length).toBeLessThan(18);
  });
});

describe('robber properties (AC10, AC11)', () => {
  /** Pairwise non-adjacent vertices to place buildings on. */
  const SITES: VertexId[] = [];
  for (const v of T.vertices) if (!SITES.some((c) => T.vertexNeighbours(c).includes(v))) SITES.push(v);
  const HEXES = DEFAULT_TEST_BOARD.hexes.map((h) => h.id);

  const arbState = fc
    .record({
      owners: fc.array(fc.option(fc.constantFrom<Seat>(0, 1, 2, 3), { nil: undefined }), { minLength: SITES.length, maxLength: SITES.length }),
      hands: fc.array(fc.record({ brick: fc.nat({ max: 3 }), ore: fc.nat({ max: 3 }) }), { minLength: 4, maxLength: 4 }),
      robber: fc.constantFrom(...HEXES),
      active: fc.constantFrom<Seat>(0, 1, 2, 3),
      friendly: fc.boolean(),
      maxPublicVp: fc.integer({ min: 0, max: 6 }),
      resume: fc.constantFrom<'main' | 'preRoll'>('main', 'preRoll'),
    })
    .map(({ owners, hands, robber, active, friendly, maxPublicVp, resume }) => {
      const per = new Map<Seat, VertexId[]>();
      owners.forEach((o, i) => {
        if (o === undefined) return;
        const list = per.get(o) ?? [];
        if (list.length < 5) per.set(o, [...list, SITES[i]!]);
      });
      return buildState({
        playerCount: 4,
        phase: { name: 'moveRobber', resume },
        turn: { number: 6, active },
        robber,
        rules: { friendlyRobber: { enabled: friendly, maxPublicVp } },
        pieces: [...per].map(([seat, settlements]) => ({ seat, settlements })),
        hands: Object.fromEntries(hands.map((h, i) => [i, h])),
      });
    });

  it('a robber move is always available, and legal.moveRobber ⇔ reduce over every hex and victim', () => {
    fc.assert(
      fc.property(arbState, (s) => {
        const seat = s.turn.active;
        const legal = legalActions(s, seat).moveRobber;
        expect(legal.length).toBeGreaterThan(0);
        for (const hex of HEXES) {
          const entry = legal.find((m) => m.hex === hex);
          for (const victim of [null, 0, 1, 2, 3] as const) {
            const allowed = entry !== undefined && (victim === null ? entry.victims.length === 0 : entry.victims.includes(victim));
            const r = reduce(s, rob(seat, hex, victim));
            expect(r.ok).toBe(allowed);
            if (r.ok) {
              expect(r.state.robber).toBe(hex);
              expect(r.state.phase).toEqual({ name: (s.phase as { resume: string }).resume });
              expect(validateInvariants(r.state)).toEqual([]);
            }
          }
        }
        for (const other of [0, 1, 2, 3] as const) if (other !== seat) expect(legalActions(s, other).moveRobber).toEqual([]);
      }),
      { numRuns: 150 },
    );
  });
});
