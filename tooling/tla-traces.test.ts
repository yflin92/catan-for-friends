// V39 trace import: every TLC CatanTrade cover trace in
// packages/engine/src/__fixtures__/tla-traces/ replays through the engine with the model's outcome at every delivered
// step and the model's observable state after every step (mapping in packages/engine/src/__integration__/tla-trace.ts).
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decided, replayTrace, traceSteps } from '../packages/engine/src/__integration__/tla-trace';

// HEXLANDS_TLA_TRACES_DIR replays a freshly generated set instead (nightly: docs/tla/dump-traces.sh).
const override = process.env['HEXLANDS_TLA_TRACES_DIR'];
const DIR = override ? new URL(`file://${override.replace(/\/?$/, '/')}`) : new URL('../packages/engine/src/__fixtures__/tla-traces/', import.meta.url);
const files = readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();
const load = (f: string): unknown => JSON.parse(readFileSync(new URL(f, DIR), 'utf8'));

describe('V39: TLC CatanTrade traces replay through the engine', () => {
  it('the cover traces are all present', () => {
    expect(files).toEqual(expect.arrayContaining([
      'CoverA.json', 'CoverB.json', 'CoverC.json', 'CoverD.json', 'CoverE.json', 'CoverFStale.json', 'CoverGameOver.json',
      'CoverSelfAccept.json',
    ]));
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
});
