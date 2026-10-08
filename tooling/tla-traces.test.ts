// V39 trace import: every TLC CatanTrade cover trace in
// packages/engine/src/__fixtures__/tla-traces/ replays through the engine with the model's outcome at every delivered
// step, the model's observable state after every step and the withdrawal event at every exit from main (mapping in packages/engine/src/__integration__/tla-trace.ts).
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { GameEvent } from '../packages/engine/src/events';
import { decided, replayTrace, traceSteps, withdrawalIssues, type TradeState } from '../packages/engine/src/__integration__/tla-trace';

// HEXLANDS_TLA_TRACES_DIR replays a freshly generated set instead (nightly: docs/tla/dump-traces.sh).
const override = process.env['HEXLANDS_TLA_TRACES_DIR'];
const DIR = override ? new URL(`file://${override.replace(/\/?$/, '/')}`) : new URL('../packages/engine/src/__fixtures__/tla-traces/', import.meta.url);
const files = readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();
const load = (f: string): unknown => JSON.parse(readFileSync(new URL(f, DIR), 'utf8'));

describe('V39: TLC CatanTrade traces replay through the engine', () => {
  it('the cover traces are all present', () => {
    expect(files).toEqual(expect.arrayContaining([
      'CoverA.json', 'CoverB.json', 'CoverC.json', 'CoverD.json', 'CoverE.json', 'CoverFStale.json', 'CoverGameOver.json',
      'CoverSelfAccept.json', 'CoverWithdrawEnd.json', 'CoverWithdrawStep.json',
    ]));
  });

  it('the withdrawal covers leave main with an offer open: by endTurn into preRoll, by a PhaseStep into moveRobber', () => {
    expect(replayTrace(load('CoverWithdrawEnd.json')).withdrawnInto).toEqual(['preRoll']);
    expect(replayTrace(load('CoverWithdrawStep.json')).withdrawnInto).toEqual(['moveRobber']);
  });

  it.each(files)('%s: every delivered intent gets the model outcome and the state matches after every step', (f) => {
    const report = replayTrace(load(f));
    expect(report.issues).toEqual([]);
    expect(report.skipped).toEqual([]);
    expect(report.delivered).toBeGreaterThan(0);
  });

  it('the traces exercise every trade intent and the turn-level codes they were generated for', () => {
    const seen = new Set<string>();
    for (const f of files) {
      for (const step of traceSteps(load(f))) {
        if (step.name !== 'Deliver') continue;
        const d = decided(step);
        if (d) seen.add(`${d.message.act.kind}:${d.outcome}`);
      }
    }
    for (const want of ['propose:ok', 'accept:ok', 'confirm:trade_stale', 'accept:wrong_phase', 'accept:not_your_turn', 'accept:trade_not_found']) {
      expect([...seen]).toContain(want);
    }
    expect([...seen].some((x) => x.endsWith(':discard_pending'))).toBe(true);
    expect([...seen].some((x) => x.endsWith(':game_over'))).toBe(true);
  });

  it('a divergence is reported: a trace whose recorded outcome is flipped fails', () => {
    const trace = load('CoverFStale.json') as { counterexample: { action: [unknown, { name: string }, [number, { outcome: Record<string, string> }]][] } };
    const last = trace.counterexample.action.at(-1)!;
    const key = Object.keys(last[2][1].outcome).find((k) => last[2][1].outcome[k] === 'trade_stale')!;
    last[2][1].outcome[key] = 'ok';
    expect(replayTrace(trace).issues.join()).toMatch(/engine trade_stale, model ok/);
  });

  // CoverFStale ends in main with offer 1 open. Exits from main appended to it check the withdrawal event the importer
  // asserts: tradeResolved{withdrawn} for that offer, exitTo = the model's new phase.
  type Step = [[number, TradeState], { name: string }, [number, TradeState]];
  const NO_OFFER = { id: 0, from: -1, give: { a: 0, b: 0 }, get: { a: 0, b: 0 }, accepted: [] };
  function withExit(build: (last: TradeState) => { name: string; post: TradeState }): unknown {
    const trace = load('CoverFStale.json') as { counterexample: { action: Step[] } };
    const [, , [n, last]] = trace.counterexample.action.at(-1)!;
    expect(last.phase).toBe('main');
    expect(last.offer.id).not.toBe(0);
    const { name, post } = build(last);
    trace.counterexample.action.push([[n, last], { name }, [n + 1, post]]);
    return trace;
  }

  it.each(['preRoll', 'moveRobber', 'gameOver', 'discard'] as const)('a PhaseStep from main into %s withdraws the open offer with that exitTo', (phase) => {
    const report = replayTrace(withExit((last) => ({ name: 'PhaseStep', post: { ...last, phase, offer: NO_OFFER } })));
    expect(report.issues).toEqual([]);
    expect(report.withdrawnInto).toEqual([phase]);
  });

  it('an endTurn delivered in main withdraws the open offer with exitTo preRoll', () => {
    const report = replayTrace(withExit((last) => {
      const seats = Object.keys(last.hand).length;
      const m = { aid: [99, 1] as const, seat: last.active, act: { kind: 'endTurn' as const, oid: 0, give: {}, get: {}, with: -1 } };
      const outcome = { ...(Array.isArray(last.outcome) ? {} : last.outcome), '<<99, 1>>': 'ok' };
      return { name: 'Deliver', post: { ...last, phase: 'preRoll', active: (last.active + 1) % seats, offer: NO_OFFER, net: [...last.net, m], outcome } };
    }));
    expect(report.issues).toEqual([]);
    expect(report.withdrawnInto).toEqual(['preRoll']);
  });

  it('a missing, misdirected or unowed withdrawal is reported', () => {
    const pre = { phase: 'main', offer: { id: 1 } } as unknown as TradeState;
    const post = { phase: 'moveRobber', offer: { id: 0 } } as unknown as TradeState;
    const withdrawn = (exitTo: 'moveRobber' | 'preRoll'): GameEvent => ({ kind: 'tradeResolved', tradeId: 1, outcome: 'withdrawn', partner: null, exitTo });
    expect(withdrawalIssues([withdrawn('moveRobber')], pre, post)).toEqual([]);
    expect(withdrawalIssues([], pre, post)).toHaveLength(1);
    expect(withdrawalIssues([withdrawn('preRoll')], pre, post)).toHaveLength(1);
    expect(withdrawalIssues([withdrawn('moveRobber'), withdrawn('moveRobber')], pre, post)).toHaveLength(1);
    expect(withdrawalIssues([withdrawn('moveRobber')], pre, { ...pre })).toHaveLength(1);
  });
});
