import { describe, expect, it } from 'vitest';
import type { GameState } from '../state';
import { validateInvariants } from './invariants';
import { buildState } from './state';

type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };
const base = () =>
  JSON.parse(
    JSON.stringify(
      buildState({
        pieces: [
          { seat: 0, settlements: ['v:0,0,N'], roads: ['e:0,0,NE'] },
          { seat: 1, cities: ['v:0,1,S'], roads: ['e:0,1,W'] },
        ],
        hands: { 0: { brick: 2, wool: 1 }, 1: { ore: 3 } },
        playedDev: { 2: { knight: 3 } },
      }),
    ),
  ) as Mutable<GameState>;
const codes = (s: Mutable<GameState>) => validateInvariants(s as GameState).map((i) => i.code);

describe('validateInvariants catches each seeded violation (design §3.10, AC19)', () => {
  it('accepts a consistent state', () => {
    expect(codes(base())).toEqual([]);
  });

  it('player_count', () => {
    const s = base();
    s.players.pop();
    expect(codes(s)).toContain('player_count');
  });

  it('resource_total: a card created or destroyed', () => {
    const s = base();
    s.players[0]!.hand.brick += 1;
    expect(codes(s)).toEqual(['resource_total']);
  });

  it('negative_count: a negative hand, bank or supply entry, or a non-integer', () => {
    const s = base();
    s.players[0]!.hand.wool = -1;
    s.bank.wool += 2;
    expect(codes(s)).toEqual(['negative_count']);
    const t = base();
    t.bank.grain = 18.5;
    expect(codes(t)).toContain('negative_count');
  });

  it('piece_total: a piece without its supply decrement', () => {
    const s = base();
    s.pieces.roads['e:1,-1,W'] = 0;
    expect(codes(s)).toEqual(['piece_total']);
  });

  it('piece_location: off-board id, unknown owner, or settlement and city on one vertex', () => {
    const off = base();
    off.pieces.roads['e:9,9,W'] = 0;
    off.players[0]!.supply.roads -= 1;
    expect(codes(off)).toEqual(['piece_location']);
    const owner = base();
    owner.pieces.roads['e:1,-1,W'] = 7 as 0;
    expect(codes(owner)).toEqual(['piece_location']);
    const both = base();
    both.pieces.cities['v:0,0,N'] = 0;
    both.players[0]!.supply.cities -= 1;
    expect(codes(both)).toEqual(['piece_location']);
  });

  it('dev_card_total: a card missing from the deck', () => {
    const s = base();
    s.devDeck.pop();
    expect(codes(s)).toEqual(['dev_card_total']);
  });

  it('distance_rule: buildings on adjacent vertices', () => {
    const s = base();
    s.pieces.settlements['v:1,-1,S'] = 1;
    s.players[1]!.supply.settlements -= 1;
    expect(codes(s)).toEqual(['distance_rule']);
  });

  it('award: holder below threshold, strictly beaten, outside the game, or missing', () => {
    const below = base();
    below.awards.longestRoad = 0;
    expect(codes(below)).toEqual(['award']);
    const beaten = base();
    beaten.players[1]!.playedDev.knight = 4;
    beaten.devDeck.splice(beaten.devDeck.indexOf('knight'), 4);
    expect(codes(beaten)).toEqual(['award']);
    const outside = base();
    outside.awards.largestArmy = 3;
    outside.playerCount = 3;
    outside.players.pop();
    expect(codes(outside)).toContain('award');
    const missing = base();
    missing.awards.largestArmy = null;
    expect(codes(missing)).toEqual(['award']);
  });

  it('allows a tied award to stay with its holder, and no holder after a tie', () => {
    const tie = base();
    tie.players[1]!.playedDev.knight = 3;
    tie.devDeck.splice(tie.devDeck.indexOf('knight'), 3);
    expect(codes(tie)).toEqual([]);
    tie.awards.largestArmy = null;
    expect(codes(tie)).toEqual([]);
  });

  it('robber: not on a board hex', () => {
    const s = base();
    s.robber = 'h:3,0';
    expect(codes(s)).toEqual(['robber']);
  });

  it('trade: open outside main, from a non-active seat, or with an id ≥ nextTradeId', () => {
    const offer = (from: 0 | 1, id: number) => ({
      id, from, give: { brick: 1, lumber: 0, wool: 0, grain: 0, ore: 0 }, get: { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 1 },
      responses: ['self', 'pending', 'pending', 'pending'] as ('self' | 'pending')[],
    });
    const outside = base();
    outside.trade = offer(0, 1);
    outside.nextTradeId = 2;
    outside.phase = { name: 'preRoll' };
    expect(codes(outside)).toEqual(['trade']);
    const notActive = base();
    notActive.trade = offer(1, 1);
    notActive.nextTradeId = 2;
    expect(codes(notActive)).toEqual(['trade']);
    const futureId = base();
    futureId.trade = offer(0, 1);
    expect(codes(futureId)).toEqual(['trade']);
  });
});
