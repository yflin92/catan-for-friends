// Progress cards (R10; design §6 Dev cards, §6.1 roadBuilding row; AC14): Road Building, Year of Plenty and Monopoly.
// Each play first passes the shared card rules (devPlayIssue: ownership → bought this turn → already played) and only
// then its own effect checks. Phase changes go through setPhase, so leaving main withdraws any open offer.
import type { EdgeId, Seat } from '../ids';
import { setPhase } from '../internal/turn';
import { emit } from '../log';
import { recomputeLongestRoad } from '../longest-road';
import type { EngineReasonCode } from '../reasons';
import { RESOURCES, type GameState, type Resource, type ResourceCounts } from '../state';
import { STANDARD_TOPOLOGY as T } from '../topology';
import { devPlayIssue, spendDevCard } from './dev';
import { roadSiteIssue } from './placement';
import type { HandlerResult, LegalSlice } from './types';

/** Why `seat` cannot place a free Road Building road on `e`: location → occupancy → connectivity → pieces. */
export function freeRoadIssue(state: GameState, seat: Seat, e: EdgeId): EngineReasonCode | null {
  return roadSiteIssue(state, seat, e) ?? ((state.players[seat]?.supply.roads ?? 0) <= 0 ? 'no_pieces_left' : null);
}

/** Edges where `seat` may place a free road now, in canonical edge order. */
export function freeRoadSites(state: GameState, seat: Seat): readonly EdgeId[] {
  return T.edges.filter((e) => freeRoadIssue(state, seat, e) === null);
}

type Resume = 'preRoll' | 'main';

/**
 * Continues a Road Building with `remaining` free roads: when none remain, or no free road can be placed, the phase
 * returns to `resume`; otherwise it is roadBuilding{remaining, resume}.
 */
function continueRoadBuilding(state: GameState, seat: Seat, remaining: number, resume: Resume): GameState {
  if (remaining <= 0 || freeRoadSites(state, seat).length === 0) return setPhase(state, { name: resume });
  return setPhase(state, { name: 'roadBuilding', remaining: remaining >= 2 ? 2 : 1, resume });
}

/**
 * playRoadBuilding: the card is spent and the phase becomes roadBuilding{remaining: min(2, supply.roads), resume}. With
 * 0 roads in supply, or no legal edge, the card resolves at once with 0 roads and the phase does not change.
 */
export function playRoadBuilding(state: GameState, seat: Seat): HandlerResult {
  const issue = devPlayIssue(state, seat, 'roadBuilding');
  if (issue !== null) return { ok: false, reason: issue };
  const resume: Resume = state.phase.name === 'preRoll' ? 'preRoll' : 'main';
  let s = spendDevCard(state, seat, 'roadBuilding');
  s = emit(s, { kind: 'devPlayed', seat, card: 'roadBuilding' });
  const roads = Math.min(2, s.players[seat]!.supply.roads);
  if (roads === 0 || freeRoadSites(s, seat).length === 0) return { ok: true, state: s };
  return { ok: true, state: continueRoadBuilding(s, seat, roads, resume) };
}

/** placeRoad in roadBuilding: a free road (built free:true), then the phase continues or resumes. */
export function placeFreeRoad(state: GameState, seat: Seat, e: EdgeId): HandlerResult {
  if (state.phase.name !== 'roadBuilding') return { ok: false, reason: 'wrong_phase' };
  const { remaining, resume } = state.phase;
  const issue = freeRoadIssue(state, seat, e);
  if (issue !== null) return { ok: false, reason: issue };
  let s: GameState = {
    ...state,
    pieces: { ...state.pieces, roads: { ...state.pieces.roads, [e]: seat } },
    players: state.players.map((p, i) => (i === seat ? { ...p, supply: { ...p.supply, roads: p.supply.roads - 1 } } : p)),
  };
  s = emit(s, { kind: 'built', seat, piece: 'road', at: e, free: true });
  s = recomputeLongestRoad(s);
  return { ok: true, state: continueRoadBuilding(s, seat, remaining - 1, resume) };
}

const take2 = (picks: readonly [Resource, Resource]): ResourceCounts => {
  const out: Record<Resource, number> = { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 };
  for (const r of picks) out[r] += 1;
  return out;
};

/** playYearOfPlenty{take: [R1, R2]}: two cards from the bank (possibly the same resource), else bank_insufficient. */
export function playYearOfPlenty(state: GameState, seat: Seat, picks: readonly [Resource, Resource]): HandlerResult {
  const issue = devPlayIssue(state, seat, 'yearOfPlenty');
  if (issue !== null) return { ok: false, reason: issue };
  const want = take2(picks);
  if (RESOURCES.some((r) => state.bank[r] < want[r])) return { ok: false, reason: 'bank_insufficient' };
  let s = spendDevCard(state, seat, 'yearOfPlenty');
  const bank = { ...s.bank };
  for (const r of RESOURCES) bank[r] -= want[r];
  s = {
    ...s,
    bank,
    players: s.players.map((p, i) => {
      if (i !== seat) return p;
      const hand = { ...p.hand };
      for (const r of RESOURCES) hand[r] += want[r];
      return { ...p, hand };
    }),
  };
  return { ok: true, state: emit(s, { kind: 'devPlayed', seat, card: 'yearOfPlenty', picks: [picks[0], picks[1]] }) };
}

/** playMonopoly{resource}: every other seat gives all of `resource`; the amounts are public (devPlayed.taken[seat]). */
export function playMonopoly(state: GameState, seat: Seat, resource: Resource): HandlerResult {
  const issue = devPlayIssue(state, seat, 'monopoly');
  if (issue !== null) return { ok: false, reason: issue };
  let s = spendDevCard(state, seat, 'monopoly');
  const taken = s.players.map((p, i) => (i === seat ? 0 : p.hand[resource]));
  const total = taken.reduce((a, b) => a + b, 0);
  s = {
    ...s,
    players: s.players.map((p, i) => ({
      ...p,
      hand: { ...p.hand, [resource]: i === seat ? p.hand[resource] + total : 0 },
    })),
  };
  return { ok: true, state: emit(s, { kind: 'devPlayed', seat, card: 'monopoly', picks: [resource], taken }) };
}

/** Year of Plenty pairs in canonical order (R1 ≤ R2 in RESOURCES order). */
const PAIRS: readonly (readonly [Resource, Resource])[] = RESOURCES.flatMap((a, i) =>
  RESOURCES.slice(i).map((b) => [a, b] as const),
);

/**
 * Legal progress-card plays for the active seat in preRoll or main (each card's devPlayIssue must be null;
 * playYearOfPlenty lists only the pairs the bank can pay), and legal.placeRoad in roadBuilding (the free road sites).
 */
export const progressSlice: LegalSlice = (state, seat) => {
  if (seat !== state.turn.active) return {};
  const phase = state.phase.name;
  if (phase === 'roadBuilding') return { placeRoad: freeRoadSites(state, seat) };
  if (phase !== 'preRoll' && phase !== 'main') return {};
  const yop = devPlayIssue(state, seat, 'yearOfPlenty') === null;
  return {
    playRoadBuilding: devPlayIssue(state, seat, 'roadBuilding') === null,
    playMonopoly: devPlayIssue(state, seat, 'monopoly') === null,
    playYearOfPlenty: yop ? PAIRS.filter((pair) => RESOURCES.every((r) => state.bank[r] >= take2(pair)[r])) : [],
  };
};
