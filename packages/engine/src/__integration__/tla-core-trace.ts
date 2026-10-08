// V39 CatanCore trace import (verification plan V39): TLC counterexample traces of the CatanCore skip-loop covers
// (docs/tla/CoreCover*.cfg, exported by dump-traces.sh into core/, format in docs/tla/TRACES.md) checked against the
// engine's system skipSeat. Test-only.
//
// CatanCore abstracts geometry, production and victory points, so the player steps before the skip only build the
// state the skip starts from; they are not replayed. Mapping:
// - The model state at the trace's SkipSeat(k) step becomes an engine state (coreStateFor): N seats, the model's phase
//   (discard with owed and then; moveRobber and roadBuilding with resume and remaining), active seat, devPlayed, each
//   seat's free-road supply, hands with model resources "a"/"b" as brick/wool, and discardLimit = the model's
//   DiscardLimit. The model's Desert hex (its Init robber) is the board's desert, the other model hex the first other
//   hex. The board holds no pieces, so every seat has 0 VP; the importer requires every model seat below VPTarget, so
//   the win check at the start of a turn agrees. An open offer at the skip is outside the mapping and is reported.
// - The engine runs one skipSeat(k). It must be accepted, and the skip-loop relation (v39 skipLoopIssues) must hold
//   between the engine's pre-state, post-state and events.
// - When the trace runs the loop (SkipStep* until skipping = NoSeat), the dice are forced to the model's branch (7 when
//   the loop leaves preRoll by SevenOwed, otherwise 1+2) and the engine's post-state must match the model's state at
//   the end of the loop: phase, active seat, robber hex, owed per seat, then (in discard), the open offer and the free
//   roads left. Hands are not compared: the model's production and discard choices are not the engine's.
import type { Command, GameEvent } from '../events';
import type { HexId, Seat } from '../ids';
import { reduce } from '../reduce';
import type { GameState, Phase, PhaseName, ResourceCounts } from '../state';
import { buildState } from '../testing/state';
import { forceDice } from '../testing/rng';
import { MODEL_RESOURCES } from './tla-trace';
import { skipLoopIssues } from './v39';

type Vec = Readonly<Record<string, number>>;
type PerSeat<T> = Readonly<Record<string, T>>;

/** The CatanCore variables the importer reads. */
export interface CoreState {
  readonly phase: PhaseName;
  readonly active: number;
  readonly hand: PerSeat<Vec>;
  readonly owed: PerSeat<number>;
  readonly thenPhase: 'moveRobber' | 'autoRobberThenEnd';
  readonly returnPhase: 'preRoll' | 'main';
  readonly robber: number;
  readonly offerOpen: boolean;
  readonly devPlayed: boolean;
  readonly rbLeft: number;
  readonly roadsLeft: PerSeat<number>;
  readonly placed: PerSeat<number>;
  readonly built: PerSeat<number>;
  readonly lrHolder: number;
  readonly skipping: number;
}
export interface CoreStep {
  readonly name: string;
  readonly pre: CoreState;
  readonly post: CoreState;
}

/** The constants of the CoreCover*.cfg models that the mapping needs. */
export const CORE_COVER_CONSTANTS = { discardLimit: 1, vpTarget: 4 } as const;

/** Steps of a TLC `-dumpTrace json` trace (TRACES.md): counterexample.action entries [[i, pre], step, [i+1, post]]. */
export function coreSteps(trace: unknown): CoreStep[] {
  const doc = trace as { counterexample?: { action?: [[number, CoreState], { name: string }, [number, CoreState]][] } };
  return (doc.counterexample?.action ?? []).map(([[, pre], step, [, post]]) => ({ name: step.name, pre, post }));
}

const seats = (m: CoreState): number[] => Object.keys(m.hand).map(Number).sort((a, b) => a - b);
const handOf = (v: Vec): Partial<ResourceCounts> => Object.fromEntries(Object.entries(v).map(([k, n]) => [MODEL_RESOURCES[k]!, n]));
const vpOf = (m: CoreState, s: number): number => m.placed[s]! + m.built[s]! + (m.lrHolder === s ? 2 : 0);

/** Engine hex ids for the two model hexes: the model's Desert is the board's desert, the other the first other hex. */
export interface HexMap {
  readonly desert: number;
  toEngine(h: number): HexId;
  toModel(h: HexId): number | null;
}
function hexMap(state: GameState, desert: number, other: number): HexMap {
  const desertHex = state.board.hexes.find((h) => h.terrain === 'desert')!.id;
  const otherHex = state.board.hexes.find((h) => h.terrain !== 'desert')!.id;
  return {
    desert,
    toEngine: (h) => (h === desert ? desertHex : otherHex),
    toModel: (h) => (h === desertHex ? desert : h === otherHex ? other : null),
  };
}

function phaseFor(m: CoreState, n: number): Phase {
  switch (m.phase) {
    case 'discard':
      return { name: 'discard', owed: Array.from({ length: n }, (_, s) => m.owed[s] ?? 0), then: m.thenPhase };
    case 'moveRobber':
      return { name: 'moveRobber', resume: m.returnPhase };
    case 'roadBuilding':
      return { name: 'roadBuilding', remaining: m.rbLeft as 1 | 2, resume: m.returnPhase };
    case 'preRoll':
    case 'main':
      return { name: m.phase };
    default:
      throw new Error(`no engine state for a skip from ${m.phase}`);
  }
}

/** The model state at a SkipSeat as an engine state; `issues` lists what falls outside the mapping. */
export function coreStateFor(m: CoreState, desert: number, other: number, dice: readonly (readonly [number, number])[] = []): { state: GameState; hexes: HexMap; issues: string[] } {
  const issues: string[] = [];
  const all = seats(m);
  const n = all.length as 3 | 4;
  for (const s of all) if (vpOf(m, s) >= CORE_COVER_CONSTANTS.vpTarget) issues.push(`seat ${s} has ${vpOf(m, s)} VP, at the target`);
  if (m.offerOpen) issues.push('an open offer at the skip is outside the mapping');
  let state = buildState({
    playerCount: n,
    rules: { discardLimit: CORE_COVER_CONSTANTS.discardLimit },
    hands: Object.fromEntries(all.map((s) => [s, handOf(m.hand[s]!)])),
    turn: { number: 3, active: m.active as Seat, devPlayed: m.devPlayed },
    phase: phaseFor(m, n),
  });
  const hexes = hexMap(state, desert, other);
  state = {
    ...state,
    robber: hexes.toEngine(m.robber),
    players: state.players.map((p, s) => ({ ...p, supply: { ...p.supply, roads: m.roadsLeft[s] ?? p.supply.roads } })),
  };
  if (dice.length > 0) state = forceDice(state, dice);
  return { state, hexes, issues };
}

/** Differences between the engine state and the model state at the end of a skip loop. */
export function coreObservableIssues(s: GameState, m: CoreState, hexes: HexMap): string[] {
  const out: string[] = [];
  const p = s.phase;
  if (p.name !== m.phase) out.push(`phase ${p.name}, model ${m.phase}`);
  if (s.turn.active !== m.active) out.push(`active ${s.turn.active}, model ${m.active}`);
  const robber = hexes.toModel(s.robber);
  if (robber !== m.robber) out.push(`robber ${robber ?? `unmapped hex ${s.robber}`}, model ${m.robber}`);
  const owed = s.players.map((_, i) => (p.name === 'discard' ? (p.owed[i] ?? 0) : 0));
  const modelOwed = s.players.map((_, i) => m.owed[i] ?? 0);
  if (owed.join() !== modelOwed.join()) out.push(`owed ${owed.join(',')}, model ${modelOwed.join(',')}`);
  if (p.name === 'discard' && p.then !== m.thenPhase) out.push(`then ${p.then}, model ${m.thenPhase}`);
  if ((s.trade !== null) !== m.offerOpen) out.push(`offer ${s.trade !== null}, model ${m.offerOpen}`);
  const rbLeft = p.name === 'roadBuilding' ? p.remaining : 0;
  if (rbLeft !== m.rbLeft) out.push(`rbLeft ${rbLeft}, model ${m.rbLeft}`);
  return out;
}

/** The dice the engine needs to take the model's branch: one roll per SkipStep that leaves preRoll. */
function diceFor(loop: readonly CoreStep[]): [number, number][] {
  return loop.filter((st) => st.name === 'SkipStep' && st.pre.phase === 'preRoll').map((st) => (st.post.phase === 'main' ? [1, 2] : [3, 4]));
}

export interface CoreReplayReport {
  /** The skipped seat, or null when the trace has no SkipSeat. */
  readonly seat: number | null;
  /** SkipStep steps of the loop in the trace (0 when the trace ends at SkipSeat). */
  readonly loopSteps: number;
  /** Whether the trace runs the loop to its end (skipping = NoSeat), so the end states were compared. */
  readonly compared: boolean;
  readonly events: readonly GameEvent[];
  readonly issues: readonly string[];
}

/** The engine's reducer, replaceable so tests can check that a wrong engine is reported. */
export type Reducer = typeof reduce;

/** Checks the trace's skip loop against the engine's skipSeat; issues list every divergence. */
export function replayCoreTrace(trace: unknown, reducer: Reducer = reduce): CoreReplayReport {
  const steps = coreSteps(trace);
  if (steps.length === 0) return { seat: null, loopSteps: 0, compared: false, events: [], issues: ['empty trace'] };
  const at = steps.findIndex((st) => st.name === 'SkipSeat');
  if (at < 0) return { seat: null, loopSteps: 0, compared: false, events: [], issues: ['no SkipSeat step'] };
  const skip = steps[at]!;
  const k = skip.post.skipping;
  const loop = [skip];
  for (const st of steps.slice(at + 1)) {
    if (st.name !== 'SkipStep') break;
    loop.push(st);
  }
  const end = loop.at(-1)!.post;
  const compared = loop.length > 1 && end.skipping === -1;
  const desert = steps[0]!.pre.robber;
  const other = [steps[0]!.pre, ...steps.map((st) => st.post)].map((m) => m.robber).find((h) => h !== desert) ?? desert + 1;
  const built = coreStateFor(skip.pre, desert, other, compared ? diceFor(loop) : []);
  const issues = [...built.issues];
  const cmd: Command = { by: 'system', action: { type: 'skipSeat', seat: k as Seat, reason: 'timer' } };
  const r = reducer(built.state, cmd);
  if (!r.ok) return { seat: k, loopSteps: loop.length - 1, compared, events: [], issues: [...issues, `skipSeat(${k}) rejected: ${r.reason}`] };
  issues.push(...skipLoopIssues(built.state, k as Seat, r.state, r.events).map((x) => `relation: ${x}`));
  if (compared) issues.push(...coreObservableIssues(r.state, end, built.hexes).map((x) => `end of loop: ${x}`));
  return { seat: k, loopSteps: loop.length - 1, compared, events: r.events, issues };
}
