// Main-phase builds (R3, R5, R6; AC6, AC8). Rejections follow design §3.8: location → occupancy → distance →
// connectivity → pieces → resources.
import { COSTS, covers, payToBank } from '../costs';
import type { EdgeId, Seat, VertexId } from '../ids';
import { emit } from '../log';
import { recomputeLongestRoad } from '../longest-road';
import type { EngineReasonCode } from '../reasons';
import type { GameState } from '../state';
import { isVertexId } from '../topology';
import { roadSiteIssue, settlementSiteIssue } from './placement';
import type { HandlerResult } from './types';

type Issue = EngineReasonCode | null;

const playerOf = (state: GameState, seat: Seat) => {
  const p = state.players[seat];
  if (p === undefined) throw new Error(`no player for seat ${seat}`);
  return p;
};

/** Why `seat` cannot build a road on `e` now, or null. */
export function mainRoadIssue(state: GameState, seat: Seat, e: EdgeId): Issue {
  const p = playerOf(state, seat);
  return roadSiteIssue(state, seat, e) ?? (p.supply.roads <= 0 ? 'no_pieces_left' : null) ??
    (covers(p.hand, COSTS.road) ? null : 'insufficient_resources');
}

/** Why `seat` cannot build a settlement on `v` now, or null. */
export function mainSettlementIssue(state: GameState, seat: Seat, v: VertexId): Issue {
  const p = playerOf(state, seat);
  return settlementSiteIssue(state, v, seat) ?? (p.supply.settlements <= 0 ? 'no_pieces_left' : null) ??
    (covers(p.hand, COSTS.settlement) ? null : 'insufficient_resources');
}

/** Why `seat` cannot upgrade `v` to a city now, or null. Only the seat's own settlement is a valid location. */
export function cityIssue(state: GameState, seat: Seat, v: VertexId): Issue {
  const p = playerOf(state, seat);
  if (!isVertexId(v) || state.pieces.settlements[v] !== seat) return 'invalid_location';
  if (p.supply.cities <= 0) return 'no_pieces_left';
  return covers(p.hand, COSTS.city) ? null : 'insufficient_resources';
}

export function buildRoad(state: GameState, seat: Seat, e: EdgeId): HandlerResult {
  const issue = mainRoadIssue(state, seat, e);
  if (issue !== null) return { ok: false, reason: issue };
  let s = payToBank(state, seat, COSTS.road);
  s = {
    ...s,
    pieces: { ...s.pieces, roads: { ...s.pieces.roads, [e]: seat } },
    players: s.players.map((p, i) => (i === seat ? { ...p, supply: { ...p.supply, roads: p.supply.roads - 1 } } : p)),
  };
  s = emit(s, { kind: 'built', seat, piece: 'road', at: e, free: false });
  return { ok: true, state: recomputeLongestRoad(s) };
}

export function buildSettlement(state: GameState, seat: Seat, v: VertexId): HandlerResult {
  const issue = mainSettlementIssue(state, seat, v);
  if (issue !== null) return { ok: false, reason: issue };
  let s = payToBank(state, seat, COSTS.settlement);
  s = {
    ...s,
    pieces: { ...s.pieces, settlements: { ...s.pieces.settlements, [v]: seat } },
    players: s.players.map((p, i) =>
      i === seat ? { ...p, supply: { ...p.supply, settlements: p.supply.settlements - 1 } } : p,
    ),
  };
  s = emit(s, { kind: 'built', seat, piece: 'settlement', at: v, free: false });
  return { ok: true, state: recomputeLongestRoad(s) };
}

/** Replaces the seat's settlement on `v` with a city; the settlement returns to supply. */
export function buildCityAt(state: GameState, seat: Seat, v: VertexId): HandlerResult {
  const issue = cityIssue(state, seat, v);
  if (issue !== null) return { ok: false, reason: issue };
  let s = payToBank(state, seat, COSTS.city);
  const settlements = { ...s.pieces.settlements };
  delete settlements[v];
  s = {
    ...s,
    pieces: { ...s.pieces, settlements, cities: { ...s.pieces.cities, [v]: seat } },
    players: s.players.map((p, i) =>
      i === seat
        ? { ...p, supply: { ...p.supply, settlements: p.supply.settlements + 1, cities: p.supply.cities - 1 } }
        : p,
    ),
  };
  return { ok: true, state: emit(s, { kind: 'built', seat, piece: 'city', at: v, free: false }) };
}
