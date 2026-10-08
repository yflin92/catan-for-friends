// A small, hand-built GameState used by serialization and hashing tests. It is type-correct but not a legal game.
import { DEFAULT_GAME_CONFIG } from '../config';
import type { GameState, PlayerState, ResourceCounts } from '../state';
import { initRng } from '../rng';

const counts = (n: number): ResourceCounts => ({ brick: n, lumber: n, wool: n, grain: n, ore: n });

const player = (hand: number): PlayerState => ({
  hand: counts(hand),
  devCards: [{ kind: 'knight', boughtOnTurn: 1 }],
  playedDev: { knight: 0, roadBuilding: 0, yearOfPlenty: 0, monopoly: 0 },
  supply: { settlements: 4, cities: 4, roads: 14 },
  longestRoad: 1,
});

export function fixtureState(): GameState {
  return {
    schemaVersion: 1,
    config: DEFAULT_GAME_CONFIG.rules,
    playerCount: 3,
    board: {
      hexes: [
        { id: 'h:0,-2', terrain: 'forest', token: 6 },
        { id: 'h:1,-2', terrain: 'desert', token: null },
      ],
      harbors: [{ edge: 'e:0,-2,NW', kind: 'generic' }],
    },
    robber: 'h:1,-2',
    pieces: {
      settlements: { 'v:0,-2,N': 0, 'v:1,-2,S': 1 },
      cities: {},
      roads: { 'e:0,-2,NE': 0, 'e:1,-2,W': 1 },
    },
    players: [player(1), player(2), player(0)],
    bank: counts(16),
    devDeck: ['victoryPoint', 'monopoly', 'knight'],
    turn: { number: 3, active: 1, dice: [2, 5], devPlayed: false },
    phase: { name: 'main' },
    trade: null,
    nextTradeId: 2,
    awards: { longestRoad: null, largestArmy: null },
    rng: initRng('fixture-seed'),
    log: [
      { n: 1, event: { kind: 'devBought', seat: 0 }, visibleTo: 'all' },
      { n: 2, event: { kind: 'devBoughtDetail', seat: 0, card: 'knight' }, visibleTo: [0] },
    ],
    logCounter: 2,
  };
}
