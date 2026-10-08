// Player-to-player trades (AC17, V13) and the exact DR2 trade descriptor (V11).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { covers } from '../costs';
import type { Command, GameEvent } from '../events';
import type { Seat } from '../ids';
import { beginTurn, setPhase } from '../internal/turn';
import type { LegalActions } from '../legal';
import { legalActions } from '../legal-actions';
import { eventsSince } from '../log';
import { reduce } from '../reduce';
import type { GameState, ResourceCounts, TradeOffer } from '../state';
import { RESOURCES } from '../state';
import { buildState, validateInvariants } from '../testing';

const rc = (c: Partial<ResourceCounts> = {}): ResourceCounts => ({ brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0, ...c });
const MAIN = { phase: { name: 'main' } as const, turn: { number: 3, active: 0 as Seat, dice: [3, 4] as const, devPlayed: false } };

/** Seat 0 active in main; seat 1 holds wool, seat 2 holds wool and ore, seat 3 holds grain. */
function base(extra: Parameters<typeof buildState>[0] = {}): GameState {
  return buildState({
    playerCount: 4,
    ...MAIN,
    hands: { 0: { brick: 3, lumber: 1 }, 1: { wool: 2 }, 2: { wool: 1, ore: 2 }, 3: { grain: 2 } },
    ...extra,
  });
}

function step(s: GameState, by: Seat, action: Command['action']): { state: GameState; events: readonly GameEvent[] } {
  const r = reduce(s, { by, action } as Command);
  if (!r.ok) throw new Error(`rejected ${action.type}: ${r.reason}`);
  expect(validateInvariants(r.state)).toEqual([]);
  return { state: r.state, events: eventsSince(s, r.state) };
}

function reason(s: GameState, by: Seat, action: Command['action']): string | 'ok' {
  const r = reduce(s, { by, action } as Command);
  return r.ok ? 'ok' : r.reason;
}

const propose = (give: Partial<ResourceCounts>, get: Partial<ResourceCounts>) => ({ type: 'proposeTrade' as const, give: rc(give), get: rc(get) });
const respond = (tradeId: number, accept: boolean) => ({ type: 'respondTrade' as const, tradeId, accept });
const confirm = (tradeId: number, partner: Seat) => ({ type: 'confirmTrade' as const, tradeId, partner });
const cancel = (tradeId: number) => ({ type: 'cancelTrade' as const, tradeId });

describe('proposeTrade', () => {
  it('opens an offer under nextTradeId with every other seat pending, and logs tradeProposed', () => {
    const s = base();
    const { state, events } = step(s, 0, propose({ brick: 1 }, { wool: 1 }));
    const offer: TradeOffer = { id: s.nextTradeId, from: 0, give: rc({ brick: 1 }), get: rc({ wool: 1 }), responses: ['self', 'pending', 'pending', 'pending'] };
    expect(state.trade).toEqual(offer);
    expect(state.nextTradeId).toBe(s.nextTradeId + 1);
    expect(events).toEqual([{ kind: 'tradeProposed', offer, replaced: null }]);
    expect(state.players.map((p) => p.hand)).toEqual(s.players.map((p) => p.hand));
  });

  it.each([
    ['empty give', {}, { wool: 1 }],
    ['empty get', { brick: 1 }, {}],
    ['a resource on both sides', { brick: 1 }, { brick: 1, wool: 1 }],
    ['give not held', { ore: 1 }, { wool: 1 }],
    ['more than held', { brick: 4 }, { wool: 1 }],
    ['a negative count', { brick: 1, ore: -1 }, { wool: 1 }],
  ])('rejects %s with invalid_trade', (_, give, get) => {
    expect(reason(base(), 0, propose(give, get))).toBe('invalid_trade');
  });

  it('only the active seat proposes, and only in main', () => {
    expect(reason(base(), 1, propose({ wool: 1 }, { brick: 1 }))).toBe('not_your_turn');
    expect(reason(base({ phase: { name: 'preRoll' }, turn: { ...MAIN.turn, dice: null } }), 0, propose({ brick: 1 }, { wool: 1 }))).toBe('wrong_phase');
  });

  it('a new proposal replaces the open offer: the old id is closed and every response resets', () => {
    let s = step(base(), 0, propose({ brick: 1 }, { wool: 1 })).state;
    const oldId = s.trade!.id;
    s = step(s, 1, respond(oldId, true)).state;
    const { state, events } = step(s, 0, propose({ lumber: 1 }, { ore: 1 }));
    expect(events).toEqual([
      { kind: 'tradeResolved', tradeId: oldId, outcome: 'replaced', partner: null },
      { kind: 'tradeProposed', offer: state.trade, replaced: oldId },
    ]);
    expect(state.trade!.id).toBe(oldId + 1);
    expect(state.trade!.responses).toEqual(['self', 'pending', 'pending', 'pending']);
    expect(reason(state, 2, respond(oldId, true))).toBe('trade_not_found');
    expect(reason(state, 2, respond(oldId, false))).toBe('trade_not_found');
    expect(reason(state, 0, confirm(oldId, 1))).toBe('trade_not_found');
    expect(reason(state, 0, cancel(oldId))).toBe('trade_not_found');
  });
});

describe('respondTrade', () => {
  const open = () => step(base(), 0, propose({ brick: 1 }, { wool: 1 })).state;

  it('decline is always allowed; accept needs the get side, else insufficient_resources', () => {
    const s = open();
    const id = s.trade!.id;
    expect(reason(s, 3, respond(id, false))).toBe('ok');
    expect(reason(s, 3, respond(id, true))).toBe('insufficient_resources');
    const { state, events } = step(s, 1, respond(id, true));
    expect(state.trade!.responses).toEqual(['self', 'accepted', 'pending', 'pending']);
    expect(events).toEqual([{ kind: 'tradeResponded', tradeId: id, seat: 1, accept: true }]);
    expect(state.players.map((p) => p.hand)).toEqual(s.players.map((p) => p.hand));
  });

  it('a response can be changed and re-sent (a new event each time, no cards move)', () => {
    let s = open();
    const id = s.trade!.id;
    s = step(s, 1, respond(id, true)).state;
    s = step(s, 1, respond(id, false)).state;
    expect(s.trade!.responses[1]).toBe('declined');
    const again = step(s, 1, respond(id, false));
    expect(again.state.trade).toEqual(s.trade);
    expect(again.events).toEqual([{ kind: 'tradeResponded', tradeId: id, seat: 1, accept: false }]);
  });

  it('the proposer cannot respond; an unknown id is trade_not_found', () => {
    const s = open();
    expect(reason(s, 0, respond(s.trade!.id, true))).toBe('not_your_turn');
    expect(reason(s, 1, respond(s.trade!.id + 5, false))).toBe('trade_not_found');
    expect(reason(base(), 1, respond(1, false))).toBe('trade_not_found');
  });
});

describe('confirmTrade', () => {
  it('swaps both sides atomically between proposer and partner, bank unchanged, and closes the offer', () => {
    let s = step(base(), 0, propose({ brick: 2 }, { wool: 1 })).state;
    const id = s.trade!.id;
    s = step(s, 1, respond(id, true)).state;
    const { state, events } = step(s, 0, confirm(id, 1));
    expect(state.players[0]!.hand).toEqual(rc({ brick: 1, lumber: 1, wool: 1 }));
    expect(state.players[1]!.hand).toEqual(rc({ brick: 2, wool: 1 }));
    expect(state.bank).toEqual(s.bank);
    expect(state.trade).toBeNull();
    expect(events).toEqual([{ kind: 'tradeResolved', tradeId: id, outcome: 'confirmed', partner: 1 }]);
  });

  it('a partner that has not accepted → trade_not_accepted (pending, declined, self, no such seat)', () => {
    let s = step(base({ playerCount: 3, hands: { 0: { brick: 3 }, 1: { wool: 2 }, 2: { wool: 1 } } }), 0, propose({ brick: 1 }, { wool: 1 })).state;
    const id = s.trade!.id;
    s = step(s, 2, respond(id, false)).state;
    expect(reason(s, 0, confirm(id, 1))).toBe('trade_not_accepted');
    expect(reason(s, 0, confirm(id, 2))).toBe('trade_not_accepted');
    expect(reason(s, 0, confirm(id, 0))).toBe('trade_not_accepted');
    expect(reason(s, 0, confirm(id, 3))).toBe('trade_not_accepted');
  });

  it('holdings that changed after acceptance → trade_stale, and the partner leaves legal.confirmTrade', () => {
    // Seat 0 offers brick for wool; seats 1 and 2 accept; then seat 0 spends its last spare brick on a road.
    const offer: TradeOffer = { id: 4, from: 0, give: rc({ brick: 1 }), get: rc({ wool: 1 }), responses: ['self', 'accepted', 'accepted', 'pending'] };
    const s = base({ trade: offer, hands: { 0: { brick: 1, lumber: 1 }, 1: { wool: 1 }, 2: {}, 3: {} } });
    expect(legalActions(s, 0).confirmTrade).toEqual({ tradeId: 4, partners: [1] });
    expect(reason(s, 0, confirm(4, 2))).toBe('trade_stale');
    const spent = { ...s, players: s.players.map((p, i) => (i === 0 ? { ...p, hand: rc({ lumber: 1 }) } : p)), bank: { ...s.bank, brick: s.bank.brick + 1 } };
    expect(legalActions(spent, 0).confirmTrade).toBeNull();
    expect(reason(spent, 0, confirm(4, 1))).toBe('trade_stale');
  });

  it('two concurrent accepts + confirm → exactly one exchange', () => {
    let s = step(base(), 0, propose({ brick: 1 }, { wool: 1 })).state;
    const id = s.trade!.id;
    s = step(s, 1, respond(id, true)).state;
    s = step(s, 2, respond(id, true)).state;
    expect(legalActions(s, 0).confirmTrade).toEqual({ tradeId: id, partners: [1, 2] });
    const after = step(s, 0, confirm(id, 2)).state;
    expect(reason(after, 0, confirm(id, 1))).toBe('trade_not_found');
    const moved = (st: GameState) => st.players.map((p) => p.hand);
    expect(moved(after)[1]).toEqual(moved(s)[1]);
    expect(moved(after)[2]).toEqual(rc({ brick: 1, ore: 2 }));
    expect(moved(after)[0]).toEqual(rc({ brick: 2, lumber: 1, wool: 1 }));
  });
});

describe('cancelTrade', () => {
  it('closes the open offer; a second cancel or a wrong id is trade_not_found; only the proposer may cancel', () => {
    const s = step(base(), 0, propose({ brick: 1 }, { wool: 1 })).state;
    const id = s.trade!.id;
    expect(reason(s, 1, cancel(id))).toBe('not_your_turn');
    expect(reason(s, 0, cancel(id + 1))).toBe('trade_not_found');
    const { state, events } = step(s, 0, cancel(id));
    expect(state.trade).toBeNull();
    expect(events).toEqual([{ kind: 'tradeResolved', tradeId: id, outcome: 'cancelled', partner: null }]);
    expect(reason(state, 0, cancel(id))).toBe('trade_not_found');
  });
});

describe('withdrawal on every exit from main (R13, D1)', () => {
  const opened = () => step(base(), 0, propose({ brick: 1 }, { wool: 1 })).state;
  const withdrawn = (before: GameState, after: GameState, exitTo: string) => {
    expect(after.trade).toBeNull();
    expect(eventsSince(before, after)).toContainEqual({ kind: 'tradeResolved', tradeId: before.trade!.id, outcome: 'withdrawn', partner: null, exitTo });
  };

  it('endTurn (through reduce): the offer is withdrawn and its id is gone', () => {
    const s = opened();
    const id = s.trade!.id;
    const { state } = step(s, 0, { type: 'endTurn' });
    withdrawn(s, state, 'preRoll');
    expect(reason(state, 2, respond(id, false))).toBe('wrong_phase');
  });

  it('playKnight from main (through reduce): the offer is withdrawn on the way to moveRobber', () => {
    const s = step(base({ devCards: { 0: [{ kind: 'knight', boughtOnTurn: 1 }] } }), 0, propose({ brick: 1 }, { wool: 1 })).state;
    const id = s.trade!.id;
    const { state } = step(s, 0, { type: 'playKnight' });
    expect(state.phase.name).toBe('moveRobber');
    withdrawn(s, state, 'moveRobber');
    expect(reason(state, 0, cancel(id))).toBe('wrong_phase');
  });

  it.each([
    ['Road Building', { name: 'roadBuilding', remaining: 2, resume: 'main' } as const, 'roadBuilding'],
    ['a win', { name: 'gameOver', winner: 0 } as const, 'gameOver'],
  ])('%s (phase change through setPhase)', (_, phase, exitTo) => {
    const s = opened();
    const after = setPhase(s, phase);
    withdrawn(s, after, exitTo);
    const back = setPhase(after, { name: 'main' });
    expect(reason(back, 1, respond(s.trade!.id, false))).toBe('trade_not_found');
  });

  it('a turn-ending skip (the next turn begins)', () => {
    const s = opened();
    withdrawn(s, beginTurn(s, 1), 'preRoll');
  });
});

// ── DR2 exactness (V11): legalActions ⇔ reduce for every trade action ───────────────────────────────────────────

/** Independent oracle for the trade fields (DR2 text), written without the engine's helpers. */
function tradeFields(s: GameState, seat: Seat): Pick<LegalActions, 'respondTrade' | 'confirmTrade' | 'cancelTrade'> {
  const t = s.phase.name === 'main' ? s.trade : null;
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

const counts = fc.record(Object.fromEntries(RESOURCES.map((r) => [r, fc.integer({ min: 0, max: 3 })])) as Record<string, fc.Arbitrary<number>>) as fc.Arbitrary<ResourceCounts>;

/** Random states: 3–4 players, small hands, any active seat, main or another phase, an open offer or none. */
const arbState: fc.Arbitrary<GameState> = fc
  .record({
    n: fc.constantFrom(3 as const, 4 as const),
    active: fc.integer({ min: 0, max: 3 }),
    hands: fc.array(counts, { minLength: 4, maxLength: 4 }),
    inMain: fc.boolean(),
    hasOffer: fc.boolean(),
    id: fc.integer({ min: 1, max: 9 }),
    give: fc.constantFrom(...RESOURCES),
    get: fc.constantFrom(...RESOURCES),
    giveN: fc.integer({ min: 1, max: 2 }),
    getN: fc.integer({ min: 1, max: 2 }),
    responses: fc.array(fc.constantFrom('pending' as const, 'accepted' as const, 'declined' as const), { minLength: 4, maxLength: 4 }),
  })
  .map((r) => {
    const active = (r.active % r.n) as Seat;
    const get = r.get === r.give ? RESOURCES[(RESOURCES.indexOf(r.give) + 1) % 5]! : r.get;
    const inMain = r.inMain || r.hasOffer;
    const trade: TradeOffer | null =
      r.hasOffer
        ? {
            id: r.id,
            from: active,
            give: rc({ [r.give]: r.giveN }),
            get: rc({ [get]: r.getN }),
            responses: Array.from({ length: r.n }, (_, p) => (p === active ? 'self' : r.responses[p]!)),
          }
        : null;
    return buildState({
      playerCount: r.n,
      phase: inMain ? { name: 'main' } : { name: 'preRoll' },
      turn: { number: 3, active, dice: inMain ? [2, 3] : null, devPlayed: false },
      hands: Object.fromEntries(r.hands.slice(0, r.n).map((h, i) => [i, h])),
      trade,
    });
  })
  .map((s) => ({ ...s, nextTradeId: (s.trade?.id ?? 0) + 1 }));

const ok = (s: GameState, by: Seat, action: Command['action']) => reduce(s, { by, action } as Command).ok;

describe('DR2: the trade descriptor is exact (V11)', () => {
  it('matches the independent oracle; partners ascending and never empty', () => {
    fc.assert(
      fc.property(arbState, (s) => {
        for (let p = 0; p < s.playerCount; p++) {
          const seat = p as Seat;
          const l = legalActions(s, seat);
          expect({ respondTrade: l.respondTrade, confirmTrade: l.confirmTrade, cancelTrade: l.cancelTrade }).toEqual(tradeFields(s, seat));
          if (l.confirmTrade !== null) {
            expect(l.confirmTrade.partners.length).toBeGreaterThan(0);
            expect([...l.confirmTrade.partners].sort((a, b) => a - b)).toEqual(l.confirmTrade.partners);
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it('the four equivalences hold for every seat, nearby ids and every partner', () => {
    fc.assert(
      fc.property(arbState, (s) => {
        const open = s.trade?.id ?? 1;
        for (let p = 0; p < s.playerCount; p++) {
          const seat = p as Seat;
          const l = legalActions(s, seat);
          for (const id of [open, open - 1, open + 1, 0, -1]) {
            expect(ok(s, seat, respond(id, false))).toBe(l.respondTrade?.tradeId === id);
            expect(ok(s, seat, respond(id, true))).toBe(l.respondTrade?.tradeId === id && l.respondTrade.canAccept);
            expect(ok(s, seat, cancel(id))).toBe(l.cancelTrade === id);
            for (const partner of [0, 1, 2, 3] as Seat[]) {
              expect(ok(s, seat, confirm(id, partner))).toBe(l.confirmTrade?.tradeId === id && l.confirmTrade.partners.includes(partner));
            }
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it('also holds on states reached by reduce: propose → responses → a build that spends a give card', () => {
    let s = base({ hands: { 0: { brick: 2, lumber: 1 }, 1: { wool: 1 }, 2: { wool: 1 }, 3: { grain: 1 } } });
    s = step(s, 0, propose({ brick: 1 }, { wool: 1 })).state;
    const id = s.trade!.id;
    s = step(s, 1, respond(id, true)).state;
    s = step(s, 2, respond(id, true)).state;
    // Seat 2 gives away its wool, so it is no longer confirmable.
    const drained = { ...s, players: s.players.map((p, i) => (i === 2 ? { ...p, hand: rc() } : p)), bank: { ...s.bank, wool: s.bank.wool + 1 } };
    for (const st of [s, drained]) {
      for (let p = 0; p < st.playerCount; p++) {
        const l = legalActions(st, p as Seat);
        for (const partner of [0, 1, 2, 3] as Seat[]) {
          expect(ok(st, p as Seat, confirm(id, partner))).toBe(l.confirmTrade?.tradeId === id && l.confirmTrade.partners.includes(partner));
        }
      }
    }
    expect(legalActions(drained, 0).confirmTrade).toEqual({ tradeId: id, partners: [1] });
  });
});
