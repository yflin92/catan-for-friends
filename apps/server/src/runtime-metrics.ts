// Runtime whitelist (design §9.2: CPU, RSS, heap, event-loop delay p50/p99/max, fds, uptime; 10 series, ≤ 15, no labels;
// auto-instrumentation stays off) and catan.disk.free (statfs on the data directory every 60 s, G6). Names carry no unit
// suffix; units are in `unit`, and CPU time is cumulative (observable counters).
import { readdirSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { CATALOGUE, registerGauge, serverMetrics } from './metrics';
import type { Clock, Scheduler } from './clock';
import type { Telemetry } from './telemetry';

export const DISK_POLL_MS = 60_000;

/** The event-loop delay histogram (perf_hooks IntervalHistogram, in nanoseconds). */
export interface EventLoopDelay {
  percentile(p: number): number;
  readonly max: number;
  reset(): void;
  enable(): void;
  disable(): void;
}

type Sample = Readonly<Record<'p50' | 'p99' | 'max', number>>;

/** Every runtime instrument: name, kind and unit. Each is one series. */
export const RUNTIME_INSTRUMENTS = [
  { name: 'catan.runtime.cpu.user', kind: 'counter', unit: 's' },
  { name: 'catan.runtime.cpu.system', kind: 'counter', unit: 's' },
  { name: 'catan.runtime.memory.rss', kind: 'gauge', unit: 'By' },
  { name: 'catan.runtime.memory.heap_used', kind: 'gauge', unit: 'By' },
  { name: 'catan.runtime.memory.heap_total', kind: 'gauge', unit: 'By' },
  { name: 'catan.runtime.event_loop.delay.p50', kind: 'gauge', unit: 's' },
  { name: 'catan.runtime.event_loop.delay.p99', kind: 'gauge', unit: 's' },
  { name: 'catan.runtime.event_loop.delay.max', kind: 'gauge', unit: 's' },
  { name: 'catan.runtime.open_fds', kind: 'gauge', unit: '{fd}' },
  { name: 'catan.runtime.uptime', kind: 'gauge', unit: 's' },
] as const;

type RuntimeName = (typeof RUNTIME_INSTRUMENTS)[number]['name'];

function openFds(): number {
  try {
    return readdirSync('/proc/self/fd').length;
  } catch {
    return 0;
  }
}

/**
 * Reads p50/p99/max of the event-loop delay once per collection, then resets the histogram, so each collection reports
 * the delay since the previous one. A collection is detected when a delay gauge is observed a second time.
 */
export function eventLoopSampler(delay: EventLoopDelay): (key: keyof Sample) => number {
  const s = (v: number) => (Number.isFinite(v) ? v / 1e9 : 0);
  let current: Sample | null = null;
  const seen = new Set<keyof Sample>();
  return (key) => {
    if (current === null || seen.has(key)) {
      current = { p50: s(delay.percentile(50)), p99: s(delay.percentile(99)), max: s(delay.max) };
      delay.reset();
      seen.clear();
    }
    seen.add(key);
    return current[key];
  };
}

/**
 * Registers the runtime instruments and the disk gauge. The disk gauge reports the last statfs of the data directory,
 * refreshed every DISK_POLL_MS through the injected scheduler, and reports nothing for an in-memory store. A failed
 * poll clears the gauge and counts catan.errors{component=telemetry}, so a statfs that keeps failing is visible
 * (alert A8 reads the gauge). Returns a stop function.
 */
export function startRuntimeMetrics(
  t: Telemetry,
  clock: Clock & Scheduler,
  dbPath: string,
  delay: EventLoopDelay = monitorEventLoopDelay({ resolution: 20 }),
  statfsOf: (dir: string) => Promise<{ bavail: number; bsize: number }> = statfs,
): () => void {
  delay.enable();
  const loop = eventLoopSampler(delay);
  const values: Readonly<Record<RuntimeName, () => number>> = {
    'catan.runtime.cpu.user': () => process.cpuUsage().user / 1e6,
    'catan.runtime.cpu.system': () => process.cpuUsage().system / 1e6,
    'catan.runtime.memory.rss': () => process.memoryUsage().rss,
    'catan.runtime.memory.heap_used': () => process.memoryUsage().heapUsed,
    'catan.runtime.memory.heap_total': () => process.memoryUsage().heapTotal,
    'catan.runtime.event_loop.delay.p50': () => loop('p50'),
    'catan.runtime.event_loop.delay.p99': () => loop('p99'),
    'catan.runtime.event_loop.delay.max': () => loop('max'),
    'catan.runtime.open_fds': openFds,
    'catan.runtime.uptime': () => process.uptime(),
  };
  for (const r of RUNTIME_INSTRUMENTS) {
    const opts = { description: 'runtime whitelist', unit: r.unit };
    const cb = () => [{ value: values[r.name]() }];
    if (r.kind === 'counter') t.observableCounter(r.name, opts, cb);
    else t.observableGauge(r.name, opts, cb);
  }

  let free: number | null = null;
  const dataDir = dbPath === ':memory:' ? null : path.dirname(path.resolve(dbPath));
  const poll = () => {
    if (dataDir === null) return;
    statfsOf(dataDir).then(
      (s) => {
        free = s.bavail * s.bsize;
      },
      () => {
        free = null;
        serverMetrics(t).errors.add(1, { component: 'telemetry' });
      },
    );
  };
  registerGauge(t, CATALOGUE.diskFree, () => (free === null ? [] : [{ value: free }]));
  poll();
  const timer = clock.setInterval(poll, DISK_POLL_MS);
  return () => {
    clock.clear(timer);
    delay.disable();
  };
}
