import { describe, expect, it, vi } from 'vitest';
import { FakeClock } from './clock';
import { eventLoopSampler, startRuntimeMetrics, type EventLoopDelay } from './runtime-metrics';
import { createTelemetry } from './telemetry';

function fakeDelay(): EventLoopDelay & { values: number[] } {
  const d = {
    values: [10e6, 20e6, 30e6],
    percentile: vi.fn((p: number) => (p === 50 ? d.values[0]! : d.values[1]!)),
    get max() {
      return d.values[2]!;
    },
    reset: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
  };
  return d;
}

describe('event-loop delay sampling', () => {
  it('reads p50/p99/max once per collection and then resets the histogram', () => {
    const d = fakeDelay();
    const read = eventLoopSampler(d);
    expect([read('p50'), read('p99'), read('max')]).toEqual([0.01, 0.02, 0.03]);
    expect(d.reset).toHaveBeenCalledTimes(1);
    d.values = [1e6, 2e6, 3e6];
    expect([read('p50'), read('p99'), read('max')]).toEqual([0.001, 0.002, 0.003]);
    expect(d.reset).toHaveBeenCalledTimes(2);
  });

  it('each metrics() collection reports the delay since the previous one', () => {
    const t = createTelemetry({ mode: 'memory', environment: 'dev', serviceVersion: 'test' });
    const d = fakeDelay();
    const stop = startRuntimeMetrics(t, new FakeClock(0), ':memory:', d);
    const p99 = () => t.metrics()['catan.runtime.event_loop.delay.p99']!.points[0]!.value;
    expect(p99()).toBe(0.02);
    d.values = [0, 5e6, 6e6];
    expect(p99()).toBe(0.005);
    expect(d.reset).toHaveBeenCalledTimes(2);
    expect(t.metrics()['catan.runtime.cpu.user']!.type).toBe('counter');
    expect(t.metrics()['catan.disk.free']!.points).toEqual([]);
    stop();
    expect(d.disable).toHaveBeenCalled();
  });
});
