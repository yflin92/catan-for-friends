// Generates the V15 golden fixtures (verification plan V15; Verify-owned) into packages/engine/src/__fixtures__/golden/.
// Each fixture records the starting point, every command, the events it produced and the stateHash after it.
// packages/engine/src/golden.test.ts replays them and asserts every hash byte-exactly; it never writes them.
//
// Run with `pnpm golden:v15`. Regenerate only together with a rule or serialization change that is meant to move the
// hashes, and say so in that PR.
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  DEFAULT_GAME_CONFIG,
  createGame,
  legalActions,
  reduce,
  stateHash,
  type Command,
  type GameEvent,
  type GameInit,
  type GameState,
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

mkdirSync(OUT, { recursive: true });
const write = (name: string, fixture: unknown) =>
  writeFileSync(new URL(name, OUT), `${JSON.stringify(fixture, null, 2)}\n`);

const init = (playerCount: 3 | 4): GameInit => ({ config: DEFAULT_GAME_CONFIG.rules, playerCount, seed: 'golden-board-1' });
write('v15-setup-4p.json', setupGolden(init(4), 15));
write('v15-setup-3p.json', setupGolden(init(3), 15));
write('v15e-bank-shortage.json', bankShortageGolden());
