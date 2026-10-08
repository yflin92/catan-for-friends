import { describe, expect, it } from 'vitest';
import type { Action } from '../events';
import type { EdgeId, Seat } from '../ids';
import { legalActions } from '../legal-actions';
import { reduce } from '../reduce';
import { RESOURCES, type GameState } from '../state';
import { buildState, enumerateLegalActions, validateInvariants, type StateSpec } from '../testing';
import { STANDARD_TOPOLOGY } from '../topology';
import { maritimeRatio } from './maritime';

// DEFAULT_TEST_BOARD harbors: e:0,-2,NW generic · e:1,-2,NE grain · e:-2,0,NW lumber (among others).
const harborVertex = (edge: EdgeId, i: 0 | 1 = 0) => STANDARD_TOPOLOGY.edgeVertices(edge)[i];
const GENERIC = harborVertex('e:0,-2,NW');
const GRAIN = harborVertex('e:1,-2,NE');
const main = (spec: StateSpec = {}) => buildState({ phase: { name: 'main' }, ...spec });
const trade = (s: GameState, by: Seat, action: Omit<Extract<Action, { type: 'maritimeTrade' }>, 'type'>) =>
  reduce(s, { by, action: { type: 'maritimeTrade', ...action } });

describe('maritimeRatio (R13)', () => {
  it('is 4 without a harbor', () => {
    const s = main();
    for (const r of RESOURCES) expect(maritimeRatio(s, 0, r)).toBe(4);
  });

  it('is 3 with a generic harbor, from a building on either vertex', () => {
    for (const i of [0, 1] as const) {
      const s = main({ pieces: [{ seat: 0, settlements: [harborVertex('e:0,-2,NW', i)] }] });
      for (const r of RESOURCES) expect(maritimeRatio(s, 0, r)).toBe(3);
    }
  });

  it('is 2 for the harbor resource only; others stay 4 without a generic harbor', () => {
    const s = main({ pieces: [{ seat: 0, settlements: [GRAIN] }] });
    expect(maritimeRatio(s, 0, 'grain')).toBe(2);
    expect(maritimeRatio(s, 0, 'ore')).toBe(4);
  });

  it('applies only the give resource’s 2:1 harbor: another resource’s 2:1 harbor does not lower the rate (D14)', () => {
    const s = main({ pieces: [{ seat: 0, settlements: [GRAIN] }], hands: { 0: { ore: 3, grain: 2 } } });
    expect(trade(s, 0, { give: 'ore', receive: 'wool', count: 1 })).toEqual({ ok: false, reason: 'invalid_trade' });
    expect(trade(s, 0, { give: 'grain', receive: 'wool', count: 1 }).ok).toBe(true);
  });

  it('takes the best rate across harbors, counts cities, and ignores other seats’ buildings', () => {
    const both = main({ pieces: [{ seat: 0, settlements: [GRAIN], cities: [GENERIC] }] });
    expect(maritimeRatio(both, 0, 'grain')).toBe(2);
    expect(maritimeRatio(both, 0, 'ore')).toBe(3);
    expect(maritimeRatio(both, 1, 'grain')).toBe(4);
  });
});

describe('maritimeTrade (AC16)', () => {
  it('pays count × ratio to the bank and receives count, logging maritimeTraded', () => {
    const s = main({ hands: { 0: { ore: 5 } } });
    const r = trade(s, 0, { give: 'ore', receive: 'wool', count: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.players[0]!.hand).toEqual({ brick: 0, lumber: 0, wool: 1, grain: 0, ore: 1 });
    expect(r.state.bank.ore).toBe(18);
    expect(r.state.bank.wool).toBe(18);
    expect(r.events).toEqual([{ kind: 'maritimeTraded', seat: 0, give: 'ore', gave: 4, receive: 'wool', received: 1 }]);
    expect(validateInvariants(r.state)).toEqual([]);
  });

  it('trades several units at a 2:1 harbor rate', () => {
    const s = main({ pieces: [{ seat: 0, settlements: [GRAIN] }], hands: { 0: { grain: 6 } } });
    const r = trade(s, 0, { give: 'grain', receive: 'brick', count: 3 });
    expect(r.ok && r.state.players[0]!.hand).toEqual({ brick: 3, lumber: 0, wool: 0, grain: 0, ore: 0 });
  });

  it.each([
    ['give = receive', { give: 'ore', receive: 'ore', count: 1 }],
    ['count 0', { give: 'ore', receive: 'wool', count: 0 }],
    ['negative count', { give: 'ore', receive: 'wool', count: -1 }],
    ['give not held at the ratio', { give: 'ore', receive: 'wool', count: 2 }],
  ] as const)('rejects %s with invalid_trade', (_name, action) => {
    expect(trade(main({ hands: { 0: { ore: 5 } } }), 0, action)).toEqual({ ok: false, reason: 'invalid_trade' });
  });

  it.each([
    ['fractional count', 0.5],
    ['fractional count above 1', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('rejects a non-integer count (%s) with malformed_action (D14)', (_name, count) => {
    expect(trade(main({ hands: { 0: { ore: 8 } } }), 0, { give: 'ore', receive: 'wool', count })).toEqual({
      ok: false,
      reason: 'malformed_action',
    });
  });

  it('rejects with bank_insufficient when the bank lacks the received resource', () => {
    const s = main({ hands: { 0: { ore: 4 }, 1: { wool: 19 } } });
    expect(trade(s, 0, { give: 'ore', receive: 'wool', count: 1 })).toEqual({ ok: false, reason: 'bank_insufficient' });
  });

  it('checks the hand before the bank', () => {
    const s = main({ hands: { 0: { ore: 3 }, 1: { wool: 19 } } });
    expect(trade(s, 0, { give: 'ore', receive: 'wool', count: 1 })).toEqual({ ok: false, reason: 'invalid_trade' });
  });

  it('is only for the active seat in main', () => {
    const s = main({ hands: { 0: { ore: 4 }, 1: { ore: 4 } } });
    expect(trade(s, 1, { give: 'ore', receive: 'wool', count: 1 })).toEqual({ ok: false, reason: 'not_your_turn' });
    const pre = buildState({ phase: { name: 'preRoll' }, hands: { 0: { ore: 4 } } });
    expect(trade(pre, 0, { give: 'ore', receive: 'wool', count: 1 })).toEqual({ ok: false, reason: 'wrong_phase' });
  });
});

describe('legal.maritime and legal.bankStock', () => {
  it('lists each give-resource the hand covers at its ratio, for the active seat in main only', () => {
    const s = main({ pieces: [{ seat: 0, settlements: [GRAIN] }], hands: { 0: { grain: 2, ore: 4, wool: 3 }, 1: { ore: 9 } } });
    expect(legalActions(s, 0).maritime).toEqual({ grain: 2, ore: 4 });
    expect(legalActions(s, 0).bankStock).toEqual(s.bank);
    expect(legalActions(s, 1).maritime).toEqual({});
    expect(legalActions(buildState({ phase: { name: 'preRoll' }, hands: { 0: { ore: 4 } } }), 0).maritime).toEqual({});
  });

  it('every enumerated maritime action is accepted, and every give-resource left out is rejected', () => {
    const s = main({
      pieces: [{ seat: 0, settlements: [GRAIN], cities: [GENERIC] }],
      hands: { 0: { grain: 4, ore: 7, wool: 2, brick: 1 }, 2: { lumber: 18 } },
    });
    const listed = enumerateLegalActions(s, 0).filter((a) => a.type === 'maritimeTrade');
    expect(listed.length).toBeGreaterThan(0);
    for (const action of listed) expect(reduce(s, { by: 0, action }).ok, JSON.stringify(action)).toBe(true);
    const offered = legalActions(s, 0).maritime;
    for (const give of RESOURCES.filter((r) => offered[r] === undefined)) {
      const receive = give === 'grain' ? 'ore' : 'grain';
      expect(trade(s, 0, { give, receive, count: 1 }).ok).toBe(false);
    }
    // lumber: the bank holds only 1, so count 2 of lumber is never listed and is rejected.
    expect(listed.some((a) => a.type === 'maritimeTrade' && a.receive === 'lumber' && a.count === 2)).toBe(false);
    expect(trade(s, 0, { give: 'grain', receive: 'lumber', count: 2 })).toEqual({ ok: false, reason: 'bank_insufficient' });
  });
});
