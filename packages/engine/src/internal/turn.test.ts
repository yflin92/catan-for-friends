import { describe, expect, it } from 'vitest';
import { fixtureState } from '../__fixtures__/state';
import type { Seat } from '../ids';
import type { GameState, Phase, PhaseName, TradeOffer } from '../state';
import { beginTurn, checkVictory, onPhaseExit, robberTargets, setPhase } from './turn';

const ZERO = { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 };
const offer: TradeOffer = {
  id: 7,
  from: 1,
  give: { ...ZERO, brick: 1 },
  get: { ...ZERO, ore: 1 },
  responses: ['accepted', 'self', 'pending'],
};
const inMainWithOffer = (): GameState => ({ ...fixtureState(), phase: { name: 'main' }, trade: offer, nextTradeId: 8 });

const EXITS_FROM_MAIN: readonly Phase[] = [
  { name: 'moveRobber', resume: 'main' },
  { name: 'roadBuilding', remaining: 2, resume: 'main' },
  { name: 'preRoll' },
  { name: 'gameOver', winner: 1 },
];

describe('setPhase / onPhaseExit (design §6.2, R13)', () => {
  it.each(EXITS_FROM_MAIN.map((p) => [p.name, p] as const))('withdraws the open offer on main → %s', (to, next) => {
    const before = inMainWithOffer();
    const after = setPhase(before, next);
    expect(after.phase).toEqual(next);
    expect(after.trade).toBeNull();
    expect(after.logCounter).toBe(before.logCounter + 1);
    expect(after.log.at(-1)).toEqual({
      n: before.logCounter + 1,
      event: { kind: 'tradeResolved', tradeId: 7, outcome: 'withdrawn', partner: null, exitTo: to },
      visibleTo: 'all',
    });
  });

  it('does nothing extra when leaving main without an offer', () => {
    const before = { ...fixtureState(), phase: { name: 'main' } as Phase };
    const after = setPhase(before, { name: 'preRoll' });
    expect(after.log).toBe(before.log);
    expect(after.phase).toEqual({ name: 'preRoll' });
  });

  it('does not call the exit hook when the phase name is unchanged', () => {
    const before: GameState = { ...fixtureState(), phase: { name: 'discard', owed: [0, 4, 3], then: 'moveRobber' } };
    const after = setPhase(before, { name: 'discard', owed: [0, 0, 3], then: 'moveRobber' });
    expect(after.log).toBe(before.log);
    expect(after.phase).toEqual({ name: 'discard', owed: [0, 0, 3], then: 'moveRobber' });
    const stay = setPhase(inMainWithOffer(), { name: 'main' });
    expect(stay.trade).toEqual(offer);
  });

  it.each<PhaseName>(['setupSettlement', 'setupRoad', 'preRoll', 'discard', 'moveRobber', 'roadBuilding', 'gameOver'])(
    'onPhaseExit is the identity when leaving %s',
    (from) => {
      const s = inMainWithOffer();
      expect(onPhaseExit(s, from, 'main')).toBe(s);
    },
  );

  it('does not mutate its input', () => {
    const before = inMainWithOffer();
    const snapshot = JSON.stringify(before);
    setPhase(before, { name: 'preRoll' });
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe('beginTurn (design §6.2)', () => {
  it('starts the seat’s turn: next number, no dice, per-turn flags reset, preRoll', () => {
    const before: GameState = {
      ...inMainWithOffer(),
      turn: { number: 5, active: 1, dice: [3, 4], devPlayed: true },
    };
    const after = beginTurn(before, 2 as Seat);
    expect(after.turn).toEqual({ number: 6, active: 2, dice: null, devPlayed: false });
    expect(after.phase).toEqual({ name: 'preRoll' });
    expect(after.trade).toBeNull();
    expect(after.log.at(-1)?.event).toEqual({ kind: 'tradeResolved', tradeId: 7, outcome: 'withdrawn', partner: null, exitTo: 'preRoll' });
  });

  it('leaves a state below the target unchanged in checkVictory', () => {
    const s = fixtureState();
    expect(checkVictory(s)).toBe(s);
  });

  it('ends with checkVictory: an incoming seat already at the target wins before preRoll accepts anything (D3)', () => {
    const base = { ...fixtureState(), phase: { name: 'main' } as Phase };
    const atTarget: GameState = { ...base, config: { ...base.config, vpTarget: 1 }, pieces: { ...base.pieces, settlements: { ...base.pieces.settlements, 'v:0,0,N': 2 as Seat } } };
    const after = beginTurn(atTarget, 2 as Seat);
    expect(after.turn.active).toBe(2);
    expect(after.phase).toEqual({ name: 'gameOver', winner: 2 });
    expect(after.log.at(-1)?.event).toMatchObject({ kind: 'gameOver', winner: 2 });
  });
});

describe('robberTargets', () => {
  it('lists every board hex except the robber’s, in canonical hex index order', () => {
    const s = fixtureState();
    const board = {
      ...s.board,
      hexes: [
        { id: 'h:0,1', terrain: 'hills', token: 5 },
        { id: 'h:-1,0', terrain: 'forest', token: 9 },
        { id: 'h:1,-2', terrain: 'desert', token: null },
        { id: 'h:0,-2', terrain: 'fields', token: 4 },
        { id: 'h:1,0', terrain: 'pasture', token: 10 },
      ],
    } as GameState['board'];
    expect(robberTargets({ ...s, board, robber: 'h:1,-2' })).toEqual(['h:0,-2', 'h:-1,0', 'h:1,0', 'h:0,1']);
  });
});
