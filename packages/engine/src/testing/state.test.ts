import { describe, expect, it } from 'vitest';
import { deserializeState, serializeState, stateHash } from '../hash';
import { drawDie, drawInt, seedStream } from '../rng';
import type { GameState } from '../state';
import { DEFAULT_TEST_BOARD } from './board';
import { validateInvariants } from './invariants';
import { BUILD_SEED, buildState } from './state';

describe('buildState defaults (design §3.10)', () => {
  const s = buildState();

  it('is a consistent 4-player main-phase state on DEFAULT_TEST_BOARD', () => {
    expect(validateInvariants(s)).toEqual([]);
    expect(s.playerCount).toBe(4);
    expect(s.players).toHaveLength(4);
    expect(s.board).toBe(DEFAULT_TEST_BOARD);
    expect(s.robber).toBe('h:0,0');
    expect(s.phase).toEqual({ name: 'main' });
    expect(s.turn).toEqual({ number: 1, active: 0, dice: null, devPlayed: false });
    expect(s.trade).toBeNull();
    expect(s.nextTradeId).toBe(1);
    expect(s.awards).toEqual({ longestRoad: null, largestArmy: null });
    expect(s.log).toEqual([]);
    expect(s.logCounter).toBe(0);
  });

  it('has a full bank, full supply and the whole 25-card deck in the default order (draws VP first)', () => {
    expect(s.bank).toEqual({ brick: 19, lumber: 19, wool: 19, grain: 19, ore: 19 });
    for (const p of s.players) expect(p.supply).toEqual({ settlements: 5, cities: 4, roads: 15 });
    expect(s.devDeck).toHaveLength(25);
    expect(s.devDeck.at(-1)).toBe('victoryPoint');
    expect(s.devDeck.filter((k) => k === 'knight')).toHaveLength(14);
  });

  it('seeds every stream from BUILD_SEED', () => {
    expect(s.rng.dice).toEqual(seedStream(BUILD_SEED, 'dice'));
    expect(s.rng.board).toEqual(seedStream(BUILD_SEED, 'board'));
  });

  it('is deep-frozen', () => {
    expect(Object.isFrozen(s)).toBe(true);
    expect(Object.isFrozen(s.players[0]!.hand)).toBe(true);
    expect(Object.isFrozen(s.pieces.roads)).toBe(true);
  });
});

describe('buildState from a spec', () => {
  it('derives supply from pieces and the bank from hands', () => {
    const s = buildState({
      playerCount: 3,
      pieces: [{ seat: 1, settlements: ['v:0,0,N'], cities: ['v:0,1,S'], roads: ['e:0,0,NE', 'e:0,0,NW'] }],
      hands: { 0: { brick: 3 }, 2: { brick: 1, ore: 4 } },
    });
    expect(s.players).toHaveLength(3);
    expect(s.pieces.settlements).toEqual({ 'v:0,0,N': 1 });
    expect(s.pieces.cities).toEqual({ 'v:0,1,S': 1 });
    expect(s.players[1]!.supply).toEqual({ settlements: 4, cities: 3, roads: 13 });
    expect(s.players[0]!.hand).toEqual({ brick: 3, lumber: 0, wool: 0, grain: 0, ore: 0 });
    expect(s.bank).toEqual({ brick: 15, lumber: 19, wool: 19, grain: 19, ore: 15 });
  });

  it('removes held and played dev cards from the default deck and derives Largest Army', () => {
    const s = buildState({
      devCards: { 0: [{ kind: 'victoryPoint', boughtOnTurn: 0 }, { kind: 'knight', boughtOnTurn: 1 }] },
      playedDev: { 2: { knight: 3, monopoly: 1 } },
    });
    expect(s.devDeck).toHaveLength(25 - 2 - 4);
    expect(s.devDeck.filter((k) => k === 'knight')).toHaveLength(10);
    expect(s.devDeck.filter((k) => k === 'victoryPoint')).toHaveLength(4);
    expect(s.awards.largestArmy).toBe(2);
    expect(buildState({ playedDev: { 0: { knight: 3 }, 1: { knight: 3 } } }).awards.largestArmy).toBeNull();
    expect(buildState({ playedDev: { 0: { knight: 2 } } }).awards.largestArmy).toBeNull();
  });

  it('takes rules, robber, turn, phase, trade, explicit bank and deck as given', () => {
    const s = buildState({
      rules: { vpTarget: 12 },
      robber: 'h:1,-1',
      turn: { active: 2, number: 7, devPlayed: true },
      phase: { name: 'preRoll' },
      hands: { 0: { wool: 1 } },
      bank: { brick: 19, lumber: 19, wool: 18, grain: 19, ore: 19 },
      devDeck: ['knight'],
      allowInvariantViolations: true,
    });
    expect(s.config.vpTarget).toBe(12);
    expect(s.config.discardLimit).toBe(7);
    expect(s.robber).toBe('h:1,-1');
    expect(s.turn).toEqual({ number: 7, active: 2, dice: null, devPlayed: true });
    expect(s.phase).toEqual({ name: 'preRoll' });
    expect(s.bank.wool).toBe(18);
    expect(s.devDeck).toEqual(['knight']);
    expect(validateInvariants(s).map((i) => i.code)).toEqual(['dev_card_total', 'dev_card_total', 'dev_card_total', 'dev_card_total', 'dev_card_total']);
  });

  it('uses turn number 0 in setup phases', () => {
    expect(buildState({ phase: { name: 'setupSettlement', round: 1 } }).turn.number).toBe(0);
    expect(buildState({ phase: { name: 'setupRoad', round: 2, from: 'v:0,0,N' } }).turn.number).toBe(0);
  });

  it('sets nextTradeId past an open offer', () => {
    const s = buildState({
      hands: { 0: { brick: 1 } },
      trade: { id: 4, from: 0, give: { brick: 1, lumber: 0, wool: 0, grain: 0, ore: 0 }, get: { brick: 0, lumber: 0, wool: 1, grain: 0, ore: 0 }, responses: ['self', 'pending', 'pending', 'pending'] },
    });
    expect(s.nextTradeId).toBe(5);
  });

  it('seeds and scripts RNG streams per spec', () => {
    const s = buildState({ rng: { dice: { scripted: [6, 1] }, steal: 'abc', absence: { scripted: [], seed: 'x' } } });
    expect(s.rng.steal).toEqual(seedStream('abc', 'steal'));
    expect(s.rng.absence).toEqual(seedStream('x', 'absence'));
    const [a, d1] = drawDie(s.rng.dice);
    const [b, d2] = drawDie(d1);
    const [c] = drawDie(d2);
    expect([a, b]).toEqual([6, 1]);
    expect(c).toBe(drawDie(seedStream(BUILD_SEED, 'dice'))[0]);
    expect(drawInt(buildState({ rng: { steal: { scripted: [2] } } }).rng.steal, 3)[0]).toBe(2);
  });

  it('round-trips through serializeState / deserializeState with a stable hash', () => {
    const s = buildState({ pieces: [{ seat: 0, settlements: ['v:0,0,N'], roads: ['e:0,0,NE'] }], hands: { 1: { grain: 2 } } });
    const back = deserializeState(serializeState(s));
    expect(back.ok).toBe(true);
    const restored = (back as { ok: true; state: GameState }).state;
    expect(restored).toEqual(s);
    expect(stateHash(restored)).toBe(stateHash(s));
    expect(stateHash(buildState({ pieces: [{ seat: 0, settlements: ['v:0,0,N'], roads: ['e:0,0,NE'] }], hands: { 1: { grain: 2 } } }))).toBe(stateHash(s));
  });
});

describe('buildState rejections', () => {
  it('throws a clear test-only error for a {seed} board until createGame lands', () => {
    expect(() => buildState({ board: { seed: 'abc' } })).toThrow(/createGame/);
  });

  it('throws on invariant violations unless allowInvariantViolations', () => {
    expect(() => buildState({ hands: { 0: { brick: 20 } } })).toThrow(/negative_count: bank brick = -1/);
    expect(() => buildState({ pieces: [{ seat: 0, settlements: ['v:0,0,N', 'v:1,-1,S'] }] })).toThrow(/distance_rule/);
    const s = buildState({ hands: { 0: { brick: 20 } }, allowInvariantViolations: true });
    expect(validateInvariants(s).map((i) => i.code)).toEqual(['negative_count']);
  });
});
