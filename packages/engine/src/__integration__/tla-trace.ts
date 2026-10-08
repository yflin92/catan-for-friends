// V39 trace import (verification plan V39): TLC counterexample traces of the CatanTrade model
// (docs/tla/CatanTrade.tla, exported with `-dumpTrace json`, format in docs/tla/TRACES.md) replayed through the
// engine's reduce. Test-only.
//
// Mapping (TRACES.md "Mapping CatanTrade traces to the engine and server"):
// - Start: buildState with the model's Init — N seats, phase main, seat 0 active, every seat holding 1 of each model
//   resource. Model resources "a"/"b" are brick/wool.
// - Deliver: the one message whose actionId is newly decided becomes {by: m.seat, action}: propose → proposeTrade,
//   accept → respondTrade{accept: true}, confirm → confirmTrade{partner: with}, cancel → cancelTrade, endTurn →
//   endTurn. The model's recorded outcome is the expected result: "ok" or the reason code. "model_bound" (the model's
//   offer-id bound) has no engine counterpart; such a step is reported and skipped.
// - Spend (an abstract build or maritime trade by the active seat): that resource moves from the active hand to the
//   bank.
// - PhaseStep (an abstract roll, discard, robber move, Knight or win): the engine's setPhase moves to the model's
//   phase, so leaving main withdraws the open offer through the engine's own onPhaseExit. A discard phase owes 1 card
//   from a seat that is not active; gameOver names the active seat as winner.
// - Send, Redeliver and Restart do not change engine state (actionIds and restarts belong to the server replay).
// After every step the engine's observable state must match the model's: phase, active seat, the open offer (id,
// proposer, give, get, accepting seats) and every seat's brick/wool.
import type { Action, Command } from '../events';
import type { Seat } from '../ids';
import { setPhase } from '../internal/turn';
import { reduce } from '../reduce';
import type { GameState, Phase, PhaseName, Resource, ResourceCounts } from '../state';
import { buildState } from '../testing/state';

export const MODEL_RESOURCES: Readonly<Record<string, Resource>> = { a: 'brick', b: 'wool' };

type Vec = Readonly<Record<string, number>>;
interface Intent {
  readonly kind: 'propose' | 'accept' | 'confirm' | 'cancel' | 'endTurn';
  readonly oid: number;
  readonly give: Vec;
  readonly get: Vec;
  readonly with: number;
}
interface Message {
  readonly aid: readonly [number, number];
  readonly seat: number;
  readonly act: Intent;
}
interface Offer {
  readonly id: number;
  readonly from: number;
  readonly give: Vec;
  readonly get: Vec;
  readonly accepted: readonly number[];
}
/** The CatanTrade variables the importer reads. */
export interface TradeState {
  readonly phase: PhaseName;
  readonly hand: Readonly<Record<string, Vec>>;
  readonly active: number;
  readonly offer: Offer;
  readonly net: readonly Message[];
  /** TLC writes a function over tuples as an object with "<<s, n>>" keys, and an empty one as []. */
  readonly outcome: Readonly<Record<string, string>> | readonly never[];
}
export interface TraceStep {
  readonly name: string;
  readonly pre: TradeState;
  readonly post: TradeState;
}

/** Steps of a TLC `-dumpTrace json` trace (TRACES.md): counterexample.action entries [[i, pre], step, [i+1, post]]. */
export function traceSteps(trace: unknown): TraceStep[] {
  const doc = trace as { counterexample?: { action?: [[number, TradeState], { name: string }, [number, TradeState]][] } };
  return (doc.counterexample?.action ?? []).map(([[, pre], step, [, post]]) => ({ name: step.name, pre, post }));
}

const aidKey = (aid: readonly [number, number]) => `<<${aid[0]}, ${aid[1]}>>`;
const outcomes = (s: TradeState): Readonly<Record<string, string>> => (Array.isArray(s.outcome) ? {} : (s.outcome as Record<string, string>));

function counts(v: Vec): ResourceCounts {
  const out: Record<Resource, number> = { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 };
  for (const [k, n] of Object.entries(v)) out[MODEL_RESOURCES[k]!] += n;
  return out;
}

/** The engine action for a model intent. */
export function actionOf(i: Intent): Action {
  switch (i.kind) {
    case 'propose':
      return { type: 'proposeTrade', give: counts(i.give), get: counts(i.get) };
    case 'accept':
      return { type: 'respondTrade', tradeId: i.oid, accept: true };
    case 'confirm':
      return { type: 'confirmTrade', tradeId: i.oid, partner: i.with as Seat };
    case 'cancel':
      return { type: 'cancelTrade', tradeId: i.oid };
    case 'endTurn':
      return { type: 'endTurn' };
  }
}

/** The message a Deliver step decided, with its recorded outcome. */
export function decided(step: TraceStep): { readonly message: Message; readonly outcome: string } | null {
  const before = outcomes(step.pre);
  const after = outcomes(step.post);
  const m = step.post.net.find((x) => !(aidKey(x.aid) in before) && aidKey(x.aid) in after);
  return m ? { message: m, outcome: after[aidKey(m.aid)]! } : null;
}

/** The model's Init as an engine state. */
export function startState(init: TradeState): GameState {
  const n = Object.keys(init.hand).length as 3 | 4;
  const hands: Partial<Record<Seat, Partial<ResourceCounts>>> = {};
  for (const [s, v] of Object.entries(init.hand)) hands[Number(s) as Seat] = counts(v);
  return buildState({ playerCount: n, turn: { number: 3, active: init.active as Seat }, phase: { name: 'main' }, hands });
}

/** Differences between the engine state and the model state's observable part. */
export function observableIssues(s: GameState, m: TradeState): string[] {
  const out: string[] = [];
  if (s.phase.name !== m.phase) out.push(`phase ${s.phase.name}, model ${m.phase}`);
  if (s.turn.active !== m.active) out.push(`active ${s.turn.active}, model ${m.active}`);
  const t = s.trade;
  const engineOffer = t === null
    ? { id: 0, from: -1, give: counts({}), get: counts({}), accepted: [] as number[] }
    : { id: t.id, from: t.from, give: t.give, get: t.get, accepted: t.responses.flatMap((r, i) => (r === 'accepted' ? [i] : [])) };
  const modelOffer = { id: m.offer.id, from: m.offer.from, give: counts(m.offer.give), get: counts(m.offer.get), accepted: [...m.offer.accepted].sort() };
  if (JSON.stringify(engineOffer) !== JSON.stringify(modelOffer)) out.push(`offer ${JSON.stringify(engineOffer)}, model ${JSON.stringify(modelOffer)}`);
  for (const [seat, v] of Object.entries(m.hand)) {
    for (const [k, n] of Object.entries(v)) {
      const have = s.players[Number(seat)]!.hand[MODEL_RESOURCES[k]!];
      if (have !== n) out.push(`seat ${seat} ${MODEL_RESOURCES[k]} ${have}, model ${n}`);
    }
  }
  return out;
}

/** The engine phase for an abstract PhaseStep into `to`. */
function phaseFor(s: GameState, to: PhaseName): Phase {
  switch (to) {
    case 'discard': {
      const owed = s.players.map((_, i) => (i === (s.turn.active + 1) % s.playerCount ? 1 : 0));
      return { name: 'discard', owed, then: 'moveRobber' };
    }
    case 'moveRobber':
      return { name: 'moveRobber', resume: 'main' };
    case 'gameOver':
      return { name: 'gameOver', winner: s.turn.active };
    case 'preRoll':
    case 'main':
      return { name: to };
    default:
      throw new Error(`no abstract PhaseStep into ${to}`);
  }
}

export interface ReplayReport {
  readonly steps: number;
  readonly delivered: number;
  readonly skipped: readonly string[];
  readonly issues: readonly string[];
}

/** Replays one CatanTrade trace through reduce; issues list every divergence from the model. */
export function replayTrace(trace: unknown): ReplayReport {
  const steps = traceSteps(trace);
  const issues: string[] = [];
  const skipped: string[] = [];
  let delivered = 0;
  if (steps.length === 0) return { steps: 0, delivered, skipped, issues: ['empty trace'] };
  let s = startState(steps[0]!.pre);
  issues.push(...observableIssues(s, steps[0]!.pre).map((x) => `init: ${x}`));
  steps.forEach((step, i) => {
    const at = `step ${i + 1} ${step.name}`;
    switch (step.name) {
      case 'Deliver': {
        const d = decided(step);
        if (d === null) {
          issues.push(`${at}: no newly decided message`);
          return;
        }
        if (d.outcome === 'model_bound') {
          skipped.push(`${at}: model_bound`);
          return;
        }
        delivered++;
        const cmd: Command = { by: d.message.seat as Seat, action: actionOf(d.message.act) };
        const r = reduce(s, cmd);
        const got = r.ok ? 'ok' : r.reason;
        if (got !== d.outcome) issues.push(`${at} ${JSON.stringify(cmd)}: engine ${got}, model ${d.outcome}`);
        if (r.ok) s = r.state;
        break;
      }
      case 'Spend': {
        const seat = step.pre.active;
        const spent = Object.keys(step.pre.hand[seat]!).find((k) => step.post.hand[seat]![k]! < step.pre.hand[seat]![k]!);
        if (spent === undefined) {
          issues.push(`${at}: no spent resource`);
          return;
        }
        const r = MODEL_RESOURCES[spent]!;
        s = {
          ...s,
          bank: { ...s.bank, [r]: s.bank[r] + 1 },
          players: s.players.map((p, k) => (k === seat ? { ...p, hand: { ...p.hand, [r]: p.hand[r] - 1 } } : p)),
        };
        break;
      }
      case 'PhaseStep':
        s = setPhase(s, phaseFor(s, step.post.phase));
        break;
      case 'Send':
      case 'Redeliver':
      case 'Restart':
        break;
      default:
        issues.push(`${at}: unknown action`);
    }
    issues.push(...observableIssues(s, step.post).map((x) => `${at}: ${x}`));
  });
  return { steps: steps.length, delivered, skipped, issues };
}
