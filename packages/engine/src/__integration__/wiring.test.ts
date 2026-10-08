// §6.2 wiring through reduce (E-INT): the open offer is withdrawn on every exit from main — endTurn, Knight, Road
// Building and a winning build — and checkVictory runs inside beginTurn (D3). Each case also passes the V39 step relation.
import { describe, expect, it } from 'vitest';
import type { Action, GameEvent } from '../events';
import type { VertexId } from '../ids';
import { reduce } from '../reduce';
import type { GameState, TradeOffer } from '../state';
import { buildState, validateInvariants, type StateSpec } from '../testing';
import { STANDARD_TOPOLOGY as T } from '../topology';
import { victoryPoints } from '../victory';
import { winnerIssues } from './oracle';
import { v39StateIssues, v39StepIssues } from './v39';

const one = { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 };
const OFFER: TradeOffer = {
  id: 7,
  from: 0,
  give: { ...one, wool: 1 },
  get: { ...one, ore: 1 },
  responses: ['self', 'accepted', 'pending', 'declined'],
};

/** `n` settlement sites far enough apart for the distance rule. */
function sites(n: number): VertexId[] {
  const out: VertexId[] = [];
  for (const v of T.vertices) {
    if (out.length === n) break;
    if (out.every((u) => u !== v && !T.vertexNeighbours(u).includes(v))) out.push(v);
  }
  return out;
}

function step(s: GameState, action: Action): { state: GameState; events: readonly GameEvent[] } {
  const cmd = { by: s.turn.active, action };
  const r = reduce(s, cmd);
  if (!r.ok) throw new Error(`${action.type} rejected: ${r.reason}`);
  expect(v39StepIssues(s, cmd, r.state)).toEqual([]);
  expect(v39StateIssues(r.state)).toEqual([]);
  expect(validateInvariants(r.state)).toEqual([]);
  expect(winnerIssues(r.state)).toEqual([]);
  return { state: r.state, events: r.events };
}

const withdrawn = (events: readonly GameEvent[]) =>
  events.filter((e) => e.kind === 'tradeResolved' && e.outcome === 'withdrawn').map((e) => e.kind === 'tradeResolved' && e.exitTo);

function withOffer(spec: StateSpec = {}): GameState {
  return buildState({
    hands: { 0: { wool: 1 }, 1: { ore: 1 } },
    devCards: { 0: [{ kind: 'knight', boughtOnTurn: 0 }, { kind: 'roadBuilding', boughtOnTurn: 0 }] },
    pieces: [{ seat: 0, settlements: ['v:0,0,N'], roads: [T.vertexEdges('v:0,0,N')[0]!] }],
    turn: { number: 3 },
    trade: OFFER,
    ...spec,
  });
}

describe('§6.2: leaving main withdraws the open offer (R13)', () => {
  it('endTurn → preRoll of the next seat', () => {
    const { state, events } = step(withOffer(), { type: 'endTurn' });
    expect(state.trade).toBeNull();
    expect(withdrawn(events)).toEqual(['preRoll']);
  });

  it('a Knight → moveRobber', () => {
    const { state, events } = step(withOffer(), { type: 'playKnight' });
    expect(state.phase).toEqual({ name: 'moveRobber', resume: 'main' });
    expect(state.trade).toBeNull();
    expect(withdrawn(events)).toEqual(['moveRobber']);
  });

  it('Road Building → roadBuilding', () => {
    const { state, events } = step(withOffer(), { type: 'playRoadBuilding' });
    expect(state.phase.name).toBe('roadBuilding');
    expect(state.trade).toBeNull();
    expect(withdrawn(events)).toEqual(['roadBuilding']);
  });

  it('a winning build → gameOver', () => {
    // Seat 0: 3 cities + 2 settlements + 1 hidden VP card = 9 VP; upgrading a settlement reaches the target 10.
    const [a, b, c, d, e] = sites(5) as [VertexId, VertexId, VertexId, VertexId, VertexId];
    const s = withOffer({
      pieces: [{ seat: 0, settlements: [d, e], cities: [a, b, c] }],
      hands: { 0: { wool: 1, grain: 2, ore: 3 }, 1: { ore: 1 } },
      devCards: { 0: [{ kind: 'victoryPoint', boughtOnTurn: 0 }] },
    });
    expect(victoryPoints(s, 0).total).toBe(9);
    const won = step(s, { type: 'buildCity', vertex: e });
    expect(won.state.phase).toEqual({ name: 'gameOver', winner: 0 });
    expect(won.state.trade).toBeNull();
    expect(withdrawn(won.events)).toEqual(['gameOver']);
  });
});

describe('§6.2: checkVictory runs inside beginTurn (D3)', () => {
  it('a seat at the target when its turn begins wins before preRoll accepts anything', () => {
    // Seat 1 holds 10 VP off-turn (hidden VP cards count for the win); seat 0 ends its turn.
    const [a, b, c, d] = sites(4) as [VertexId, VertexId, VertexId, VertexId];
    const s = buildState({
      pieces: [{ seat: 1, cities: [a, b, c, d] }],
      devCards: { 1: [{ kind: 'victoryPoint', boughtOnTurn: 0 }, { kind: 'victoryPoint', boughtOnTurn: 0 }] },
      turn: { number: 3, active: 0 },
    });
    expect(victoryPoints(s, 1).total).toBe(10);
    const { state } = step(s, { type: 'endTurn' });
    expect(state.turn.active).toBe(1);
    expect(state.phase).toEqual({ name: 'gameOver', winner: 1 });
    expect(reduce(state, { by: 1, action: { type: 'rollDice' } })).toEqual({ ok: false, reason: 'game_over' });
  });
});
