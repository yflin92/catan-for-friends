// The E-INT property suite as a reusable runner (verification plan V2–V5, V11, V39; AC19), so the playouts can be
// split across test files that vitest runs in parallel. Test-only.
import type { Action } from '../events';
import type { Seat } from '../ids';
import { legalActions } from '../legal-actions';
import { reasonCategory } from '../reasons';
import { reduce } from '../reduce';
import type { GameState } from '../state';
import { validateInvariants } from '../testing/invariants';
import { arbitraryAction, describes, expectedTurnCode, winnerIssues } from './oracle';
import { v39StateIssues, v39StepIssues } from './v39';
import { playout, prng } from './walk';

/** Probes per step: arbitrary actions checked against the descriptor and the D18a turn codes. */
const PROBES_PER_STEP = 2;

/** legal ⇔ reduce and the D18a code for one action by one seat on `state`; never throws. */
export function probeIssues(state: GameState, seat: Seat, action: Action): readonly string[] {
  const cmd = { by: seat, action };
  const r = reduce(state, cmd);
  const tag = `probe ${JSON.stringify(cmd)} in ${state.phase.name}`;
  if (!r.ok && r.reason === 'internal_error') return [`${tag}: internal_error`];
  const out: string[] = [];
  const turn = expectedTurnCode(state, seat, action.type);
  if (turn !== null) {
    if (r.ok || r.reason !== turn) out.push(`${tag}: expected ${turn}, got ${r.ok ? 'ok' : r.reason}`);
    return out;
  }
  if (!r.ok && reasonCategory(r.reason) !== 'rule') out.push(`${tag}: passed the turn checks but got turn code ${r.reason}`);
  const described = describes(state, seat, legalActions(state, seat), action);
  // proposeTrade's descriptor is only the flag, so only "accepted ⇒ described" is exact for it.
  if (action.type === 'proposeTrade' ? r.ok && !described : r.ok !== described) {
    out.push(`${tag}: reduce ${r.ok ? 'ok' : r.reason} but descriptor says ${described}`);
  }
  return out;
}

export interface WalkSummary {
  readonly runs: number;
  readonly steps: number;
  readonly gameOvers: number;
  readonly failures: readonly string[];
}

/**
 * Playouts with seeds `first .. first + runs - 1`. After every accepted step: validateInvariants, the winner assertion,
 * the CatanCore step relation and state invariants (V39), and PROBES_PER_STEP arbitrary actions from random seats.
 */
export function walk(first: number, runs: number, maxSteps = 2000): WalkSummary {
  let steps = 0;
  let gameOvers = 0;
  const failures: string[] = [];
  for (let seed = first; seed < first + runs; seed++) {
    const rand = prng(seed ^ 0x5eed);
    const result = playout({
      seed,
      playerCount: seed % 2 === 0 ? 4 : 3,
      maxSteps,
      // A mix of uniform and build-first playouts: uniform ones reach odd states, build-first ones reach gameOver.
      greed: seed % 4 === 0 ? 0 : 0.8,
      onStep: ({ pre, command, post }) => {
        const issues = [
          ...validateInvariants(post).map((i) => `invariant ${i.code}: ${i.detail}`),
          ...winnerIssues(post).map((i) => `${i.code}: ${i.detail}`),
          ...v39StepIssues(pre, command, post).map((i) => `V39 ${i}`),
          ...v39StateIssues(post).map((i) => `V39 ${i}`),
        ];
        for (let k = 0; k < PROBES_PER_STEP; k++) {
          const seat = Math.floor(rand() * post.playerCount) as Seat;
          issues.push(...probeIssues(post, seat, arbitraryAction(post, rand)));
        }
        return issues;
      },
    });
    steps += result.steps;
    if (result.final.phase.name === 'gameOver') gameOvers++;
    if (result.failure) {
      const f = result.failure;
      failures.push(`seed ${seed} step ${f.index} ${JSON.stringify(f.command)}: ${f.issues.join(' | ')}`);
    }
  }
  return { runs, steps, gameOvers, failures };
}

/** Walker shards: the PR-time playouts are split over this many test files, which vitest runs in parallel. */
export const SHARDS = 4;

/** The seed range [first, first + runs) of `shard` when `total` playouts are split over SHARDS. */
export function shardRange(shard: number, total: number): { readonly first: number; readonly runs: number } {
  const per = Math.ceil(total / SHARDS);
  return { first: 1 + shard * per, runs: Math.max(0, Math.min(per, total - shard * per)) };
}
