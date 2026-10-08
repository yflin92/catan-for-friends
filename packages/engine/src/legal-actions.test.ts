import { describe, expect, it } from 'vitest';
import { fixtureState } from './__fixtures__/state';
import { eligibleSeats } from './eligible';
import { createLegalActions, legalActions } from './legal-actions';
import type { GameState, Phase } from './state';

const withPhase = (phase: Phase): GameState => ({ ...fixtureState(), phase });
const DISCARD: Phase = { name: 'discard', owed: [0, 4, 3], then: 'moveRobber' };

describe('eligibleSeats', () => {
  it('is the active seat outside discard and gameOver', () => {
    expect(eligibleSeats(withPhase({ name: 'main' }))).toEqual([1]);
    expect(eligibleSeats(withPhase({ name: 'setupSettlement', round: 2 }))).toEqual([1]);
  });
  it('is every seat that still owes cards in discard, ascending', () => {
    expect(eligibleSeats(withPhase(DISCARD))).toEqual([1, 2]);
  });
  it('is empty in gameOver', () => {
    expect(eligibleSeats(withPhase({ name: 'gameOver', winner: 0 }))).toEqual([]);
  });
});

describe('legalActions aggregator', () => {
  it('returns the empty descriptor for a seat no slice serves (non-active seats in moveRobber)', () => {
    const s = withPhase({ name: 'moveRobber', resume: 'main' });
    for (const seat of [0, 2] as const) {
      expect(legalActions(s, seat)).toEqual({
        seat, phase: 'moveRobber', placeSettlement: [], placeRoad: [], buildCity: [], rollDice: false, endTurn: false,
        buyDevCard: false, playKnight: false, playRoadBuilding: false, playYearOfPlenty: [], playMonopoly: false,
        discard: null, moveRobber: [], maritime: {}, bankStock: s.bank, proposeTrade: false, respondTrade: null,
        confirmTrade: null, cancelTrade: null,
      });
    }
  });

  const slices = [
    () => ({ endTurn: true, placeRoad: ['e:0,-2,NE' as const] }),
    () => ({ respondTrade: { tradeId: 3, canAccept: true }, endTurn: false, buyDevCard: true }),
  ];
  const aggregate = createLegalActions(slices);

  it('merges slices in order for an eligible seat', () => {
    const l = aggregate(fixtureState(), 1);
    expect(l.endTurn).toBe(false);
    expect(l.buyDevCard).toBe(true);
    expect(l.placeRoad).toEqual(['e:0,-2,NE']);
  });

  it('never gives the active seat a respondTrade', () => {
    expect(aggregate(fixtureState(), 1).respondTrade).toBeNull();
  });

  it('gives a non-active seat only respondTrade (AC11)', () => {
    const l = aggregate(fixtureState(), 0);
    expect(l.respondTrade).toEqual({ tradeId: 3, canAccept: true });
    expect(l.endTurn).toBe(false);
    expect(l.buyDevCard).toBe(false);
    expect(l.placeRoad).toEqual([]);
  });

  it('keeps seat, phase and bankStock from the state whatever the slices return', () => {
    const rogue = createLegalActions([() => ({ seat: 2, phase: 'gameOver', bankStock: { brick: 0 } }) as never]);
    const l = rogue(fixtureState(), 1);
    expect([l.seat, l.phase, l.bankStock]).toEqual([1, 'main', fixtureState().bank]);
  });

  it('returns the empty descriptor in gameOver', () => {
    const l = aggregate(withPhase({ name: 'gameOver', winner: 1 }), 1);
    expect([l.endTurn, l.respondTrade, l.placeRoad]).toEqual([false, null, []]);
  });

  it('serves owing seats in discard and gives others nothing but respondTrade', () => {
    const s = withPhase(DISCARD);
    expect(aggregate(s, 2).buyDevCard).toBe(true);
    expect(aggregate(s, 0).buyDevCard).toBe(false);
  });
});
