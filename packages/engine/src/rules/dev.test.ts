import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Command } from '../events';
import type { Seat } from '../ids';
import { legalActions } from '../legal-actions';
import { reduce } from '../reduce';
import type { DevCardKind, GameState, Phase, TradeOffer } from '../state';
import { buildState, validateInvariants } from '../testing';
import { victoryPoints } from '../victory';
import { view } from '../view';

const BUY: Command['action'] = { type: 'buyDevCard' };
const KNIGHT: Command['action'] = { type: 'playKnight' };
const buy = (by: Seat): Command => ({ by, action: BUY });
const knight = (by: Seat): Command => ({ by, action: KNIGHT });
const FUNDS = { ore: 1, wool: 1, grain: 1 };

/** Seat 0 active on turn 5 in `phase`, with `cards` in hand and `knights` already played by each seat. */
function devState(opts: {
  phase?: Phase;
  cards?: { kind: DevCardKind; boughtOnTurn: number }[];
  knights?: Partial<Record<Seat, number>>;
  devPlayed?: boolean;
  hand?: Partial<Record<'brick' | 'lumber' | 'wool' | 'grain' | 'ore', number>>;
  devDeck?: DevCardKind[];
  largestArmy?: Seat | null;
  trade?: TradeOffer | null;
} = {}): GameState {
  const knights = opts.knights ?? {};
  const s = buildState({
    playerCount: 3,
    phase: opts.phase ?? { name: 'main' },
    turn: { number: 5, active: 0, devPlayed: opts.devPlayed ?? false },
    hands: { 0: opts.hand ?? FUNDS },
    devCards: { 0: opts.cards ?? [] },
    playedDev: Object.fromEntries(Object.entries(knights).map(([seat, n]) => [seat, { knight: n }])),
    ...(opts.devDeck ? { devDeck: opts.devDeck } : {}),
    ...(opts.trade !== undefined ? { trade: opts.trade } : {}),
  });
  return opts.largestArmy !== undefined ? { ...s, awards: { ...s.awards, largestArmy: opts.largestArmy } } : s;
}

describe('buyDevCard (R10, AC12)', () => {
  it('pays ore + wool + grain, draws the last deck card, records boughtOnTurn and logs both events', () => {
    const s = devState();
    const top = s.devDeck.at(-1)!;
    const r = reduce(s, buy(0));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.state.players[0]!;
    expect(p.hand).toEqual({ brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 });
    expect(r.state.bank.ore).toBe(s.bank.ore + 1);
    expect(p.devCards).toEqual([{ kind: top, boughtOnTurn: 5 }]);
    expect(r.state.devDeck).toEqual(s.devDeck.slice(0, -1));
    expect(r.events).toEqual([{ kind: 'devBought', seat: 0 }, { kind: 'devBoughtDetail', seat: 0, card: top }]);
    expect(r.state.log.slice(-2).map((e) => e.visibleTo)).toEqual(['all', [0]]);
    expect(validateInvariants(r.state)).toEqual([]);
  });

  it('only the buyer sees the card kind; everyone sees the count go up', () => {
    const r = reduce(devState(), buy(0));
    if (!r.ok) throw new Error(r.reason);
    const other = view(r.state, 1);
    expect(other.players[0]!.devCardCount).toBe(1);
    expect(other.log.some((e) => e.event.kind === 'devBoughtDetail')).toBe(false);
    expect(view(r.state, 0).devCards).toHaveLength(1);
  });

  it('insufficient_resources without the cost, and that beats an empty deck', () => {
    expect(reduce(devState({ hand: { ore: 1, wool: 1 } }), buy(0))).toEqual({ ok: false, reason: 'insufficient_resources' });
    const empty = devState({ hand: { ore: 1, wool: 1 } });
    expect(reduce({ ...empty, devDeck: [] }, buy(0))).toEqual({ ok: false, reason: 'insufficient_resources' });
  });

  it('dev_deck_empty when the deck is exhausted', () => {
    const s = devState();
    // A targeted state: only the deck is emptied (card totals are not kept), to reach dev_deck_empty directly.
    const emptied: GameState = { ...s, devDeck: [] };
    expect(reduce(emptied, buy(0))).toEqual({ ok: false, reason: 'dev_deck_empty' });
  });

  it('is a main-phase action for the active seat only', () => {
    expect(reduce(devState({ phase: { name: 'preRoll' } }), buy(0))).toEqual({ ok: false, reason: 'wrong_phase' });
    expect(reduce(devState(), buy(1))).toEqual({ ok: false, reason: 'not_your_turn' });
  });
});

describe('dev-card play rules (R10, AC12)', () => {
  it('dev_card_not_owned when the seat holds no such card', () => {
    expect(reduce(devState({ cards: [{ kind: 'monopoly', boughtOnTurn: 1 }] }), knight(0))).toEqual({
      ok: false,
      reason: 'dev_card_not_owned',
    });
  });

  it('dev_card_bought_this_turn when every such card was bought this turn', () => {
    expect(reduce(devState({ cards: [{ kind: 'knight', boughtOnTurn: 5 }] }), knight(0))).toEqual({
      ok: false,
      reason: 'dev_card_bought_this_turn',
    });
  });

  it('plays an older card even when a newer one of the same kind was bought this turn', () => {
    const s = devState({ cards: [{ kind: 'knight', boughtOnTurn: 5 }, { kind: 'knight', boughtOnTurn: 2 }] });
    const r = reduce(s, knight(0));
    expect(r.ok && r.state.players[0]!.devCards).toEqual([{ kind: 'knight', boughtOnTurn: 5 }]);
  });

  it('dev_card_already_played for a second card in one turn', () => {
    expect(reduce(devState({ cards: [{ kind: 'knight', boughtOnTurn: 1 }], devPlayed: true }), knight(0))).toEqual({
      ok: false,
      reason: 'dev_card_already_played',
    });
  });

  it('is allowed in preRoll and main only, by the active seat', () => {
    const cards = [{ kind: 'knight' as const, boughtOnTurn: 1 }];
    expect(reduce(devState({ cards, phase: { name: 'preRoll' } }), knight(0)).ok).toBe(true);
    expect(reduce(devState({ cards }), knight(0)).ok).toBe(true);
    expect(reduce(devState({ cards, phase: { name: 'moveRobber', resume: 'main' } }), knight(0))).toEqual({
      ok: false,
      reason: 'wrong_phase',
    });
    expect(reduce(devState({ cards }), knight(1))).toEqual({ ok: false, reason: 'not_your_turn' });
  });
});

describe('playKnight and Largest Army (R11, AC13)', () => {
  const cards = [{ kind: 'knight' as const, boughtOnTurn: 1 }];

  it('counts the knight, marks the turn, logs devPlayed and starts the robber move resuming the phase', () => {
    for (const phase of [{ name: 'preRoll' }, { name: 'main' }] as const) {
      const r = reduce(devState({ cards, phase }), knight(0));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.state.players[0]!.playedDev.knight).toBe(1);
      expect(r.state.players[0]!.devCards).toEqual([]);
      expect(r.state.turn.devPlayed).toBe(true);
      expect(r.state.phase).toEqual({ name: 'moveRobber', resume: phase.name });
      expect(r.events[0]).toEqual({ kind: 'devPlayed', seat: 0, card: 'knight' });
      expect(validateInvariants(r.state)).toEqual([]);
    }
  });

  it('withdraws an open offer when played from main', () => {
    const ZERO = { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 };
    const trade: TradeOffer = { id: 3, from: 0, give: { ...ZERO, ore: 1 }, get: { ...ZERO, brick: 1 }, responses: ['self', 'pending', 'pending'] };
    const r = reduce(devState({ cards, trade }), knight(0));
    expect(r.ok && r.state.trade).toBeNull();
    expect(r.ok && r.events.map((e) => e.kind)).toEqual(['devPlayed', 'tradeResolved']);
  });

  it('the third knight takes Largest Army (+2 VP) with an awardChanged event', () => {
    const s = devState({ cards, knights: { 0: 2 } });
    const before = victoryPoints(s, 0).public;
    const r = reduce(s, knight(0));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.awards.largestArmy).toBe(0);
    expect(victoryPoints(r.state, 0).public).toBe(before + 2);
    expect(r.events).toContainEqual({ kind: 'awardChanged', award: 'largestArmy', from: null, to: 0 });
  });

  it('fewer than three knights take nothing', () => {
    const r = reduce(devState({ cards, knights: { 0: 1 } }), knight(0));
    expect(r.ok && r.state.awards.largestArmy).toBeNull();
    expect(r.ok && r.events.some((e) => e.kind === 'awardChanged')).toBe(false);
  });

  it('a tie never transfers it; strictly more does', () => {
    const tie = reduce(devState({ cards, knights: { 0: 2, 1: 3 }, largestArmy: 1 }), knight(0));
    expect(tie.ok && tie.state.awards.largestArmy).toBe(1);
    const more = reduce(devState({ cards, knights: { 0: 3, 1: 3 }, largestArmy: 1 }), knight(0));
    expect(more.ok && more.state.awards.largestArmy).toBe(0);
    expect(more.ok && more.events).toContainEqual({ kind: 'awardChanged', award: 'largestArmy', from: 1, to: 0 });
  });

  it('the holder playing more knights logs no further award change', () => {
    const r = reduce(devState({ cards, knights: { 0: 3 }, largestArmy: 0 }), knight(0));
    expect(r.ok && r.events.some((e) => e.kind === 'awardChanged')).toBe(false);
  });
});

describe('victory-point cards (R10, AC12)', () => {
  it('count in the owner’s total at once, stay out of public VP, and are never playable', () => {
    const s = devState({ cards: [{ kind: 'victoryPoint', boughtOnTurn: 5 }] });
    expect(victoryPoints(s, 0).total - victoryPoints(s, 0).public).toBe(1);
    expect(view(s, 1).players[0]!.publicVp).toBe(victoryPoints(s, 0).public);
    expect(view(s, 0).devCards).toEqual([{ kind: 'victoryPoint', playableNow: false }]);
  });

  it('a bought VP card counts immediately', () => {
    const deck = [...devState().devDeck];
    deck.splice(deck.indexOf('victoryPoint'), 1);
    const s = devState({ devDeck: [...deck, 'victoryPoint'] });
    const r = reduce(s, buy(0));
    expect(r.ok && victoryPoints(r.state, 0).total).toBe(victoryPoints(s, 0).total + 1);
  });

  it('playableNow follows legal.playKnight and the bought-this-turn rule', () => {
    const s = devState({ cards: [{ kind: 'knight', boughtOnTurn: 1 }, { kind: 'knight', boughtOnTurn: 5 }] });
    expect(view(s, 0).devCards.map((c) => c.playableNow)).toEqual([true, false]);
  });
});

describe('dev-card properties', () => {
  const arbState = fc
    .record({
      phase: fc.constantFrom<Phase>({ name: 'preRoll' }, { name: 'main' }, { name: 'moveRobber', resume: 'main' }),
      cards: fc.array(fc.record({ kind: fc.constantFrom<DevCardKind>('knight', 'victoryPoint'), boughtOnTurn: fc.integer({ min: 1, max: 5 }) }), { maxLength: 3 }),
      devPlayed: fc.boolean(),
      ore: fc.nat({ max: 2 }),
      knights: fc.nat({ max: 4 }),
    })
    .map(({ phase, cards, devPlayed, ore, knights }) =>
      devState({ phase, cards, devPlayed, hand: { ore, wool: 1, grain: 1 }, knights: { 1: knights } }),
    );

  it('legal.buyDevCard and legal.playKnight ⇔ reduce, for every seat', () => {
    fc.assert(
      fc.property(arbState, fc.constantFrom<Seat>(0, 1, 2), (s, seat) => {
        const l = legalActions(s, seat);
        expect(l.buyDevCard).toBe(reduce(s, buy(seat)).ok);
        expect(l.playKnight).toBe(reduce(s, knight(seat)).ok);
      }),
      { numRuns: 400 },
    );
  });

  it('deck + hands + played stays 25 by kind across random buys and knights', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom('buy', 'knight', 'turn'), { maxLength: 30 }), (steps) => {
        let s = buildState({ playerCount: 3, phase: { name: 'main' }, turn: { number: 3, active: 0 }, hands: { 0: { ore: 9, wool: 9, grain: 9 } } });
        for (const step of steps) {
          const seat = s.turn.active;
          const cmd = step === 'buy' ? buy(seat) : step === 'knight' ? knight(seat) : ({ by: seat, action: { type: 'endTurn' } } as Command);
          const r = reduce(s, cmd);
          if (!r.ok) continue;
          // Leave the robber phase / next turn's preRoll directly so the walk can keep buying.
          s = { ...r.state, phase: { name: 'main' } };
          expect(validateInvariants(s)).toEqual([]);
        }
      }),
      { numRuns: 100 },
    );
  });
});

describe('validateInvariants: played dev cards', () => {
  it('flags a negative playedDev count', () => {
    const s = devState();
    const bad: GameState = {
      ...s,
      players: s.players.map((p, i) => (i === 1 ? { ...p, playedDev: { ...p.playedDev, monopoly: -1 } } : p)),
    };
    expect(validateInvariants(bad).map((i) => i.code)).toContain('negative_count');
  });

  it('flags a broken dev-card total (deck + hands + played ≠ starting count)', () => {
    const s = devState();
    const bad: GameState = { ...s, devDeck: [...s.devDeck, 'knight'] };
    expect(validateInvariants(bad).map((i) => i.code)).toContain('dev_card_total');
  });
});
