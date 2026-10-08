import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FAULT_POINTS, InjectedFault, NoFaults } from './faults';
import { NoSecrets } from './secrets';
import { gateTestHooks } from './test-hooks';
import { ArmableFaults, RecordingSecrets } from './testing';

const ctx = { gameId: 'g1', seq: 3 };

describe('fault points (TH9)', () => {
  it('NoFaults ignores every point', () => {
    for (const p of FAULT_POINTS) expect(() => NoFaults.hit(p, ctx)).not.toThrow();
  });

  it('ArmableFaults throws once by default and records every hit', () => {
    const f = new ArmableFaults().arm('beforePersist', 'throw');
    expect(() => f.hit('afterPersistBeforeAck', ctx)).not.toThrow();
    expect(() => f.hit('beforePersist', ctx)).toThrow(InjectedFault);
    expect(() => f.hit('beforePersist', ctx)).not.toThrow();
    expect(f.hits().map((h) => h.point)).toEqual(['afterPersistBeforeAck', 'beforePersist', 'beforePersist']);
  });

  it('filters by gameId and seq, honours times, and disarms', () => {
    const f = new ArmableFaults().arm('beforeSnapshot', 'throw', { gameId: 'g2', seq: 7, times: 2 });
    expect(() => f.hit('beforeSnapshot', { gameId: 'g1', seq: 7 })).not.toThrow();
    expect(() => f.hit('beforeSnapshot', { gameId: 'g2', seq: 6 })).not.toThrow();
    expect(() => f.hit('beforeSnapshot', { gameId: 'g2', seq: 7 })).toThrow(InjectedFault);
    expect(() => f.hit('beforeSnapshot', { gameId: 'g2', seq: 7 })).toThrow(InjectedFault);
    expect(() => f.hit('beforeSnapshot', { gameId: 'g2', seq: 7 })).not.toThrow();
    f.arm('duringDrain', 'throw', { times: Infinity });
    f.disarm('duringDrain');
    expect(() => f.hit('duringDrain', ctx)).not.toThrow();
  });

  it('{delayMs} blocks synchronously', () => {
    const f = new ArmableFaults().arm('beforePersist', { delayMs: 60 });
    const start = performance.now();
    f.hit('beforePersist', ctx);
    expect(performance.now() - start).toBeGreaterThanOrEqual(55);
  });

  it("'crash' kills the process with SIGKILL", () => {
    const faults = path.join(path.dirname(fileURLToPath(import.meta.url)), 'faults.ts');
    const script = `import(${JSON.stringify(faults)}).then((m) => { m.performFault('beforePersist', 'crash'); setTimeout(() => process.exit(0), 2000); });`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 10_000 });
    expect(r.signal).toBe('SIGKILL');
  });
});

describe('test-hook gate (TH9, TH12, ruling G5/G-A)', () => {
  const faults = new ArmableFaults().arm('beforePersist', 'throw');
  const secrets = new RecordingSecrets();
  const testHooks = { seedFor: () => ({ seed: 's' }) };

  it('passes supplied hooks through when enabled', () => {
    const g = gateTestHooks(true, { faults, secrets, testHooks });
    expect(g).toEqual({ faults, secrets, testHooks, ignored: false });
  });

  it('uses inert defaults when enabled but nothing is supplied', () => {
    const g = gateTestHooks(true, {});
    expect(g.faults).toBe(NoFaults);
    expect(g.secrets).toBe(NoSecrets);
    expect(g.testHooks).toEqual({});
    expect(g.ignored).toBe(false);
  });

  it('drops every supplied hook when disabled and reports it', () => {
    const g = gateTestHooks(false, { faults, secrets, testHooks });
    expect(g.faults).toBe(NoFaults);
    expect(g.secrets).toBe(NoSecrets);
    expect(g.testHooks).toEqual({});
    expect(g.ignored).toBe(true);
    expect(() => g.faults.hit('beforePersist', ctx)).not.toThrow();
    expect(gateTestHooks(false, {}).ignored).toBe(false);
  });

  it('RecordingSecrets keeps values by kind', () => {
    const s = new RecordingSecrets();
    s.record('roomCode', 'ABCDEF');
    s.record('seatToken', 'tok');
    expect(s.valuesOf('roomCode')).toEqual(['ABCDEF']);
    expect(s.valuesOf()).toEqual(['ABCDEF', 'tok']);
  });
});
