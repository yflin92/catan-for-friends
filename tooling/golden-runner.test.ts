// E-INT golden runner (verification plan V15 (a)–(g), V39; AC19): replays EVERY fixture in
// packages/engine/src/__fixtures__/golden/ — V-a's v15-*.json and Build's eint-*.json — and asserts, at every step:
// - accepted steps: ok, the recorded events and the recorded stateHash;
// - rejection steps: the recorded reason and an unchanged stateHash;
// - after each accepted step: validateInvariants, the gameOver winner assertion, and the CatanCore step relation and
//   state invariants (V39).
// Golden (g) must cover every EngineReasonCode except internal_error, which reduce returns only for an engine fault.
// The fixtures are only read here; tooling/v15-golden.ts and tooling/eint-golden.ts write them.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createGame, reduce, stateHash, type Command, type EngineReasonCode, type GameEvent, type GameInit, type GameState } from '../packages/engine/src/index';
import { ReasonCode } from '../packages/engine/src/reasons';
import { buildState, validateInvariants, type StateSpec } from '../packages/engine/src/testing/index';
import { winnerIssues } from '../packages/engine/src/__integration__/oracle';
import { v39StateIssues, v39StepIssues } from '../packages/engine/src/__integration__/v39';

const DIR = new URL('../packages/engine/src/__fixtures__/golden/', import.meta.url);

interface Step {
  readonly command: Command;
  readonly rejected?: EngineReasonCode;
  readonly events: readonly GameEvent[];
  readonly stateHash: string;
}
interface Case {
  readonly name: string;
  readonly init?: GameInit;
  readonly buildStateSpec?: StateSpec;
  readonly initialStateHash: string;
  readonly steps: readonly Step[];
}
interface Fixture {
  readonly description?: string;
  readonly init?: GameInit;
  readonly buildStateSpec?: StateSpec;
  readonly initialStateHash?: string;
  readonly steps?: readonly Step[];
  readonly cases?: readonly Case[];
}

const files = readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();
const load = (file: string): Fixture => JSON.parse(readFileSync(new URL(file, DIR), 'utf8')) as Fixture;

/** A fixture's cases: its `cases`, or the fixture itself when it has a single start. */
function casesOf(file: string, f: Fixture): readonly Case[] {
  if (f.cases) return f.cases;
  return [{ name: file, init: f.init, buildStateSpec: f.buildStateSpec, initialStateHash: f.initialStateHash!, steps: f.steps! } as Case];
}

function start(c: Case): GameState {
  if (c.init) {
    const created = createGame(c.init);
    if (!created.ok) throw new Error(`createGame rejected ${JSON.stringify(c.init)}`);
    return created.state;
  }
  return buildState(c.buildStateSpec!);
}

/** Replays one case; returns the first mismatch per step (empty = byte-exact and every check holds). */
function replayCase(c: Case): { issues: string[]; rejected: EngineReasonCode[]; final: GameState } {
  const issues: string[] = [];
  const rejected: EngineReasonCode[] = [];
  let s = start(c);
  if (stateHash(s) !== c.initialStateHash) issues.push('initial stateHash differs');
  c.steps.forEach((step, i) => {
    const at = `step ${i} ${JSON.stringify(step.command)}`;
    const r = reduce(s, step.command);
    if (step.rejected !== undefined) {
      rejected.push(step.rejected);
      if (r.ok || r.reason !== step.rejected) issues.push(`${at}: expected ${step.rejected}, got ${r.ok ? 'ok' : r.reason}`);
      if (stateHash(s) !== step.stateHash) issues.push(`${at}: stateHash moved on a rejection`);
      return;
    }
    if (!r.ok) {
      issues.push(`${at}: rejected with ${r.reason}`);
      return;
    }
    if (JSON.stringify(r.events) !== JSON.stringify(step.events)) issues.push(`${at}: events differ`);
    if (stateHash(r.state) !== step.stateHash) issues.push(`${at}: stateHash differs`);
    issues.push(
      ...validateInvariants(r.state).map((x) => `${at}: invariant ${x.code}: ${x.detail}`),
      ...winnerIssues(r.state).map((x) => `${at}: ${x.code}: ${x.detail}`),
      ...v39StepIssues(s, step.command, r.state).map((x) => `${at}: V39 ${x}`),
      ...v39StateIssues(r.state).map((x) => `${at}: V39 ${x}`),
    );
    s = r.state;
  });
  return { issues, rejected, final: s };
}

describe('golden fixtures directory', () => {
  it('holds V-a\'s V15 fixtures (setup, bank shortage, full 4p/3p games) and E-INT\'s (c), (d), (f), (g)', () => {
    expect(files).toEqual(
      expect.arrayContaining([
        'v15-setup-4p.json', 'v15-setup-3p.json', 'v15e-bank-shortage.json', 'v15-game-4p.json', 'v15-game-3p.json',
        'eint-c-dev-cards.json', 'eint-d-awards.json', 'eint-f-seven.json', 'eint-g-rejections.json',
      ]),
    );
  });
});

describe.each(files)('golden %s', (file) => {
  const fixture = load(file);
  it.each(casesOf(file, fixture).map((c) => [c.name, c] as const))('%s: every step replays byte-exactly and passes every check', (_name, c) => {
    expect(replayCase(c).issues).toEqual([]);
  });
});

describe('golden (a)/(b): the full games end in gameOver for the active seat', () => {
  it.each(['v15-game-4p.json', 'v15-game-3p.json'])('%s', (file) => {
    const [c] = casesOf(file, load(file));
    const { final } = replayCase(c!);
    expect(final.phase.name).toBe('gameOver');
    expect(winnerIssues(final)).toEqual([]);
  });
});

describe('golden (g): every engine rejection path', () => {
  it('covers every EngineReasonCode except internal_error', () => {
    const seen = new Set(casesOf('eint-g-rejections.json', load('eint-g-rejections.json')).flatMap((c) => replayCase(c).rejected));
    const engineCodes: readonly EngineReasonCode[] = [
      'not_your_turn', 'wrong_phase', 'discard_pending', 'insufficient_resources', 'no_pieces_left', 'invalid_location',
      'occupied', 'distance_rule', 'not_connected', 'robber_must_move', 'invalid_robber_hex', 'invalid_steal_target',
      'wrong_discard_count', 'discard_not_required', 'dev_deck_empty', 'dev_card_not_owned', 'dev_card_bought_this_turn',
      'dev_card_already_played', 'bank_insufficient', 'invalid_trade', 'trade_not_found', 'trade_stale',
      'trade_not_accepted', 'skip_not_allowed', 'game_over', 'malformed_action',
    ];
    for (const code of engineCodes) expect(ReasonCode[code]).toBeDefined();
    expect([...seen].sort()).toEqual([...engineCodes].sort());
  });

  it('a replay mismatch is reported: a corrupted hash, event list or reason fails the runner', () => {
    const [c] = casesOf('eint-d-awards.json', load('eint-d-awards.json'));
    const corrupt = (f: (s: Step) => Step): Case => ({ ...c!, steps: c!.steps.map((s, i) => (i === 0 ? f(s) : s)) });
    expect(replayCase(corrupt((s) => ({ ...s, stateHash: `0${s.stateHash.slice(1)}` }))).issues.join()).toMatch(/stateHash differs/);
    expect(replayCase(corrupt((s) => ({ ...s, events: [] }))).issues.join()).toMatch(/events differ/);
    expect(replayCase(corrupt((s) => ({ ...s, rejected: 'occupied' }))).issues.join()).toMatch(/expected occupied, got ok/);
  });
});
