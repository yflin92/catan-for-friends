// Setup snake draft (R4, design §6 Setup, §6.1 setup rows). Seats place in order 0..n-1 (round 1), then n-1..0
// (round 2); each placement is a settlement followed by a road touching that settlement. The round-2 settlement pays
// one resource per adjacent non-desert hex. After the last road, seat 0 begins turn 1.
import type { EdgeId, Seat, VertexId } from '../ids';
import { beginTurn, setPhase } from '../internal/turn';
import { emit } from '../log';
import { recomputeLongestRoad } from '../longest-road';
import type { GameState, Resource, ResourceCounts } from '../state';
import { TERRAIN_YIELD } from '../state';
import { STANDARD_TOPOLOGY } from '../topology';
import { roadSiteIssue, settlementSiteIssue } from './placement';
import type { HandlerResult } from './types';

const ZERO: ResourceCounts = { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 };

/** Resources the round-2 settlement on `v` earns: one per adjacent non-desert hex, limited by what the bank holds. */
function setupYield(state: GameState, v: VertexId): ResourceCounts {
  const gained: Record<Resource, number> = { ...ZERO };
  for (const hexId of STANDARD_TOPOLOGY.vertexHexes(v)) {
    const hex = state.board.hexes.find((h) => h.id === hexId);
    if (hex === undefined || hex.terrain === 'desert') continue;
    const r = TERRAIN_YIELD[hex.terrain];
    if (gained[r] < state.bank[r]) gained[r] += 1;
  }
  return gained;
}

function addCounts(a: ResourceCounts, b: ResourceCounts, sign: 1 | -1): ResourceCounts {
  return {
    brick: a.brick + sign * b.brick,
    lumber: a.lumber + sign * b.lumber,
    wool: a.wool + sign * b.wool,
    grain: a.grain + sign * b.grain,
    ore: a.ore + sign * b.ore,
  };
}

/** placeSettlement during setupSettlement (R4, R5; no connectivity requirement). */
export function placeSetupSettlement(state: GameState, seat: Seat, v: VertexId): HandlerResult {
  if (state.phase.name !== 'setupSettlement') return { ok: false, reason: 'wrong_phase' };
  const round = state.phase.round;
  const issue = settlementSiteIssue(state, v);
  if (issue !== null) return { ok: false, reason: issue };

  const player = state.players[seat];
  if (player === undefined) return { ok: false, reason: 'internal_error' };
  let s: GameState = {
    ...state,
    pieces: { ...state.pieces, settlements: { ...state.pieces.settlements, [v]: seat } },
    players: state.players.map((p, i) =>
      i === seat ? { ...p, supply: { ...p.supply, settlements: p.supply.settlements - 1 } } : p,
    ),
  };
  s = emit(s, { kind: 'built', seat, piece: 'settlement', at: v, free: true });

  if (round === 2) {
    const gained = setupYield(s, v);
    s = {
      ...s,
      bank: addCounts(s.bank, gained, -1),
      players: s.players.map((p, i) => (i === seat ? { ...p, hand: addCounts(p.hand, gained, 1) } : p)),
    };
    s = emit(s, { kind: 'setupResources', seat, gained });
  }
  s = recomputeLongestRoad(s);
  return { ok: true, state: setPhase(s, { name: 'setupRoad', round, from: v }) };
}

/** placeRoad during setupRoad: the road must touch the settlement just placed (R4). Advances the snake. */
export function placeSetupRoad(state: GameState, seat: Seat, e: EdgeId): HandlerResult {
  if (state.phase.name !== 'setupRoad') return { ok: false, reason: 'wrong_phase' };
  const { round, from } = state.phase;
  const issue = roadSiteIssue(state, seat, e, from);
  if (issue !== null) return { ok: false, reason: issue };

  let s: GameState = {
    ...state,
    pieces: { ...state.pieces, roads: { ...state.pieces.roads, [e]: seat } },
    players: state.players.map((p, i) => (i === seat ? { ...p, supply: { ...p.supply, roads: p.supply.roads - 1 } } : p)),
  };
  s = emit(s, { kind: 'built', seat, piece: 'road', at: e, free: true });
  s = recomputeLongestRoad(s);

  const last = (s.playerCount - 1) as Seat;
  if (round === 1 && seat < last) return { ok: true, state: nextSetupTurn(s, (seat + 1) as Seat, 1) };
  if (round === 1) return { ok: true, state: nextSetupTurn(s, last, 2) };
  if (seat > 0) return { ok: true, state: nextSetupTurn(s, (seat - 1) as Seat, 2) };
  return { ok: true, state: beginTurn(s, 0) };
}

function nextSetupTurn(state: GameState, seat: Seat, round: 1 | 2): GameState {
  return setPhase({ ...state, turn: { ...state.turn, active: seat } }, { name: 'setupSettlement', round });
}
