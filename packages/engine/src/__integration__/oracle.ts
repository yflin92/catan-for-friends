// Integration oracles (E-INT; verification plan V2–V4, V11, AC19): an exact "is this action described by the
// legal-actions descriptor" predicate, the gameOver winner assertion, and a generator of arbitrary (mostly illegal)
// actions. Test-only: used by the walker and the golden runner.
import type { Action, ActionType } from '../events';
import type { Seat } from '../ids';
import type { LegalActions } from '../legal';
import { RESOURCES, type GameState, type Resource, type ResourceCounts } from '../state';
import { STANDARD_TOPOLOGY as T } from '../topology';
import { victoryPoints } from '../victory';

const total = (c: ResourceCounts): number => RESOURCES.reduce((n, r) => n + c[r], 0);
const covers = (hand: ResourceCounts, c: ResourceCounts): boolean => RESOURCES.every((r) => hand[r] >= c[r]);
const multiset = (take: readonly Resource[]): string =>
  [...take].sort((a, b) => RESOURCES.indexOf(a) - RESOURCES.indexOf(b)).join();

/**
 * Whether `legal` (= legalActions(state, seat)) describes `action` (design §3.6, ADR-0003 rev 1.3). Exact for every
 * action except proposeTrade, whose descriptor is only the flag: for it this returns `legal.proposeTrade`, and callers
 * check only the direction "accepted ⇒ described". Year of Plenty takes match as multisets (D20).
 */
export function describes(state: GameState, seat: Seat, legal: LegalActions, action: Action): boolean {
  const hand = state.players[seat]!.hand;
  switch (action.type) {
    case 'placeSettlement':
      return legal.placeSettlement.includes(action.vertex);
    case 'placeRoad':
      return legal.placeRoad.includes(action.edge);
    case 'buildCity':
      return legal.buildCity.includes(action.vertex);
    case 'rollDice':
    case 'endTurn':
    case 'buyDevCard':
    case 'playKnight':
    case 'playRoadBuilding':
    case 'playMonopoly':
      return legal[action.type];
    case 'playYearOfPlenty':
      return legal.playYearOfPlenty.some((pair) => multiset(pair) === multiset(action.take));
    case 'discard':
      return legal.discard !== null && total(action.cards) === legal.discard.count && covers(hand, action.cards);
    case 'moveRobber': {
      const target = legal.moveRobber.find((t) => t.hex === action.hex);
      if (!target) return false;
      return action.victim === null ? target.victims.length === 0 : target.victims.includes(action.victim);
    }
    case 'maritimeTrade': {
      const ratio = legal.maritime[action.give];
      return (
        ratio !== undefined &&
        action.give !== action.receive &&
        action.count >= 1 &&
        hand[action.give] >= action.count * ratio &&
        legal.bankStock[action.receive] >= action.count
      );
    }
    case 'proposeTrade':
      return legal.proposeTrade;
    case 'respondTrade':
      return legal.respondTrade?.tradeId === action.tradeId && (!action.accept || legal.respondTrade.canAccept);
    case 'confirmTrade':
      return legal.confirmTrade?.tradeId === action.tradeId && legal.confirmTrade.partners.includes(action.partner);
    case 'cancelTrade':
      return legal.cancelTrade === action.tradeId;
  }
}

export interface WinnerIssue {
  readonly code: 'winner_not_active' | 'winner_below_target';
  readonly detail: string;
}

/**
 * The gameOver assertion for states reached through reduce (E-INT; R14, E-i): the winner is the active seat and holds
 * ≥ vpTarget victory points, hidden VP cards included. Deliberately not part of validateInvariants, because buildState
 * may construct a gameOver state directly.
 */
export function winnerIssues(state: GameState): readonly WinnerIssue[] {
  if (state.phase.name !== 'gameOver') return [];
  const { winner } = state.phase;
  const out: WinnerIssue[] = [];
  if (winner !== state.turn.active) out.push({ code: 'winner_not_active', detail: `winner ${winner}, active ${state.turn.active}` });
  const vp = victoryPoints(state, winner).total;
  if (vp < state.config.vpTarget) out.push({ code: 'winner_below_target', detail: `winner ${winner} has ${vp} < ${state.config.vpTarget}` });
  return out;
}

const ACTION_TYPES: readonly ActionType[] = [
  'placeSettlement', 'placeRoad', 'buildCity', 'rollDice', 'discard', 'moveRobber', 'buyDevCard', 'playKnight',
  'playRoadBuilding', 'playYearOfPlenty', 'playMonopoly', 'maritimeTrade', 'proposeTrade', 'respondTrade',
  'confirmTrade', 'cancelTrade', 'endTurn',
];

/**
 * A well-formed action of a uniformly chosen type with random parameters drawn near the current state (board ids,
 * small counts, trade ids around the next id), so most are illegal and some are legal. `rand` returns [0, 1).
 */
export function arbitraryAction(state: GameState, rand: () => number): Action {
  const pick = <X>(xs: readonly X[]): X => xs[Math.floor(rand() * xs.length)]!;
  const int = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));
  const res = (): Resource => pick(RESOURCES);
  const counts = (max: number): ResourceCounts => {
    const c: Record<Resource, number> = { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 };
    for (const r of RESOURCES) c[r] = rand() < 0.5 ? 0 : int(0, max);
    return c;
  };
  const seat = (): Seat => int(0, state.playerCount - 1) as Seat;
  const tradeId = (): number => Math.max(0, state.nextTradeId + int(-2, 1));
  const type = pick(ACTION_TYPES);
  switch (type) {
    case 'placeSettlement':
    case 'buildCity':
      return { type, vertex: pick(T.vertices) };
    case 'placeRoad':
      return { type, edge: pick(T.edges) };
    case 'discard':
      return { type, cards: counts(4) };
    case 'moveRobber':
      return { type, hex: pick(T.hexes), victim: rand() < 0.2 ? null : seat() };
    case 'playYearOfPlenty':
      return { type, take: [res(), res()] };
    case 'playMonopoly':
      return { type, resource: res() };
    case 'maritimeTrade':
      return { type, give: res(), receive: res(), count: int(0, 3) };
    case 'proposeTrade':
      return { type, give: counts(2), get: counts(2) };
    case 'respondTrade':
      return { type, tradeId: tradeId(), accept: rand() < 0.5 };
    case 'confirmTrade':
      return { type, tradeId: tradeId(), partner: seat() };
    case 'cancelTrade':
      return { type, tradeId: tradeId() };
    default:
      return { type };
  }
}

/** The design §6.1 phase table, restated independently of rules/phases.ts for the D18a check. */
const PHASE_TABLE: Readonly<Record<GameState['phase']['name'], readonly ActionType[]>> = {
  setupSettlement: ['placeSettlement'],
  setupRoad: ['placeRoad'],
  preRoll: ['rollDice', 'playKnight', 'playRoadBuilding', 'playYearOfPlenty', 'playMonopoly'],
  discard: ['discard'],
  moveRobber: ['moveRobber'],
  main: [
    'placeSettlement', 'placeRoad', 'buildCity', 'buyDevCard', 'playKnight', 'playRoadBuilding', 'playYearOfPlenty',
    'playMonopoly', 'maritimeTrade', 'proposeTrade', 'respondTrade', 'confirmTrade', 'cancelTrade', 'endTurn',
  ],
  roadBuilding: ['placeRoad'],
  gameOver: [],
};

/**
 * The turn-category code a well-formed seat action must get under design §3.8 with D18a/D18b, or null when the action
 * passes the turn checks (its outcome is then ok or a rule code). Order: game_over → discard_pending → not_your_turn
 * (role: respondTrade from a non-active seat only, discard from any seat, everything else from the active seat only) →
 * wrong_phase.
 */
export function expectedTurnCode(state: GameState, seat: Seat, type: ActionType): 'game_over' | 'discard_pending' | 'not_your_turn' | 'wrong_phase' | null {
  const phase = state.phase.name;
  if (phase === 'gameOver') return 'game_over';
  if (phase === 'discard' && type !== 'discard') return 'discard_pending';
  const active = state.turn.active;
  const roleOk = type === 'respondTrade' ? seat !== active : type === 'discard' ? true : seat === active;
  if (!roleOk) return 'not_your_turn';
  if (!PHASE_TABLE[phase].includes(type)) return 'wrong_phase';
  return null;
}
