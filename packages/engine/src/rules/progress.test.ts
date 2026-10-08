import { describe, expect, it } from 'vitest';
import type { Action, GameEvent } from '../events';
import type { EdgeId, Seat, VertexId } from '../ids';
import { legalActions } from '../legal-actions';
import { reduce } from '../reduce';
import type { DevCardKind, GameState, TradeOffer } from '../state';
import { buildState, enumerateLegalActions, validateInvariants, type StateSpec } from '../testing';
import { STANDARD_TOPOLOGY as T } from '../topology';
import { freeRoadSites } from './progress';

const card = (kind: DevCardKind, boughtOnTurn = 0) => ({ kind, boughtOnTurn });
const play = (s: GameState, by: Seat, action: Action) => reduce(s, { by, action });
const ok = (r: ReturnType<typeof reduce>) => {
  if (!r.ok) throw new Error(`rejected: ${r.reason}`);
  return r;
};
const devPlayed = (events: readonly GameEvent[]) => events.filter((e) => e.kind === 'devPlayed');

// Seat 0 holds a settlement with two roads leading out of it.
const SETTLEMENT: VertexId = 'v:0,0,N';
const [E1, E2] = T.vertexEdges(SETTLEMENT) as [EdgeId, EdgeId];

function withCards(spec: StateSpec, cards: readonly DevCardKind[], phase: StateSpec['phase'] = { name: 'main' }): GameState {
  return buildState({
    pieces: [{ seat: 0, settlements: [SETTLEMENT], roads: [E1] }],
    devCards: { 0: cards.map((k) => card(k)) },
    turn: { number: 3 },
    phase,
    ...spec,
  });
}

describe('playRoadBuilding (AC14)', () => {
  it('spends the card and enters roadBuilding{2, main}; two free roads follow, then main resumes', () => {
    const s = withCards({}, ['roadBuilding']);
    const r = ok(play(s, 0, { type: 'playRoadBuilding' }));
    expect(r.state.phase).toEqual({ name: 'roadBuilding', remaining: 2, resume: 'main' });
    expect(r.state.players[0]!.devCards).toEqual([]);
    expect(r.state.players[0]!.playedDev.roadBuilding).toBe(1);
    expect(r.state.turn.devPlayed).toBe(true);
    expect(devPlayed(r.events)).toEqual([{ kind: 'devPlayed', seat: 0, card: 'roadBuilding' }]);

    const legal = legalActions(r.state, 0);
    expect(legal.placeRoad).toEqual(freeRoadSites(r.state, 0));
    expect(legal.endTurn).toBe(false);
    const first = ok(play(r.state, 0, { type: 'placeRoad', edge: legal.placeRoad[0]! }));
    expect(first.events).toContainEqual({ kind: 'built', seat: 0, piece: 'road', at: legal.placeRoad[0], free: true });
    expect(first.state.phase).toEqual({ name: 'roadBuilding', remaining: 1, resume: 'main' });
    const second = ok(play(first.state, 0, { type: 'placeRoad', edge: legalActions(first.state, 0).placeRoad[0]! }));
    expect(second.state.phase).toEqual({ name: 'main' });
    expect(second.state.players[0]!.hand).toEqual(s.players[0]!.hand);
    expect(second.state.players[0]!.supply.roads).toBe(s.players[0]!.supply.roads - 2);
    expect(validateInvariants(second.state)).toEqual([]);
  });

  it('resumes preRoll when played before rolling', () => {
    const s = withCards({}, ['roadBuilding'], { name: 'preRoll' });
    const r = ok(play(s, 0, { type: 'playRoadBuilding' }));
    expect(r.state.phase).toEqual({ name: 'roadBuilding', remaining: 2, resume: 'preRoll' });
    let t = r.state;
    for (let i = 0; i < 2; i++) t = ok(play(t, 0, { type: 'placeRoad', edge: legalActions(t, 0).placeRoad[0]! })).state;
    expect(t.phase).toEqual({ name: 'preRoll' });
    expect(legalActions(t, 0).rollDice).toBe(true);
  });

  it('with 1 road left in supply: remaining = 1', () => {
    const roads = T.edges.filter((e) => e !== E1 && e !== E2 && !T.edgeVertices(e).includes(SETTLEMENT)).slice(0, 13);
    const s = withCards({ pieces: [{ seat: 0, settlements: [SETTLEMENT], roads: [E1, ...roads] }] }, ['roadBuilding']);
    expect(s.players[0]!.supply.roads).toBe(1);
    const r = ok(play(s, 0, { type: 'playRoadBuilding' }));
    expect(r.state.phase).toEqual({ name: 'roadBuilding', remaining: 1, resume: 'main' });
    const placed = ok(play(r.state, 0, { type: 'placeRoad', edge: legalActions(r.state, 0).placeRoad[0]! }));
    expect(placed.state.phase).toEqual({ name: 'main' });
    expect(placed.state.players[0]!.supply.roads).toBe(0);
  });

  it('with 0 roads in supply: the card resolves at once with 0 roads and the phase stays', () => {
    const roads = T.edges.filter((e) => !T.edgeVertices(e).includes(SETTLEMENT)).slice(0, 15);
    const s = withCards({ pieces: [{ seat: 0, settlements: [SETTLEMENT], roads }] }, ['roadBuilding']);
    expect(s.players[0]!.supply.roads).toBe(0);
    const r = ok(play(s, 0, { type: 'playRoadBuilding' }));
    expect(r.state.phase).toEqual({ name: 'main' });
    expect(r.state.players[0]!.playedDev.roadBuilding).toBe(1);
    expect(r.state.turn.devPlayed).toBe(true);
  });

  it('with no legal edge: the card resolves at once with 0 roads', () => {
    const s = withCards({ pieces: [] }, ['roadBuilding']);
    expect(freeRoadSites(s, 0)).toEqual([]);
    const r = ok(play(s, 0, { type: 'playRoadBuilding' }));
    expect(r.state.phase).toEqual({ name: 'main' });
    expect(r.state.players[0]!.devCards).toEqual([]);
  });

  it('ends early when no legal edge remains after the first free road', () => {
    // A coastal corner with exactly two edges: one leads out (A), the other is taken by seat 1. Every edge beyond A's far
    // end is taken by seat 1 too, so after A no free road can be placed.
    const corner = T.vertices.find((v) => T.vertexHexes(v).length === 1 && T.vertexEdges(v).length === 2)!;
    const [a, b] = T.vertexEdges(corner) as [EdgeId, EdgeId];
    const far = T.edgeVertices(a).find((v) => v !== corner)!;
    const blocked = [b, ...T.vertexEdges(far).filter((e) => e !== a)];
    const s = buildState({
      pieces: [{ seat: 0, settlements: [corner] }, { seat: 1, roads: blocked }],
      devCards: { 0: [card('roadBuilding')] },
      turn: { number: 3 },
    });
    expect(freeRoadSites(s, 0)).toEqual([a]);
    const r = ok(play(s, 0, { type: 'playRoadBuilding' }));
    expect(r.state.phase).toEqual({ name: 'roadBuilding', remaining: 2, resume: 'main' });
    const placed = ok(play(r.state, 0, { type: 'placeRoad', edge: a }));
    expect(placed.state.phase).toEqual({ name: 'main' });
  });

  it('leaving main withdraws an open offer (onPhaseExit)', () => {
    const offer: TradeOffer = {
      id: 1, from: 0, give: { brick: 1, lumber: 0, wool: 0, grain: 0, ore: 0 }, get: { brick: 0, lumber: 0, wool: 1, grain: 0, ore: 0 },
      responses: ['self', 'pending', 'pending', 'pending'],
    };
    const s = withCards({ hands: { 0: { brick: 1 } }, trade: offer }, ['roadBuilding']);
    const r = ok(play(s, 0, { type: 'playRoadBuilding' }));
    expect(r.state.trade).toBeNull();
    expect(r.events).toContainEqual({ kind: 'tradeResolved', tradeId: 1, outcome: 'withdrawn', partner: null, exitTo: 'roadBuilding' });
  });

  it('rejects bad free roads and other actions during roadBuilding', () => {
    const r = ok(play(withCards({}, ['roadBuilding']), 0, { type: 'playRoadBuilding' }));
    expect(play(r.state, 0, { type: 'placeRoad', edge: E1 })).toEqual({ ok: false, reason: 'occupied' });
    const far = T.edges.find((e) => !freeRoadSites(r.state, 0).includes(e) && r.state.pieces.roads[e] === undefined)!;
    expect(play(r.state, 0, { type: 'placeRoad', edge: far })).toEqual({ ok: false, reason: 'not_connected' });
    expect(play(r.state, 0, { type: 'endTurn' })).toEqual({ ok: false, reason: 'wrong_phase' });
    expect(play(r.state, 1, { type: 'placeRoad', edge: E2 })).toEqual({ ok: false, reason: 'not_your_turn' });
  });
});

describe('playYearOfPlenty (AC14)', () => {
  it('takes any two from the bank, including two of one resource', () => {
    const s = withCards({}, ['yearOfPlenty']);
    const r = ok(play(s, 0, { type: 'playYearOfPlenty', take: ['ore', 'wool'] }));
    expect(r.state.players[0]!.hand).toMatchObject({ ore: 1, wool: 1 });
    expect(r.state.bank).toMatchObject({ ore: 18, wool: 18 });
    expect(devPlayed(r.events)).toEqual([{ kind: 'devPlayed', seat: 0, card: 'yearOfPlenty', picks: ['ore', 'wool'] }]);
    const same = ok(play(s, 0, { type: 'playYearOfPlenty', take: ['grain', 'grain'] }));
    expect(same.state.players[0]!.hand.grain).toBe(2);
    expect(validateInvariants(same.state)).toEqual([]);
  });

  it('is limited by the bank: bank_insufficient, and legal lists only payable pairs', () => {
    const s = withCards({ hands: { 1: { grain: 18 }, 2: { ore: 19 } } }, ['yearOfPlenty']);
    expect(play(s, 0, { type: 'playYearOfPlenty', take: ['grain', 'grain'] })).toEqual({ ok: false, reason: 'bank_insufficient' });
    expect(play(s, 0, { type: 'playYearOfPlenty', take: ['ore', 'wool'] })).toEqual({ ok: false, reason: 'bank_insufficient' });
    const pairs = legalActions(s, 0).playYearOfPlenty;
    expect(pairs).toContainEqual(['wool', 'grain']); // pairs are in canonical resource order
    expect(pairs).not.toContainEqual(['grain', 'grain']);
    expect(pairs.some((p) => p.includes('ore'))).toBe(false);
    expect(pairs).toHaveLength(15 - 5 - 1); // 15 pairs, minus the 5 with ore, minus grain+grain
    for (const take of pairs) expect(play(s, 0, { type: 'playYearOfPlenty', take }).ok).toBe(true);
  });

  it('D17: card rules come before the bank check', () => {
    const noCard = withCards({ hands: { 1: { grain: 19 } } }, []);
    expect(play(noCard, 0, { type: 'playYearOfPlenty', take: ['grain', 'grain'] })).toEqual({ ok: false, reason: 'dev_card_not_owned' });
    const fresh = buildState({ devCards: { 0: [card('yearOfPlenty', 3)] }, turn: { number: 3 }, hands: { 1: { grain: 19 } } });
    expect(play(fresh, 0, { type: 'playYearOfPlenty', take: ['grain', 'grain'] })).toEqual({ ok: false, reason: 'dev_card_bought_this_turn' });
    const played = buildState({ devCards: { 0: [card('yearOfPlenty')] }, turn: { number: 3, devPlayed: true }, hands: { 1: { grain: 19 } } });
    expect(play(played, 0, { type: 'playYearOfPlenty', take: ['grain', 'grain'] })).toEqual({ ok: false, reason: 'dev_card_already_played' });
    expect(legalActions(played, 0).playYearOfPlenty).toEqual([]);
  });
});

describe('playMonopoly (AC14)', () => {
  it('takes all of the resource from every other seat; the amounts are public in devPlayed.taken', () => {
    const s = withCards({ hands: { 0: { wool: 1 }, 1: { wool: 3, ore: 2 }, 2: { wool: 0 }, 3: { wool: 5 } } }, ['monopoly']);
    const r = ok(play(s, 0, { type: 'playMonopoly', resource: 'wool' }));
    expect(r.state.players.map((p) => p.hand.wool)).toEqual([9, 0, 0, 0]);
    expect(r.state.players[1]!.hand.ore).toBe(2);
    expect(r.state.bank).toEqual(s.bank);
    expect(devPlayed(r.events)).toEqual([{ kind: 'devPlayed', seat: 0, card: 'monopoly', picks: ['wool'], taken: [0, 3, 0, 5] }]);
    expect(r.state.log.at(-1)?.visibleTo).toBe('all');
    expect(validateInvariants(r.state)).toEqual([]);
  });

  it('works when nobody holds the resource', () => {
    const r = ok(play(withCards({}, ['monopoly']), 0, { type: 'playMonopoly', resource: 'ore' }));
    expect(devPlayed(r.events)[0]).toMatchObject({ taken: [0, 0, 0, 0] });
  });
});

describe('legal progress-card plays ⇔ reduce (V11)', () => {
  it('legal.playRoadBuilding / playMonopoly follow devPlayIssue, for the active seat in preRoll or main only', () => {
    const s = withCards({}, ['roadBuilding', 'monopoly', 'yearOfPlenty']);
    expect(legalActions(s, 0)).toMatchObject({ playRoadBuilding: true, playMonopoly: true });
    expect(legalActions(s, 1)).toMatchObject({ playRoadBuilding: false, playMonopoly: false, playYearOfPlenty: [] });
    const bought = buildState({ devCards: { 0: [card('roadBuilding', 3), card('monopoly', 3)] }, turn: { number: 3 } });
    expect(legalActions(bought, 0)).toMatchObject({ playRoadBuilding: false, playMonopoly: false });
    // D17: an older copy of the kind makes it playable even when another copy was bought this turn.
    const mixed = buildState({ devCards: { 0: [card('monopoly', 3), card('monopoly', 1)] }, turn: { number: 3 } });
    expect(legalActions(mixed, 0).playMonopoly).toBe(true);
    const r = ok(play(mixed, 0, { type: 'playMonopoly', resource: 'brick' }));
    expect(r.state.players[0]!.devCards).toEqual([card('monopoly', 3)]);
  });

  it('every enumerated action is accepted by reduce, in main, preRoll and roadBuilding', () => {
    const states = [
      withCards({ hands: { 1: { grain: 18 } } }, ['roadBuilding', 'yearOfPlenty', 'monopoly']),
      withCards({}, ['roadBuilding', 'yearOfPlenty', 'monopoly'], { name: 'preRoll' }),
    ];
    states.push(ok(play(states[0]!, 0, { type: 'playRoadBuilding' })).state);
    for (const s of states) {
      for (const action of enumerateLegalActions(s, 0)) {
        expect(play(s, 0, action).ok, `${s.phase.name}: ${JSON.stringify(action)}`).toBe(true);
      }
    }
  });
});
