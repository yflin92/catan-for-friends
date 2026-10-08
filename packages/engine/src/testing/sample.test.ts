import { describe, expect, it } from 'vitest';
import type { Action } from '../events';
import type { Seat } from '../ids';
import type { LegalActions } from '../legal';
import { legalActions } from '../legal-actions';
import { RESOURCES, type GameState, type ResourceCounts, type TradeOffer } from '../state';
import { actionsFromDescriptor, enumerateLegalActions, sampleFromDescriptor, sampleLegalAction } from './sample';
import { buildState } from './state';

const none: ResourceCounts = { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 };
const rc = (x: Partial<ResourceCounts>): ResourceCounts => ({ ...none, ...x });

function descriptor(state: GameState, seat: Seat, x: Partial<LegalActions> = {}): LegalActions {
  return {
    seat, phase: state.phase.name, placeSettlement: [], placeRoad: [], buildCity: [], rollDice: false, endTurn: false,
    buyDevCard: false, playKnight: false, playRoadBuilding: false, playYearOfPlenty: [], playMonopoly: false, discard: null,
    moveRobber: [], maritime: {}, bankStock: state.bank, proposeTrade: false, respondTrade: null, confirmTrade: null,
    cancelTrade: null, ...x,
  };
}

/** A seeded [0, 1) generator (mulberry32) so sampling tests are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

const covers = (hand: ResourceCounts, need: ResourceCounts) => RESOURCES.every((r) => hand[r] >= need[r]);

/** The exact DR2 trade fields (design §3.6), computed independently from the state. */
function tradeFields(s: GameState, seat: Seat): Pick<LegalActions, 'respondTrade' | 'confirmTrade' | 'cancelTrade'> {
  const t = s.trade;
  if (t === null) return { respondTrade: null, confirmTrade: null, cancelTrade: null };
  const hand = (p: Seat) => s.players[p]!.hand;
  const partners = ([0, 1, 2, 3] as Seat[]).filter(
    (p) => p < s.playerCount && t.responses[p] === 'accepted' && covers(hand(t.from), t.give) && covers(hand(p), t.get),
  );
  return {
    respondTrade: seat !== s.turn.active ? { tradeId: t.id, canAccept: covers(hand(seat), t.get) } : null,
    confirmTrade: seat === t.from && partners.length > 0 ? { tradeId: t.id, partners } : null,
    cancelTrade: seat === t.from ? t.id : null,
  };
}

describe('trade expansion on a hand-built open-offer state (DR2)', () => {
  // Seat 0 offers 1 brick for 1 wool. Seat 1 accepted and holds wool; seat 2 holds no wool; seat 3 accepted but has
  // since spent its wool, so it is not confirmable.
  const offer: TradeOffer = { id: 7, from: 0, give: rc({ brick: 1 }), get: rc({ wool: 1 }), responses: ['self', 'accepted', 'pending', 'accepted'] };
  const s = buildState({ hands: { 0: { brick: 2 }, 1: { wool: 1 }, 3: { ore: 1 } }, trade: offer });
  const expand = (seat: Seat) => actionsFromDescriptor(s, seat, descriptor(s, seat, tradeFields(s, seat)));

  it('a non-active seat that can pay gets decline and accept', () => {
    expect(expand(1)).toEqual([
      { type: 'respondTrade', tradeId: 7, accept: false },
      { type: 'respondTrade', tradeId: 7, accept: true },
    ]);
  });

  it('a non-active seat that cannot pay gets the decline only', () => {
    expect(expand(2)).toEqual([{ type: 'respondTrade', tradeId: 7, accept: false }]);
    expect(expand(3)).toEqual([{ type: 'respondTrade', tradeId: 7, accept: false }]);
  });

  it('the proposer gets one confirm per confirmable partner, then cancel', () => {
    expect(expand(0)).toEqual([
      { type: 'confirmTrade', tradeId: 7, partner: 1 },
      { type: 'cancelTrade', tradeId: 7 },
    ]);
  });

  it('sampling picks only from the same actions', () => {
    for (const seat of [0, 1, 2, 3] as Seat[]) {
      const legal = descriptor(s, seat, tradeFields(s, seat));
      const all = actionsFromDescriptor(s, seat, legal);
      const rand = rng(seat + 1);
      for (let i = 0; i < 50; i++) expect(all).toContainEqual(sampleFromDescriptor(s, seat, legal, rand));
    }
  });
});

describe('actionsFromDescriptor expands every field', () => {
  const s = buildState({ hands: { 0: { brick: 2, wool: 1, ore: 4 } }, bank: { brick: 17, lumber: 19, wool: 18, grain: 1, ore: 15 }, allowInvariantViolations: true });

  it('lists placements, flags, robber moves, dev plays and endTurn in descriptor order', () => {
    const legal = descriptor(s, 0, {
      placeSettlement: ['v:0,0,N'], placeRoad: ['e:0,0,NE'], buildCity: ['v:0,1,S'], rollDice: true, buyDevCard: true,
      playKnight: true, playRoadBuilding: true, playYearOfPlenty: [['brick', 'ore']], playMonopoly: true, endTurn: true,
      moveRobber: [{ hex: 'h:1,0', victims: [] }, { hex: 'h:2,0', victims: [1, 2] }],
    });
    expect(actionsFromDescriptor(s, 0, legal)).toEqual([
      { type: 'placeSettlement', vertex: 'v:0,0,N' },
      { type: 'placeRoad', edge: 'e:0,0,NE' },
      { type: 'buildCity', vertex: 'v:0,1,S' },
      { type: 'rollDice' },
      { type: 'moveRobber', hex: 'h:1,0', victim: null },
      { type: 'moveRobber', hex: 'h:2,0', victim: 1 },
      { type: 'moveRobber', hex: 'h:2,0', victim: 2 },
      { type: 'buyDevCard' },
      { type: 'playKnight' },
      { type: 'playRoadBuilding' },
      { type: 'playYearOfPlenty', take: ['brick', 'ore'] },
      ...RESOURCES.map((resource) => ({ type: 'playMonopoly', resource })),
      { type: 'endTurn' },
    ]);
  });

  it('expands discard into every sub-hand of the owed size', () => {
    const all = actionsFromDescriptor(s, 0, descriptor(s, 0, { discard: { count: 3 } }));
    // hand {brick 2, wool 1, ore 4}: count ways to pick 3 = Σ over brick 0..2, wool 0..1 with ore = 3 − b − w ≤ 4
    expect(all).toHaveLength(6);
    for (const a of all) {
      const cards = (a as Extract<Action, { type: 'discard' }>).cards;
      expect(RESOURCES.reduce((n, r) => n + cards[r], 0)).toBe(3);
      expect(covers(s.players[0]!.hand, cards)).toBe(true);
    }
    expect(new Set(all.map((a) => JSON.stringify(a))).size).toBe(6);
  });

  it('expands maritime trades over receive resources and counts the hand and bank allow', () => {
    const all = actionsFromDescriptor(s, 0, descriptor(s, 0, { maritime: { ore: 2 } }));
    // ore 4 at 2:1 → up to 2 of each other resource; the bank has only 1 grain.
    expect(all).toEqual([
      { type: 'maritimeTrade', give: 'ore', receive: 'brick', count: 1 },
      { type: 'maritimeTrade', give: 'ore', receive: 'brick', count: 2 },
      { type: 'maritimeTrade', give: 'ore', receive: 'lumber', count: 1 },
      { type: 'maritimeTrade', give: 'ore', receive: 'lumber', count: 2 },
      { type: 'maritimeTrade', give: 'ore', receive: 'wool', count: 1 },
      { type: 'maritimeTrade', give: 'ore', receive: 'wool', count: 2 },
      { type: 'maritimeTrade', give: 'ore', receive: 'grain', count: 1 },
    ]);
  });

  it('enumerates proposeTrade as one-for-one offers of held resources', () => {
    const all = actionsFromDescriptor(s, 0, descriptor(s, 0, { proposeTrade: true }));
    expect(all).toHaveLength(3 * 4);
    expect(all[0]).toEqual({ type: 'proposeTrade', give: rc({ brick: 1 }), get: rc({ lumber: 1 }) });
  });

  it('respects limit', () => {
    const legal = descriptor(s, 0, { proposeTrade: true, endTurn: true });
    expect(actionsFromDescriptor(s, 0, legal, 5)).toHaveLength(5);
    expect(actionsFromDescriptor(s, 0, legal, 0)).toEqual([]);
  });

  it('yields nothing for an all-empty descriptor', () => {
    expect(actionsFromDescriptor(s, 0, descriptor(s, 0))).toEqual([]);
    expect(sampleFromDescriptor(s, 0, descriptor(s, 0), rng(1))).toBeNull();
  });
});

describe('sampleFromDescriptor: sampled actions come from the descriptor', () => {
  const s = buildState({ hands: { 0: { brick: 2, wool: 1, ore: 4, grain: 3 } } });
  const legal = descriptor(s, 0, {
    placeRoad: ['e:0,0,NE', 'e:0,0,NW'], endTurn: true, discard: { count: 5 }, maritime: { ore: 4, grain: 3 }, proposeTrade: true,
  });
  const listed = actionsFromDescriptor(s, 0, legal).map((a) => JSON.stringify(a));
  const hand = s.players[0]!.hand;

  it('every sample is valid for its family, and every family gets sampled', () => {
    const rand = rng(42);
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const a = sampleFromDescriptor(s, 0, legal, rand)!;
      seen.add(a.type);
      if (a.type === 'discard') {
        expect(RESOURCES.reduce((n, r) => n + a.cards[r], 0)).toBe(5);
        expect(covers(hand, a.cards)).toBe(true);
      } else if (a.type === 'proposeTrade') {
        const giveTotal = RESOURCES.reduce((n, r) => n + a.give[r], 0);
        const getTotal = RESOURCES.reduce((n, r) => n + a.get[r], 0);
        expect(giveTotal).toBeGreaterThanOrEqual(1);
        expect(getTotal).toBeGreaterThanOrEqual(1);
        expect(covers(hand, a.give)).toBe(true);
        expect(RESOURCES.some((r) => a.give[r] > 0 && a.get[r] > 0)).toBe(false);
      } else {
        expect(listed).toContain(JSON.stringify(a));
      }
    }
    expect([...seen].sort()).toEqual(['discard', 'endTurn', 'maritimeTrade', 'placeRoad', 'proposeTrade']);
  });

  it('is deterministic for the same rand sequence', () => {
    const run = (seed: number) => Array.from({ length: 20 }, ((r) => () => sampleFromDescriptor(s, 0, legal, r))(rng(seed)));
    expect(run(7)).toEqual(run(7));
  });
});

describe('enumerateLegalActions / sampleLegalAction use the engine descriptor', () => {
  it('equal the descriptor expansion of legalActions(state, seat)', () => {
    const s = buildState({ hands: { 0: { brick: 1 } } });
    for (const seat of [0, 1] as Seat[]) {
      expect(enumerateLegalActions(s, seat)).toEqual(actionsFromDescriptor(s, seat, legalActions(s, seat)));
      const expected = sampleFromDescriptor(s, seat, legalActions(s, seat), rng(3));
      expect(sampleLegalAction(s, seat, rng(3))).toEqual(expected);
    }
  });
});
