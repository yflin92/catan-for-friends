import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { eligibleSeats } from '../eligible';
import type { Action, ActionType, Command } from '../events';
import type { Seat } from '../ids';
import { legalActions } from '../legal-actions';
import { reduce } from '../reduce';
import type { GameState, Phase, PhaseName, TradeOffer } from '../state';
import { PHASE_ACTIONS } from './phases';
import { boughtThisTurn } from './turn-flags';
import { buildState, enumerateLegalActions } from '../testing';

const ZERO = { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 };

/** A legal-shaped state (DEFAULT_TEST_BOARD) with the given phase, active seat and player count, on turn 3. */
function stateWith(phase: Phase, active: Seat = 1, playerCount: 3 | 4 = 3): GameState {
  const sized: Phase = phase.name === 'discard' ? { ...phase, owed: phase.owed.slice(0, playerCount) } : phase;
  return buildState({ playerCount, phase: sized, turn: { number: 3, active } });
}

const END_TURN: Action = { type: 'endTurn' };
const DISCARD: Phase = { name: 'discard', owed: [0, 4, 3, 0], then: 'moveRobber' };
const PHASES: readonly Phase[] = [
  { name: 'setupSettlement', round: 1 },
  { name: 'setupRoad', round: 2, from: 'v:0,-2,N' },
  { name: 'preRoll' },
  DISCARD,
  { name: 'moveRobber', resume: 'main' },
  { name: 'main' },
  { name: 'roadBuilding', remaining: 1, resume: 'main' },
  { name: 'gameOver', winner: 0 },
];

describe('endTurn (AC11)', () => {
  it('passes the turn to the next seat: number + 1, preRoll, no dice, devPlayed reset', () => {
    const before: GameState = { ...stateWith({ name: 'main' }, 1), turn: { number: 3, active: 1, dice: [2, 5], devPlayed: true } };
    const r = reduce(before, { by: 1, action: END_TURN });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.turn).toEqual({ number: 4, active: 2, dice: null, devPlayed: false });
    expect(r.state.phase).toEqual({ name: 'preRoll' });
    expect(r.events).toEqual([{ kind: 'turnEnded', seat: 1, turn: 3, reason: 'endTurn' }]);
  });

  it.each<[3 | 4, Seat, Seat]>([
    [3, 0, 1], [3, 1, 2], [3, 2, 0],
    [4, 0, 1], [4, 2, 3], [4, 3, 0],
  ])('cycles seats in order (%i players: %i → %i)', (n, from, to) => {
    const r = reduce(stateWith({ name: 'main' }, from, n), { by: from, action: END_TURN });
    expect(r.ok && r.state.turn.active).toBe(to);
  });

  it('withdraws an open offer as the turn passes, after logging turnEnded', () => {
    const offer: TradeOffer = { id: 4, from: 1, give: { ...ZERO, ore: 1 }, get: { ...ZERO, wool: 1 }, responses: ['accepted', 'self', 'pending'] };
    const r = reduce({ ...stateWith({ name: 'main' }), trade: offer }, { by: 1, action: END_TURN });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.trade).toBeNull();
    expect(r.events.map((e) => e.kind)).toEqual(['turnEnded', 'tradeResolved']);
    expect(r.events[1]).toEqual({ kind: 'tradeResolved', tradeId: 4, outcome: 'withdrawn', partner: null, exitTo: 'preRoll' });
  });

  it('rejects a non-active seat with not_your_turn', () => {
    expect(reduce(stateWith({ name: 'main' }, 1), { by: 0, action: END_TURN })).toEqual({ ok: false, reason: 'not_your_turn' });
  });

  it.each<PhaseName>(['setupSettlement', 'setupRoad', 'preRoll', 'moveRobber', 'roadBuilding'])(
    'rejects ending the turn in %s with wrong_phase',
    (name) => {
      const phase = PHASES.find((p) => p.name === name)!;
      expect(reduce(stateWith(phase, 1), { by: 1, action: END_TURN })).toEqual({ ok: false, reason: 'wrong_phase' });
    },
  );

  it('rejects a second roll, and building or trading before the roll, with wrong_phase', () => {
    expect(reduce(stateWith({ name: 'main' }), { by: 1, action: { type: 'rollDice' } })).toEqual({ ok: false, reason: 'wrong_phase' });
    const preRoll = stateWith({ name: 'preRoll' });
    const early: Action[] = [
      { type: 'buildCity', vertex: 'v:0,-2,N' },
      { type: 'placeRoad', edge: 'e:0,-2,NE' },
      { type: 'buyDevCard' },
      { type: 'maritimeTrade', give: 'brick', receive: 'ore', count: 1 },
      { type: 'proposeTrade', give: { ...ZERO, ore: 1 }, get: { ...ZERO, wool: 1 } },
      END_TURN,
    ];
    for (const action of early) expect(reduce(preRoll, { by: 1, action })).toEqual({ ok: false, reason: 'wrong_phase' });
  });
});

describe('per-turn flags (AC11)', () => {
  it('a card bought this turn stops counting as "bought this turn" once the turn passes', () => {
    const s = { ...stateWith({ name: 'main' }), turn: { number: 6, active: 1 as Seat, dice: [3, 3] as const, devPlayed: false } };
    const card = { kind: 'knight' as const, boughtOnTurn: 6 };
    expect(boughtThisTurn(s, card)).toBe(true);
    const r = reduce(s, { by: 1, action: END_TURN });
    expect(r.ok && boughtThisTurn(r.state, card)).toBe(false);
  });

  it('devPlayed is cleared for the next seat', () => {
    const s = { ...stateWith({ name: 'main' }), turn: { number: 2, active: 1 as Seat, dice: [1, 1] as const, devPlayed: true } };
    const r = reduce(s, { by: 1, action: END_TURN });
    expect(r.ok && r.state.turn.devPlayed).toBe(false);
  });
});

describe('eligibleSeats (design §6.1)', () => {
  it.each(PHASES.map((p) => [p.name, p] as const))('matches the §6.1 table in %s', (_name, phase) => {
    const expected = phase.name === 'gameOver' ? [] : phase.name === 'discard' ? [1, 2] : [1];
    expect(eligibleSeats(stateWith(phase, 1, 4))).toEqual(expected);
  });
});

describe('turn machine properties', () => {
  const arbState = fc
    .record({
      phase: fc.constantFrom(...PHASES),
      active: fc.constantFrom<Seat>(0, 1, 2, 3),
      playerCount: fc.constantFrom<3 | 4>(3, 4),
    })
    .filter(({ active, playerCount }) => active < playerCount)
    .map(({ phase, active, playerCount }) => stateWith(phase, active, playerCount));
  const arbSeat = fc.constantFrom<Seat>(0, 1, 2, 3);

  const EXAMPLES: Record<ActionType, Action> = {
    placeSettlement: { type: 'placeSettlement', vertex: 'v:0,-2,N' },
    placeRoad: { type: 'placeRoad', edge: 'e:0,-2,NE' },
    buildCity: { type: 'buildCity', vertex: 'v:0,-2,N' },
    rollDice: { type: 'rollDice' },
    discard: { type: 'discard', cards: { ...ZERO, brick: 1 } },
    moveRobber: { type: 'moveRobber', hex: 'h:0,-2', victim: null },
    buyDevCard: { type: 'buyDevCard' },
    playKnight: { type: 'playKnight' },
    playRoadBuilding: { type: 'playRoadBuilding' },
    playYearOfPlenty: { type: 'playYearOfPlenty', take: ['ore', 'ore'] },
    playMonopoly: { type: 'playMonopoly', resource: 'wool' },
    maritimeTrade: { type: 'maritimeTrade', give: 'brick', receive: 'ore', count: 1 },
    proposeTrade: { type: 'proposeTrade', give: { ...ZERO, ore: 1 }, get: { ...ZERO, wool: 1 } },
    respondTrade: { type: 'respondTrade', tradeId: 1, accept: false },
    confirmTrade: { type: 'confirmTrade', tradeId: 1, partner: 0 },
    cancelTrade: { type: 'cancelTrade', tradeId: 1 },
    endTurn: END_TURN,
  };

  it('only eligible seats ever act (respondTrade aside, which no state here can accept)', () => {
    fc.assert(
      fc.property(arbState, arbSeat, fc.constantFrom(...(Object.keys(EXAMPLES) as ActionType[])), (s, seat, type) => {
        fc.pre(seat < s.playerCount);
        const r = reduce(s, { by: seat, action: EXAMPLES[type] } as Command);
        if (r.ok) {
          expect(eligibleSeats(s)).toContain(seat);
          expect(PHASE_ACTIONS[s.phase.name]).toContain(type);
        }
      }),
      { numRuns: 3000 },
    );
  });

  it('legal.endTurn ⇔ reduce accepts endTurn, for every seat', () => {
    fc.assert(
      fc.property(arbState, arbSeat, (s, seat) => {
        fc.pre(seat < s.playerCount);
        const accepted = reduce(s, { by: seat, action: END_TURN }).ok;
        expect(legalActions(s, seat).endTurn).toBe(accepted);
      }),
      { numRuns: 2000 },
    );
  });

  it('a non-active seat’s descriptor is empty apart from respondTrade', () => {
    fc.assert(
      fc.property(arbState, arbSeat, (s, seat) => {
        fc.pre(seat < s.playerCount && seat !== s.turn.active && !eligibleSeats(s).includes(seat));
        const l = legalActions(s, seat);
        expect([l.endTurn, l.rollDice, l.buyDevCard, l.proposeTrade, l.discard, l.cancelTrade]).toEqual([false, false, false, false, null, null]);
        expect([l.placeSettlement, l.placeRoad, l.buildCity, l.moveRobber]).toEqual([[], [], [], []]);
      }),
      { numRuns: 1000 },
    );
  });

  it('every enumerated legal action is accepted by reduce (soundness)', () => {
    fc.assert(
      fc.property(arbState, arbSeat, (s, seat) => {
        fc.pre(seat < s.playerCount);
        for (const action of enumerateLegalActions(s, seat)) {
          expect(reduce(s, { by: seat, action }).ok).toBe(true);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('endTurn always lands the next seat in preRoll on the next turn number', () => {
    fc.assert(
      fc.property(arbState, (s) => {
        fc.pre(s.phase.name === 'main');
        const r = reduce(s, { by: s.turn.active, action: END_TURN });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.state.turn.active).toBe((s.turn.active + 1) % s.playerCount);
        expect(r.state.turn.number).toBe(s.turn.number + 1);
        expect(r.state.phase.name).toBe('preRoll');
      }),
      { numRuns: 300 },
    );
  });
});
