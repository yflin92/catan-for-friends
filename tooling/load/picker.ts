// X-load bot action choice (AC32): a human-like pick from the seat's own PlayerView descriptor. A family of action types
// is chosen by weight among those the descriptor offers, then sampleFromHand picks a concrete instance of it, so every
// pick is legal for the view it was made from. With probability `illegalRate` the bot instead sends an action its
// descriptor rules out (rollDice or endTurn when not offered), which the server must reject.
import type { Action, LegalActions, ResourceCounts } from '../../packages/engine/src/index';
import { sampleFromHand } from '../../packages/engine/src/testing/index';

export type Family = 'discard' | 'robber' | 'respond' | 'confirm' | 'cancel' | 'roll' | 'build' | 'dev' | 'maritime' | 'propose' | 'end';

/** Relative weights; discard and robber placement are forced whenever offered. */
export const FAMILY_WEIGHTS: Readonly<Record<Family, number>> = {
  discard: Infinity,
  robber: Infinity,
  respond: 1,
  confirm: 5,
  cancel: 1,
  roll: 20,
  build: 6,
  dev: 1.5,
  maritime: 1,
  propose: 0.3,
  end: 2,
};

/** The descriptor with nothing offered except seat, phase and bank stock. */
function emptyLegal(legal: LegalActions): LegalActions {
  return {
    seat: legal.seat,
    phase: legal.phase,
    bankStock: legal.bankStock,
    placeSettlement: [],
    placeRoad: [],
    buildCity: [],
    rollDice: false,
    endTurn: false,
    buyDevCard: false,
    playKnight: false,
    playRoadBuilding: false,
    playYearOfPlenty: [],
    playMonopoly: false,
    discard: null,
    moveRobber: [],
    maritime: {},
    proposeTrade: false,
    respondTrade: null,
    confirmTrade: null,
    cancelTrade: null,
  };
}

/** The descriptor fields each family reads. */
const FAMILY_FIELDS: Readonly<Record<Family, readonly (keyof LegalActions)[]>> = {
  discard: ['discard'],
  robber: ['moveRobber'],
  respond: ['respondTrade'],
  confirm: ['confirmTrade'],
  cancel: ['cancelTrade'],
  roll: ['rollDice'],
  build: ['placeSettlement', 'placeRoad', 'buildCity'],
  dev: ['buyDevCard', 'playKnight', 'playRoadBuilding', 'playYearOfPlenty', 'playMonopoly'],
  maritime: ['maritime'],
  propose: ['proposeTrade'],
  end: ['endTurn'],
};

/** Whether a descriptor field offers anything: true, a non-empty list or map, an id, or a non-null object. */
function offers(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value !== null && typeof value === 'object') return Object.keys(value).length > 0;
  return value === true || typeof value === 'number';
}

/** The part of `legal` belonging to `family`, or null when the descriptor offers none of it. */
export function focus(legal: LegalActions, family: Family): LegalActions | null {
  const fields = FAMILY_FIELDS[family];
  if (!fields.some((k) => offers(legal[k]))) return null;
  return { ...emptyLegal(legal), ...(Object.fromEntries(fields.map((k) => [k, legal[k]])) as Partial<LegalActions>) };
}

const FAMILIES = Object.keys(FAMILY_WEIGHTS) as Family[];

/**
 * A legal action for the view's own seat, weighted by family; null when the descriptor offers nothing. A family the
 * descriptor lists may still have no concrete instance for this hand and bank (e.g. a maritime give with no payable
 * receive); the pick then falls through to the remaining families.
 */
export function pickLegal(hand: ResourceCounts, legal: LegalActions, rand: () => number): Action | null {
  const offered = FAMILIES.flatMap((f) => {
    const sub = focus(legal, f);
    return sub === null ? [] : [{ f, sub }];
  });
  while (offered.length > 0) {
    const forced = offered.findIndex((o) => FAMILY_WEIGHTS[o.f] === Infinity);
    let i = forced;
    if (i < 0) {
      let r = rand() * offered.reduce((s, o) => s + FAMILY_WEIGHTS[o.f], 0);
      i = offered.findIndex((o) => (r -= FAMILY_WEIGHTS[o.f]) < 0);
      if (i < 0) i = offered.length - 1;
    }
    const action = sampleFromHand(hand, offered[i]!.sub, rand);
    if (action) return action;
    offered.splice(i, 1);
  }
  return null;
}

/** Whether this seat has anything to do: some offered family has a concrete instance for its hand and the bank. */
export const hasAction = (hand: ResourceCounts, legal: LegalActions): boolean => pickLegal(hand, legal, () => 0) !== null;

/** An action the descriptor rules out for this seat, or null if it offers both rollDice and endTurn. */
export function pickIllegal(legal: LegalActions): Action | null {
  if (!legal.rollDice) return { type: 'rollDice' };
  if (!legal.endTurn) return { type: 'endTurn' };
  return null;
}

export interface Pick {
  readonly action: Action;
  /** True when the bot chose a rejected-by-design action (counted in the illegal-action mix). */
  readonly intendedIllegal: boolean;
}

/** The bot's next action: illegal with probability `illegalRate` (when one exists), otherwise a weighted legal pick. */
export function pickAction(hand: ResourceCounts, legal: LegalActions, rand: () => number, illegalRate: number): Pick | null {
  if (rand() < illegalRate) {
    const bad = pickIllegal(legal);
    if (bad) return { action: bad, intendedIllegal: true };
  }
  const action = pickLegal(hand, legal, rand);
  return action ? { action, intendedIllegal: false } : null;
}
