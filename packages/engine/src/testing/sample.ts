// Generic expansion of the LegalActions descriptor into concrete actions (design §3.6, §3.10): enumeration for
// exhaustive checks and random sampling for playouts. Parametric actions (discard, maritime count, proposeTrade) are
// expanded from the seat's hand and the bank; the reducer stays the oracle for them.
import type { Action } from '../events';
import type { Seat } from '../ids';
import type { LegalActions } from '../legal';
import { legalActions } from '../legal-actions';
import { RESOURCES, type GameState, type Resource, type ResourceCounts } from '../state';

/** A family of actions of one type: all of them (in a fixed order) and a random pick. */
interface Family {
  readonly all: () => readonly Action[];
  readonly sample: (rand: () => number) => Action;
}

const counts = (pairs: Iterable<readonly [Resource, number]>): ResourceCounts => {
  const out: Record<Resource, number> = { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 };
  for (const [r, n] of pairs) out[r] += n;
  return out;
};

const pick = <T>(items: readonly T[], rand: () => number): T => items[Math.min(items.length - 1, Math.floor(rand() * items.length))]!;

/** The hand as a list of single cards, in canonical resource order. */
const cardsOf = (hand: ResourceCounts): Resource[] => RESOURCES.flatMap((r) => Array<Resource>(hand[r]).fill(r));

/** `n` cards drawn without replacement from `cards`. */
function drawCards(cards: readonly Resource[], n: number, rand: () => number): Resource[] {
  const pool = [...cards];
  const out: Resource[] = [];
  for (let i = 0; i < n && pool.length > 0; i++) out.push(pool.splice(Math.floor(rand() * pool.length) % pool.length, 1)[0]!);
  return out;
}

/** Every sub-multiset of `hand` with exactly `total` cards, in lexicographic order over RESOURCES. */
function subHands(hand: ResourceCounts, total: number): ResourceCounts[] {
  const out: ResourceCounts[] = [];
  const go = (i: number, left: number, acc: [Resource, number][]) => {
    if (i === RESOURCES.length) {
      if (left === 0) out.push(counts(acc));
      return;
    }
    const r = RESOURCES[i]!;
    for (let n = Math.min(hand[r], left); n >= 0; n--) go(i + 1, left - n, [...acc, [r, n]]);
  };
  go(0, total, []);
  return out;
}

const single = (action: Action): Family => ({ all: () => [action], sample: () => action });
const listed = (actions: readonly Action[]): Family | null =>
  actions.length === 0 ? null : { all: () => actions, sample: (rand) => pick(actions, rand) };

function families(state: GameState, seat: Seat, legal: LegalActions): Family[] {
  const hand = state.players[seat]?.hand ?? counts([]);
  const out: (Family | null)[] = [
    listed(legal.placeSettlement.map((vertex) => ({ type: 'placeSettlement', vertex }))),
    listed(legal.placeRoad.map((edge) => ({ type: 'placeRoad', edge }))),
    listed(legal.buildCity.map((vertex) => ({ type: 'buildCity', vertex }))),
    legal.rollDice ? single({ type: 'rollDice' }) : null,
    legal.discard === null ? null : discardFamily(hand, legal.discard.count),
    listed(
      legal.moveRobber.flatMap(({ hex, victims }): Action[] =>
        victims.length === 0 ? [{ type: 'moveRobber', hex, victim: null }] : victims.map((victim) => ({ type: 'moveRobber', hex, victim })),
      ),
    ),
    legal.buyDevCard ? single({ type: 'buyDevCard' }) : null,
    legal.playKnight ? single({ type: 'playKnight' }) : null,
    legal.playRoadBuilding ? single({ type: 'playRoadBuilding' }) : null,
    listed(legal.playYearOfPlenty.map((take) => ({ type: 'playYearOfPlenty', take }))),
    legal.playMonopoly ? listed(RESOURCES.map((resource) => ({ type: 'playMonopoly', resource }))) : null,
    listed(maritimeActions(hand, legal)),
    legal.proposeTrade ? proposeFamily(hand) : null,
    legal.respondTrade === null
      ? null
      : listed([
          { type: 'respondTrade', tradeId: legal.respondTrade.tradeId, accept: false },
          ...(legal.respondTrade.canAccept ? [{ type: 'respondTrade', tradeId: legal.respondTrade.tradeId, accept: true } as const] : []),
        ]),
    legal.confirmTrade === null
      ? null
      : listed(legal.confirmTrade.partners.map((partner) => ({ type: 'confirmTrade', tradeId: legal.confirmTrade!.tradeId, partner }))),
    legal.cancelTrade === null ? null : single({ type: 'cancelTrade', tradeId: legal.cancelTrade }),
    legal.endTurn ? single({ type: 'endTurn' }) : null,
  ];
  return out.filter((f): f is Family => f !== null);
}

function discardFamily(hand: ResourceCounts, count: number): Family | null {
  const cards = cardsOf(hand);
  if (count < 1 || cards.length < count) return null;
  return {
    all: () => subHands(hand, count).map((cards) => ({ type: 'discard', cards })),
    sample: (rand) => ({ type: 'discard', cards: counts(drawCards(cards, count, rand).map((r) => [r, 1] as const)) }),
  };
}

/** Each give-resource with a ratio, each other receive-resource, each count the hand and the bank can cover. */
function maritimeActions(hand: ResourceCounts, legal: LegalActions): Action[] {
  const out: Action[] = [];
  for (const give of RESOURCES) {
    const ratio = legal.maritime[give];
    if (ratio === undefined) continue;
    for (const receive of RESOURCES) {
      if (receive === give) continue;
      const max = Math.min(Math.floor(hand[give] / ratio), legal.bankStock[receive]);
      for (let count = 1; count <= max; count++) out.push({ type: 'maritimeTrade', give, receive, count });
    }
  }
  return out;
}

/**
 * Enumeration: every one-for-one offer (1 held X for 1 Y ≠ X). Sampling: 1–3 cards drawn from the hand for `give`, and
 * 1–3 cards of resources not in `give` for `get`.
 */
function proposeFamily(hand: ResourceCounts): Family | null {
  const cards = cardsOf(hand);
  if (cards.length === 0) return null;
  const oneForOne: Action[] = RESOURCES.filter((r) => hand[r] > 0).flatMap((g) =>
    RESOURCES.filter((r) => r !== g).map((r) => ({ type: 'proposeTrade', give: counts([[g, 1]]), get: counts([[r, 1]]) }) as const),
  );
  return {
    all: () => oneForOne,
    sample: (rand) => {
      const give = drawCards(cards, 1 + Math.floor(rand() * Math.min(3, cards.length)), rand);
      const others = RESOURCES.filter((r) => !give.includes(r));
      const get = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => pick(others, rand));
      return { type: 'proposeTrade', give: counts(give.map((r) => [r, 1] as const)), get: counts(get.map((r) => [r, 1] as const)) };
    },
  };
}

/** Expands a descriptor into concrete actions, in descriptor field order, stopping after `limit`. */
export function actionsFromDescriptor(state: GameState, seat: Seat, legal: LegalActions, limit = Infinity): readonly Action[] {
  const out: Action[] = [];
  for (const family of families(state, seat, legal)) {
    for (const action of family.all()) {
      if (out.length >= limit) return out;
      out.push(action);
    }
  }
  return out;
}

/** One random action from a descriptor: a uniformly chosen action type, then a random instance of it; null if none. */
export function sampleFromDescriptor(state: GameState, seat: Seat, legal: LegalActions, rand: () => number): Action | null {
  const available = families(state, seat, legal);
  return available.length === 0 ? null : pick(available, rand).sample(rand);
}

/**
 * Every action legalActions(state, seat) describes, in descriptor field order (up to `limit`). Parametric actions are
 * expanded in full for discard and maritime trades, and as one-for-one offers for proposeTrade. Trade responses follow
 * the exact descriptor: decline always, accept only when canAccept, one confirm per partner, cancel when non-null.
 */
export function enumerateLegalActions(state: GameState, seat: Seat, limit?: number): readonly Action[] {
  return actionsFromDescriptor(state, seat, legalActions(state, seat), limit);
}

/** A random action described by legalActions(state, seat), or null when the seat has none. `rand` returns [0, 1). */
export function sampleLegalAction(state: GameState, seat: Seat, rand: () => number): Action | null {
  return sampleFromDescriptor(state, seat, legalActions(state, seat), rand);
}
