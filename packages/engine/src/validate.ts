// Command shape validation. Anything that fails here is `malformed_action` (design §3.8). Checks are structural:
// exact key sets, value types, syntactically well-formed ids, and a `by` seat inside the game. Content rules (counts,
// on-board ids, eligibility) belong to the precedence checks and handlers that follow.
import type { Action, Command, SystemAction } from './events';
import type { Seat } from './ids';
import type { GameState, Resource } from './state';
import { RESOURCES } from './state';

type Rec = Readonly<Record<string, unknown>>;

const INT = '(?:0|-?[1-9][0-9]*)';
const HEX_ID = new RegExp(`^h:${INT},${INT}$`);
const VERTEX_ID = new RegExp(`^v:${INT},${INT},(?:N|S)$`);
const EDGE_ID = new RegExp(`^e:${INT},${INT},(?:NE|NW|W)$`);

function isRecord(x: unknown): x is Rec {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function hasExactKeys(o: Rec, keys: readonly string[]): boolean {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));
}

const isFiniteNumber = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isSeat = (x: unknown): x is Seat => x === 0 || x === 1 || x === 2 || x === 3;
const isResource = (x: unknown): x is Resource => typeof x === 'string' && (RESOURCES as readonly string[]).includes(x);
const isHexId = (x: unknown): boolean => typeof x === 'string' && HEX_ID.test(x);
const isVertexId = (x: unknown): boolean => typeof x === 'string' && VERTEX_ID.test(x);
const isEdgeId = (x: unknown): boolean => typeof x === 'string' && EDGE_ID.test(x);

/** A ResourceCounts-shaped object: exactly the five resource keys, each a finite number. */
function isCounts(x: unknown): boolean {
  return isRecord(x) && hasExactKeys(x, RESOURCES) && RESOURCES.every((r) => isFiniteNumber(x[r]));
}

/** Field validators per action type; the action object must have exactly `type` plus these fields. */
const ACTION_FIELDS: Readonly<Record<Action['type'], Readonly<Record<string, (x: unknown) => boolean>>>> = {
  placeSettlement: { vertex: isVertexId },
  placeRoad: { edge: isEdgeId },
  buildCity: { vertex: isVertexId },
  rollDice: {},
  discard: { cards: isCounts },
  moveRobber: { hex: isHexId, victim: (x) => x === null || isSeat(x) },
  buyDevCard: {},
  playKnight: {},
  playRoadBuilding: {},
  playYearOfPlenty: { take: (x) => Array.isArray(x) && x.length === 2 && x.every(isResource) },
  playMonopoly: { resource: isResource },
  maritimeTrade: { give: isResource, receive: isResource, count: isFiniteNumber },
  proposeTrade: { give: isCounts, get: isCounts },
  respondTrade: { tradeId: isFiniteNumber, accept: (x) => typeof x === 'boolean' },
  confirmTrade: { tradeId: isFiniteNumber, partner: isSeat },
  cancelTrade: { tradeId: isFiniteNumber },
  endTurn: {},
};

function parseAction(x: unknown): Action | null {
  if (!isRecord(x) || typeof x['type'] !== 'string' || !Object.prototype.hasOwnProperty.call(ACTION_FIELDS, x['type'])) {
    return null;
  }
  const fields = ACTION_FIELDS[x['type'] as Action['type']];
  if (!hasExactKeys(x, ['type', ...Object.keys(fields)])) return null;
  for (const [key, check] of Object.entries(fields)) {
    if (!check(x[key])) return null;
  }
  return x as unknown as Action;
}

function parseSystemAction(x: unknown, playerCount: number): SystemAction | null {
  if (!isRecord(x) || !hasExactKeys(x, ['type', 'seat', 'reason'])) return null;
  if (x['type'] !== 'skipSeat' || !isSeat(x['seat']) || x['seat'] >= playerCount) return null;
  if (x['reason'] !== 'host' && x['reason'] !== 'timer') return null;
  return x as unknown as SystemAction;
}

/** Returns the command if it is well-formed for this game, otherwise null (→ malformed_action). */
export function parseCommand(state: GameState, cmd: unknown): Command | null {
  if (!isRecord(cmd) || !hasExactKeys(cmd, ['by', 'action'])) return null;
  const by = cmd['by'];
  if (by === 'system') {
    const action = parseSystemAction(cmd['action'], state.playerCount);
    return action ? { by: 'system', action } : null;
  }
  if (!isSeat(by) || by >= state.playerCount) return null;
  const action = parseAction(cmd['action']);
  return action ? { by, action } : null;
}
