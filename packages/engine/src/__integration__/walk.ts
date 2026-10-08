// Random legal playouts for the E-INT property suite (verification plan V2–V4, V10, V11, V39; AC19). A playout starts
// from createGame(seed) and applies actions sampled from the legal-actions descriptor until gameOver or a step cap.
// Test-only.
import type { Command } from '../events';
import type { Seat } from '../ids';
import { legalActions } from '../legal-actions';
import { reduce } from '../reduce';
import type { GameState } from '../state';
import { DEFAULT_GAME_CONFIG } from '../config';
import { createGame } from '../create-game';
import { actionsFromDescriptor, sampleFromDescriptor } from '../testing/sample';

/** A Park–Miller generator in [0, 1); deterministic per seed. */
export function prng(seed: number): () => number {
  let x = (Math.abs(Math.trunc(seed)) % 2147483646) + 1;
  return () => {
    x = (x * 48271) % 2147483647;
    return (x - 1) / 2147483646;
  };
}

/** Build-first priorities: a playout that prefers these reaches gameOver within the step cap far more often. */
const GREEDY: readonly string[] = ['buildCity', 'placeSettlement', 'playKnight', 'playRoadBuilding', 'playYearOfPlenty', 'playMonopoly', 'buyDevCard', 'placeRoad'];

export interface PlayoutStep {
  readonly pre: GameState;
  readonly command: Command;
  readonly post: GameState;
}

export interface PlayoutOptions {
  readonly seed: number;
  readonly playerCount: 3 | 4;
  readonly maxSteps: number;
  /** Probability of taking a build-first action when one is legal (0 = uniform over action types). */
  readonly greed: number;
  /** Called after every accepted step; a returned non-empty list stops the playout and is reported. */
  readonly onStep?: (step: PlayoutStep, index: number) => readonly string[];
}

export interface PlayoutResult {
  readonly final: GameState;
  readonly steps: number;
  readonly commands: readonly Command[];
  readonly failure: { readonly index: number; readonly command: Command; readonly issues: readonly string[] } | null;
}

/**
 * One playout. Each step picks uniformly among the seats that have a legal action (trade responders included), then an
 * action for that seat: with probability `greed` the first legal build-first action, otherwise a uniformly sampled one.
 * A command the descriptor offered but reduce rejected is itself a failure (V11).
 */
export function playout(opts: PlayoutOptions): PlayoutResult {
  const rand = prng(opts.seed);
  const created = createGame({ config: DEFAULT_GAME_CONFIG.rules, playerCount: opts.playerCount, seed: `walk-${opts.seed}` });
  if (!created.ok) throw new Error('createGame rejected the walker init');
  let state = created.state;
  const commands: Command[] = [];
  for (let i = 0; i < opts.maxSteps && state.phase.name !== 'gameOver'; i++) {
    const seats = ([0, 1, 2, 3] as const)
      .filter((s) => s < state.playerCount)
      .map((s) => ({ seat: s as Seat, legal: legalActions(state, s) }));
    const options = seats.flatMap(({ seat, legal }) => {
      const action = sampleFromDescriptor(state, seat, legal, rand);
      return action === null ? [] : [{ seat, legal, action }];
    });
    if (options.length === 0) {
      return { final: state, steps: i, commands, failure: { index: i, command: { by: 0, action: { type: 'endTurn' } }, issues: ['no seat has a legal action outside gameOver'] } };
    }
    const chosen = options[Math.floor(rand() * options.length)]!;
    let action = chosen.action;
    if (rand() < opts.greed) {
      const all = actionsFromDescriptor(state, chosen.seat, chosen.legal, 400);
      const greedy = GREEDY.map((t) => all.find((a) => a.type === t)).find((a) => a !== undefined);
      if (greedy) action = greedy;
    }
    const command: Command = { by: chosen.seat, action };
    const r = reduce(state, command);
    if (!r.ok) return { final: state, steps: i, commands, failure: { index: i, command, issues: [`described action rejected: ${r.reason}`] } };
    commands.push(command);
    const issues = opts.onStep?.({ pre: state, command, post: r.state }, i) ?? [];
    state = r.state;
    if (issues.length > 0) return { final: state, steps: i + 1, commands, failure: { index: i, command, issues } };
  }
  return { final: state, steps: commands.length, commands, failure: null };
}
