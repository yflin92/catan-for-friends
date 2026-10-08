// Generates the V15 golden fixtures (verification plan V15; Verify-owned) into packages/engine/src/__fixtures__/golden/.
// Each fixture records the starting point, every command, the events it produced and the stateHash after it.
// packages/engine/src/golden.test.ts replays them and asserts every hash byte-exactly; it never writes them.
//
// Run with `pnpm golden:v15`. Regenerate only together with a rule or serialization change that is meant to move the
// hashes, and say so in that PR.
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  DEFAULT_GAME_CONFIG,
  RESOURCES,
  createGame,
  legalActions,
  reduce,
  stateHash,
  type Command,
  type GameEvent,
  type GameInit,
  type GameState,
  type Resource,
  type ResourceCounts,
  type Seat,
} from '../packages/engine/src/index';
import { buildState, type StateSpec } from '../packages/engine/src/testing/index';

const OUT = new URL('../packages/engine/src/__fixtures__/golden/', import.meta.url);

interface Step {
  readonly command: Command;
  readonly events: readonly GameEvent[];
  readonly stateHash: string;
}

/** Applies `commands` one by one, failing loudly on any rejection. */
function record(start: GameState, next: (state: GameState, step: number) => Command | null): { steps: Step[]; end: GameState } {
  const steps: Step[] = [];
  let state = start;
  for (let i = 0; ; i++) {
    const command = next(state, i);
    if (command === null) return { steps, end: state };
    const result = reduce(state, command);
    if (!result.ok) throw new Error(`step ${i}: ${JSON.stringify(command)} rejected with ${result.reason}`);
    state = result.state;
    steps.push({ command, events: result.events, stateHash: stateHash(state) });
  }
}

/** A fixed Park–Miller sequence for choosing among legal sites, so the draft is varied but reproducible. */
function picker(seed: number): (n: number) => number {
  let x = seed;
  return (n) => {
    x = (x * 48271) % 2147483647;
    return x % n;
  };
}

/** The setup snake draft from createGame(init): each step places a legal settlement or road chosen by `pick`. */
function setupGolden(init: GameInit, pickSeed: number) {
  const created = createGame(init);
  if (!created.ok) throw new Error(`createGame rejected ${JSON.stringify(init)}`);
  const start = created.state;
  const pick = picker(pickSeed);
  const { steps, end } = record(start, (s) => {
    const seat = s.turn.active;
    if (s.phase.name === 'setupSettlement') {
      const sites = legalActions(s, seat).placeSettlement;
      return { by: seat, action: { type: 'placeSettlement', vertex: sites[pick(sites.length)]! } };
    }
    if (s.phase.name === 'setupRoad') {
      const edges = legalActions(s, seat).placeRoad;
      return { by: seat, action: { type: 'placeRoad', edge: edges[pick(edges.length)]! } };
    }
    return null;
  });
  return {
    description: `Setup snake draft, ${init.playerCount} players, from createGame; sites chosen by Park–Miller seed ${pickSeed}.`,
    init,
    board: {
      hexes: start.board.hexes.map((h) => [h.id, h.terrain, h.token]),
      harbors: start.board.harbors.map((h) => [h.edge, h.kind]),
      robber: start.robber,
    },
    initialStateHash: stateHash(start),
    steps,
    final: { phase: end.phase, turn: end.turn, hands: end.players.map((p) => p.hand), bank: end.bank },
  };
}

/**
 * Bank shortage (plan V15(e), R8 decision (d)). DEFAULT_TEST_BOARD, 4 players. Seat 0 has a city on v:0,-1,N, seat 1 a
 * settlement on v:1,-1,S, and seat 2 holds 18 of each resource, leaving 1 of each in the bank. Dice are scripted so the
 * seats roll every token number on the board once (no 7), ending each turn in between.
 */
function bankShortageGolden() {
  const board = buildState({}).board;
  const rolls: [number, number][] = [];
  for (const h of board.hexes) {
    if (h.token === null || rolls.some(([a, b]) => a + b === h.token)) continue;
    rolls.push(h.token <= 7 ? [1, h.token - 1] : [6, h.token - 6]);
  }
  const spec = {
    pieces: [
      { seat: 0, cities: ['v:0,-1,N'], roads: ['e:0,-1,NE'] },
      { seat: 1, settlements: ['v:1,-1,S'] },
    ],
    hands: { 2: { brick: 18, lumber: 18, wool: 18, grain: 18, ore: 18 } },
    phase: { name: 'preRoll' },
    rng: { dice: { scripted: rolls.flat(), seed: 'v15e' } },
  } satisfies StateSpec;
  const start = buildState(spec);
  const { steps } = record(start, (s, i) => {
    if (i >= 2 * rolls.length) return null;
    return { by: s.turn.active, action: { type: i % 2 === 0 ? 'rollDice' : 'endTurn' } };
  });
  return {
    description: 'Bank shortage (R8 (d)): single-seat remainder and multi-seat none, one roll per token number.',
    buildStateSpec: spec,
    initialStateHash: stateHash(start),
    steps,
  };
}

/** Takes `count` cards from `hand`, one at a time from the largest pile (ties in RESOURCES order). */
function largestFirst(hand: ResourceCounts, count: number): ResourceCounts {
  const left = { ...hand };
  const out = { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 };
  for (let i = 0; i < count; i++) {
    const r = RESOURCES.reduce((best, x) => (left[x] > left[best] ? x : best));
    left[r] -= 1;
    out[r] += 1;
  }
  return out;
}

/**
 * One decision of the seeded full-game player. It always picks from legalActions, so every command it sends is
 * accepted. Priorities in main: answer an open offer, then city, settlement, development cards, roads, trades, endTurn.
 * The first two-resource Year of Plenty is sent with its take in reverse RESOURCES order, so the fixture pins D20.
 */
function fullGamePlayer(pickSeed: number) {
  const pick = picker(pickSeed);
  const chance = (pct: number) => pick(100) < pct;
  let proposedOnTurn = -1;
  let reversedYop = false;
  return (s: GameState): Command | null => {
    const a = s.turn.active;
    const L = legalActions(s, a);
    const one = <T>(xs: readonly T[]): T => xs[pick(xs.length)]!;
    switch (s.phase.name) {
      case 'gameOver':
        return null;
      case 'setupSettlement':
        return { by: a, action: { type: 'placeSettlement', vertex: one(L.placeSettlement) } };
      case 'setupRoad':
      case 'roadBuilding':
        return { by: a, action: { type: 'placeRoad', edge: one(L.placeRoad) } };
      case 'preRoll':
        return { by: a, action: L.playKnight && chance(50) ? { type: 'playKnight' } : { type: 'rollDice' } };
      case 'discard': {
        const seat = s.phase.owed.findIndex((n) => n > 0) as Seat;
        return { by: seat, action: { type: 'discard', cards: largestFirst(s.players[seat]!.hand, s.phase.owed[seat]!) } };
      }
      case 'moveRobber': {
        const target = one(L.moveRobber);
        return { by: a, action: { type: 'moveRobber', hex: target.hex, victim: target.victims.length > 0 ? one(target.victims) : null } };
      }
      case 'main':
        break;
    }
    const trade = s.trade;
    if (trade !== null) {
      for (let o = 0; o < s.playerCount; o++) {
        const lo = o === a ? null : legalActions(s, o as Seat).respondTrade;
        if (lo && trade.responses[o] === 'pending') {
          return { by: o as Seat, action: { type: 'respondTrade', tradeId: lo.tradeId, accept: lo.canAccept && chance(60) } };
        }
      }
      if (L.confirmTrade) return { by: a, action: { type: 'confirmTrade', tradeId: L.confirmTrade.tradeId, partner: one(L.confirmTrade.partners) } };
      return { by: a, action: { type: 'cancelTrade', tradeId: trade.id } };
    }
    if (L.buildCity.length > 0) return { by: a, action: { type: 'buildCity', vertex: one(L.buildCity) } };
    if (L.placeSettlement.length > 0) return { by: a, action: { type: 'placeSettlement', vertex: one(L.placeSettlement) } };
    if (L.playYearOfPlenty.length > 0 && chance(70)) {
      const [x, y] = one(L.playYearOfPlenty);
      const take: [Resource, Resource] = !reversedYop && x !== y ? [y, x] : [x, y];
      if (x !== y) reversedYop = true;
      return { by: a, action: { type: 'playYearOfPlenty', take } };
    }
    if (L.playMonopoly && chance(70)) return { by: a, action: { type: 'playMonopoly', resource: one(RESOURCES) } };
    if (L.playRoadBuilding && chance(70)) return { by: a, action: { type: 'playRoadBuilding' } };
    if (L.playKnight && chance(40)) return { by: a, action: { type: 'playKnight' } };
    if (L.buyDevCard && chance(60)) return { by: a, action: { type: 'buyDevCard' } };
    if (L.placeRoad.length > 0 && chance(50)) return { by: a, action: { type: 'placeRoad', edge: one(L.placeRoad) } };
    const hand = s.players[a]!.hand;
    const most = RESOURCES.reduce((b, x) => (hand[x] > hand[b] ? x : b));
    const least = RESOURCES.reduce((b, x) => (hand[x] < hand[b] ? x : b));
    if (L.proposeTrade && proposedOnTurn !== s.turn.number && most !== least && hand[most] > 0 && chance(30)) {
      proposedOnTurn = s.turn.number;
      const give = { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0, [most]: 1 };
      const get = { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0, [least]: 1 };
      return { by: a, action: { type: 'proposeTrade', give, get } };
    }
    const gives = RESOURCES.filter((r) => L.maritime[r] !== undefined);
    if (gives.length > 0 && chance(50)) {
      const give = one(gives);
      const receive = RESOURCES.filter((r) => r !== give).reduce((b, x) => (hand[x] < hand[b] ? x : b));
      return { by: a, action: { type: 'maritimeTrade', give, receive, count: 1 } };
    }
    return { by: a, action: { type: 'endTurn' } };
  };
}

/** A full seeded game from createGame(init), played by fullGamePlayer(pickSeed) until gameOver. */
function fullGameGolden(init: GameInit, pickSeed: number, maxSteps = 6000) {
  const created = createGame(init);
  if (!created.ok) throw new Error(`createGame rejected ${JSON.stringify(init)}`);
  const start = created.state;
  const player = fullGamePlayer(pickSeed);
  const { steps, end } = record(start, (s, i) => {
    if (i >= maxSteps) throw new Error(`no winner after ${maxSteps} steps`);
    return player(s);
  });
  return {
    description: `Full game, ${init.playerCount} players, from createGame until gameOver; decisions from legalActions by Park–Miller seed ${pickSeed}.`,
    init,
    initialStateHash: stateHash(start),
    steps,
    final: { phase: end.phase, turn: end.turn, hands: end.players.map((p) => p.hand), bank: end.bank, awards: end.awards },
  };
}

mkdirSync(OUT, { recursive: true });
const write = (name: string, fixture: unknown) =>
  writeFileSync(new URL(name, OUT), `${JSON.stringify(fixture, null, 2)}\n`);

/** Park–Miller seeds for the full games (chosen so that every Action type, both awards and a reversed YoP occur). */
const FULL_GAME_SEED = { 3: 20, 4: 51 } as const;
const init = (playerCount: 3 | 4): GameInit => ({ config: DEFAULT_GAME_CONFIG.rules, playerCount, seed: 'golden-board-1' });
write('v15-setup-4p.json', setupGolden(init(4), 15));
write('v15-setup-3p.json', setupGolden(init(3), 15));
write('v15e-bank-shortage.json', bankShortageGolden());
write('v15-game-4p.json', fullGameGolden(init(4), FULL_GAME_SEED[4]));
write('v15-game-3p.json', fullGameGolden(init(3), FULL_GAME_SEED[3]));
