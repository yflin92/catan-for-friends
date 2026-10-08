import { describe, expect, it } from 'vitest';
import type { GameInit } from './api';
import { generateBoard } from './board';
import { DEFAULT_GAME_CONFIG } from './config';
import { DEV_DECK, createGame } from './create-game';
import { stateHash } from './hash';
import { initRng, seedStream, shuffle } from './rng';
import type { GameState } from './state';
import { buildState, validateInvariants } from './testing';

const init = (x: Partial<GameInit> = {}): GameInit => ({ config: DEFAULT_GAME_CONFIG.rules, playerCount: 4, seed: 'golden-board-1', ...x });
const created = (x: Partial<GameInit> = {}): GameState => {
  const r = createGame(init(x));
  if (!r.ok) throw new Error('createGame rejected a valid init');
  return r.state;
};

describe('createGame: the initial state (design §3.4)', () => {
  const s = created();

  it('starts in setupSettlement round 1 for seat 0 with full bank and supplies', () => {
    expect(validateInvariants(s)).toEqual([]);
    expect(s.phase).toEqual({ name: 'setupSettlement', round: 1 });
    expect(s.turn).toEqual({ number: 0, active: 0, dice: null, devPlayed: false });
    expect(s.bank).toEqual({ brick: 19, lumber: 19, wool: 19, grain: 19, ore: 19 });
    expect(s.players).toHaveLength(4);
    for (const p of s.players) {
      expect(p.supply).toEqual({ settlements: 5, cities: 4, roads: 15 });
      expect(p.hand).toEqual({ brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 });
      expect(p.devCards).toEqual([]);
    }
    expect(s.pieces).toEqual({ settlements: {}, cities: {}, roads: {} });
    expect(s.trade).toBeNull();
    expect(s.nextTradeId).toBe(1);
    expect(s.awards).toEqual({ longestRoad: null, largestArmy: null });
    expect(s.log).toEqual([]);
    expect(s.logCounter).toBe(0);
    expect(s.config).toEqual(DEFAULT_GAME_CONFIG.rules);
  });

  it('puts the robber on the desert', () => {
    expect(s.board.hexes.find((h) => h.id === s.robber)?.terrain).toBe('desert');
  });

  it('shuffles the 25-card deck (14/5/2/2/2) once from the devDeck stream', () => {
    expect([...s.devDeck].sort()).toEqual([...DEV_DECK].sort());
    expect(s.devDeck).toEqual(shuffle(initRng('golden-board-1').devDeck, DEV_DECK)[0]);
  });

  it('draws only from the board and devDeck streams', () => {
    const fresh = initRng('golden-board-1');
    expect(s.rng.dice).toEqual(fresh.dice);
    expect(s.rng.steal).toEqual(fresh.steal);
    expect(s.rng.absence).toEqual(fresh.absence);
    expect(s.rng.board).toEqual(generateBoard(fresh.board, DEFAULT_GAME_CONFIG.rules)[1]);
  });

  it('creates 3-player games', () => {
    const three = created({ playerCount: 3 });
    expect(three.players).toHaveLength(3);
    expect(validateInvariants(three)).toEqual([]);
  });

  it('honours noAdjacentRedNumbers = false', () => {
    const rules = { ...DEFAULT_GAME_CONFIG.rules, boardConstraints: { noAdjacentRedNumbers: false } };
    expect(created({ config: rules }).board).toEqual(generateBoard(seedStream('golden-board-1', 'board'), rules)[0]);
  });
});

describe('createGame: streams and determinism (TH2, AC4)', () => {
  it('the same init gives an identical state', () => {
    expect(created()).toEqual(created());
  });

  it('the board depends only on the board stream seed', () => {
    const base = created();
    const otherStreams = created({ streamSeeds: { dice: 'x', devDeck: 'y', steal: 'z', absence: 'w' } });
    expect(otherStreams.board).toEqual(base.board);
    expect(otherStreams.devDeck).not.toEqual(base.devDeck);
    const boardOverride = created({ seed: 'something-else', streamSeeds: { board: 'golden-board-1' } });
    expect(boardOverride.board).toEqual(base.board);
  });

  it('buildState({board: {seed}}) gives the board createGame generates for that board seed', () => {
    expect(buildState({ board: { seed: 'golden-board-1' } }).board).toEqual(created().board);
  });

  it('never retries: every seed succeeds on the first attempt with a valid state', () => {
    for (let i = 0; i < 300; i++) {
      const r = createGame(init({ seed: `s${i}`, playerCount: i % 2 === 0 ? 4 : 3 }));
      expect(r.ok).toBe(true);
      if (r.ok) expect(validateInvariants(r.state)).toEqual([]);
    }
  });
});

describe('createGame: golden snapshot (pins the normative draw order, design §3.5)', () => {
  const s = created();

  it('board for seed "golden-board-1"', () => {
    expect(s.board.hexes.map((h) => [h.id, h.terrain, h.token])).toEqual([
      ['h:0,-2', 'fields', 5], ['h:1,-2', 'fields', 8], ['h:2,-2', 'mountains', 9],
      ['h:-1,-1', 'forest', 11], ['h:0,-1', 'desert', null], ['h:1,-1', 'fields', 3], ['h:2,-1', 'forest', 9],
      ['h:-2,0', 'forest', 4], ['h:-1,0', 'mountains', 6], ['h:0,0', 'forest', 4], ['h:1,0', 'mountains', 6], ['h:2,0', 'pasture', 5],
      ['h:-2,1', 'pasture', 10], ['h:-1,1', 'pasture', 3], ['h:0,1', 'fields', 10], ['h:1,1', 'hills', 2],
      ['h:-2,2', 'hills', 12], ['h:-1,2', 'hills', 11], ['h:0,2', 'pasture', 8],
    ]);
    expect(s.board.harbors.map((h) => h.kind)).toEqual(['generic', 'generic', 'grain', 'generic', 'lumber', 'wool', 'generic', 'brick', 'ore']);
    expect(s.robber).toBe('h:0,-1');
  });

  it('dev deck for seed "golden-board-1"', () => {
    expect(s.devDeck.join(',')).toBe(
      'knight,knight,knight,victoryPoint,knight,yearOfPlenty,knight,roadBuilding,knight,roadBuilding,victoryPoint,monopoly,' +
        'knight,monopoly,knight,knight,yearOfPlenty,knight,victoryPoint,knight,victoryPoint,knight,knight,knight,victoryPoint',
    );
  });

  it('stateHash of the initial state', () => {
    expect(stateHash(s)).toBe(GOLDEN_INITIAL_HASH);
  });
});

describe('createGame: malformed init → malformed_action', () => {
  const bad = (x: unknown) => expect(createGame(x as GameInit)).toEqual({ ok: false, reason: 'malformed_action' });

  it.each([
    ['playerCount 2', { playerCount: 2 }],
    ['playerCount 5', { playerCount: 5 }],
    ['empty seed', { seed: '' }],
    ['non-string seed', { seed: 42 }],
    ['out-of-range rules', { config: { ...DEFAULT_GAME_CONFIG.rules, vpTarget: 3 } }],
    ['rules with an unknown key', { config: { ...DEFAULT_GAME_CONFIG.rules, extra: 1 } }],
    ['unknown stream in streamSeeds', { streamSeeds: { weather: 'x' } }],
    ['non-string stream seed', { streamSeeds: { dice: 1 } }],
    ['unknown init key', { extra: true }],
  ])('%s', (_, x) => bad({ ...init(), ...x }));

  it('null and non-objects', () => {
    bad(null);
    bad('init');
    bad([]);
  });
});

/** Pinned for seed "golden-board-1", 4 players, default rules. Changing it means the draw order or state shape changed. */
const GOLDEN_INITIAL_HASH = 'bbe8d3d6b9ff3a2ba744760b9cc886047d8a87970e494373dcece1e12835094c';
