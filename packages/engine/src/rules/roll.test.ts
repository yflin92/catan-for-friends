import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { playSetup, setupStart } from '../__fixtures__/play';
import type { HexId, Seat, VertexId } from '../ids';
import { legalActions } from '../legal-actions';
import { reduce } from '../reduce';
import type { GameState, Phase, Resource } from '../state';
import { TERRAIN_YIELD } from '../state';
import { DEFAULT_TEST_BOARD, buildState, forceDice, validateInvariants } from '../testing';
import { STANDARD_TOPOLOGY as T } from '../topology';

const ROLL = { type: 'rollDice' } as const;
const roll = (by: Seat) => ({ by, action: ROLL });

/** Two faces summing to `total` (2..12). */
const facesFor = (total: number): [number, number] => (total <= 7 ? [1, total - 1] : [total - 6, 6]);

/** A producing hex whose corners N and S (never adjacent to each other) touch no other hex with the same token. */
function isolatedHex(): { id: HexId; token: number; resource: Resource; n: VertexId; s: VertexId } {
  for (const h of DEFAULT_TEST_BOARD.hexes) {
    if (h.terrain === 'desert' || h.token === null) continue;
    const [n, , , s] = T.hexCorners(h.id) as VertexId[];
    const sharesToken = (v: VertexId) =>
      T.vertexHexes(v).some((o) => o !== h.id && DEFAULT_TEST_BOARD.hexes.find((x) => x.id === o)?.token === h.token);
    if (!sharesToken(n!) && !sharesToken(s!)) return { id: h.id, token: h.token, resource: TERRAIN_YIELD[h.terrain], n: n!, s: s! };
  }
  throw new Error('no isolated hex on the test board');
}

const H = isolatedHex();
const preRoll = (spec: Parameters<typeof buildState>[0] = {}): GameState =>
  buildState({ playerCount: 3, phase: { name: 'preRoll' }, turn: { number: 2, active: 0 }, ...spec });

describe('rollDice (R7, AC7)', () => {
  it('draws two d6 from the dice stream, records them, logs diceRolled and moves to main', () => {
    const s = forceDice(preRoll(), [[2, 3]]);
    const r = reduce(s, roll(0));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.turn.dice).toEqual([2, 3]);
    expect(r.state.phase).toEqual({ name: 'main' });
    expect(r.events[0]).toMatchObject({ kind: 'diceRolled', seat: 0, dice: [2, 3], shortage: [], auto: false });
    expect(r.state.rng.board).toEqual(s.rng.board);
    expect(r.state.rng.devDeck).toEqual(s.rng.devDeck);
  });

  it('is reproducible from the dice seed and leaves the other streams alone', () => {
    const s = preRoll({ rng: { dice: 'seed-x' } });
    const a = reduce(s, roll(0));
    const b = reduce(s, roll(0));
    expect(a).toEqual(b);
    expect(a.ok && a.state.rng.steal).toEqual(s.rng.steal);
  });

  it('a 7 pays nothing and starts the robber move (resume main)', () => {
    const s = forceDice(preRoll({ pieces: [{ seat: 0, settlements: [H.n] }] }), [[3, 4]]);
    const r = reduce(s, roll(0));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.phase).toEqual({ name: 'moveRobber', resume: 'main' });
    expect(r.state.players).toEqual(s.players);
    expect(r.state.bank).toEqual(s.bank);
    expect(r.events[0]).toMatchObject({ kind: 'diceRolled', dice: [3, 4], shortage: [] });
  });

  it('rejects a non-active seat, and rolling outside preRoll', () => {
    expect(reduce(preRoll(), roll(1))).toEqual({ ok: false, reason: 'not_your_turn' });
    expect(reduce({ ...preRoll(), phase: { name: 'main' } }, roll(0))).toEqual({ ok: false, reason: 'wrong_phase' });
  });
});

describe('production (R8, AC7)', () => {
  it('pays 1 per settlement and 2 per city on the rolled hex', () => {
    const s = forceDice(preRoll({ pieces: [{ seat: 0, settlements: [H.n] }, { seat: 1, cities: [H.s] }] }), [facesFor(H.token)]);
    const r = reduce(s, roll(0));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.players[0]!.hand[H.resource]).toBe(1);
    expect(r.state.players[1]!.hand[H.resource]).toBe(2);
    expect(r.state.bank[H.resource]).toBe(s.bank[H.resource] - 3);
    const event = r.events[0]!;
    expect(event.kind === 'diceRolled' && event.gains[0]![H.resource]).toBe(1);
    expect(event.kind === 'diceRolled' && event.gains[1]![H.resource]).toBe(2);
  });

  it('pays nothing from the hex under the robber', () => {
    const s = forceDice(preRoll({ robber: H.id, pieces: [{ seat: 0, settlements: [H.n] }, { seat: 1, cities: [H.s] }] }), [facesFor(H.token)]);
    const r = reduce(s, roll(0));
    expect(r.ok && r.state.players[0]!.hand[H.resource]).toBe(0);
    expect(r.ok && r.state.players[1]!.hand[H.resource]).toBe(0);
    expect(r.ok && r.state.bank).toEqual(s.bank);
  });

  it('shortage with 2+ entitled seats: nobody receives that resource', () => {
    // Seat 2 holds 18 of the resource, so the bank has 1; seats 0 and 1 are owed 1 and 2.
    const s = forceDice(
      preRoll({ pieces: [{ seat: 0, settlements: [H.n] }, { seat: 1, cities: [H.s] }], hands: { 2: { [H.resource]: 18 } } }),
      [facesFor(H.token)],
    );
    expect(s.bank[H.resource]).toBe(1);
    const r = reduce(s, roll(0));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.players[0]!.hand[H.resource]).toBe(0);
    expect(r.state.players[1]!.hand[H.resource]).toBe(0);
    expect(r.state.bank[H.resource]).toBe(1);
    expect(r.events[0]).toMatchObject({ kind: 'diceRolled', shortage: [H.resource] });
  });

  it('shortage with exactly one entitled seat: it receives what the bank has left', () => {
    const s = forceDice(
      preRoll({ pieces: [{ seat: 1, cities: [H.s] }], hands: { 2: { [H.resource]: 18 } } }),
      [facesFor(H.token)],
    );
    const r = reduce(s, roll(0));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.players[1]!.hand[H.resource]).toBe(1);
    expect(r.state.bank[H.resource]).toBe(0);
    expect(r.events[0]).toMatchObject({ kind: 'diceRolled', shortage: [H.resource] });
  });

  it('no shortage when the bank holds exactly what is owed', () => {
    const s = forceDice(
      preRoll({ pieces: [{ seat: 0, settlements: [H.n] }, { seat: 1, cities: [H.s] }], hands: { 2: { [H.resource]: 16 } } }),
      [facesFor(H.token)],
    );
    const r = reduce(s, roll(0));
    expect(r.ok && r.state.bank[H.resource]).toBe(0);
    expect(r.ok && r.events[0]).toMatchObject({ shortage: [] });
  });
});

describe('roll properties', () => {
  const arbPicks = fc.array(fc.nat(), { minLength: 8, maxLength: 8 });
  const PHASES: readonly Phase[] = [
    { name: 'setupSettlement', round: 1 }, { name: 'preRoll' }, { name: 'main' },
    { name: 'moveRobber', resume: 'main' }, { name: 'gameOver', winner: 0 },
  ];

  it('resources stay at 19 per type across random rolls after setup (invariants)', () => {
    fc.assert(
      fc.property(fc.constantFrom<3 | 4>(3, 4), arbPicks, fc.array(fc.tuple(fc.integer({ min: 1, max: 6 }), fc.integer({ min: 1, max: 6 })), { minLength: 1, maxLength: 10 }), (n, picks, dice) => {
        let k = 0;
        let s = playSetup(setupStart(n), (m) => picks[k++ % picks.length]! % m).states.at(-1)!;
        for (const d of dice) {
          if (d[0] + d[1] === 7) continue;
          s = forceDice({ ...s, phase: { name: 'preRoll' } }, [d]);
          const r = reduce(s, roll(s.turn.active));
          expect(r.ok).toBe(true);
          if (!r.ok) return;
          s = r.state;
          expect(validateInvariants(s)).toEqual([]);
        }
      }),
      { numRuns: 40 },
    );
  });

  it('legal.rollDice ⇔ reduce accepts rollDice, for every phase and seat', () => {
    fc.assert(
      fc.property(fc.constantFrom(...PHASES), fc.constantFrom<Seat>(0, 1, 2), fc.constantFrom<Seat>(0, 1, 2), (phase, active, seat) => {
        const s = buildState({ playerCount: 3, phase, turn: { number: phase.name === 'setupSettlement' ? 0 : 2, active } });
        expect(legalActions(s, seat).rollDice).toBe(reduce(s, roll(seat)).ok);
      }),
      { numRuns: 200 },
    );
  });
});
