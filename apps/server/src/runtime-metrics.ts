// Runtime whitelist gauges (design §9.2: CPU, RSS, heap, event-loop delay p50/p99/max, fds, uptime; ≤ 15 series, no
// labels; auto-instrumentation stays off) and catan.disk.free_bytes (statfs on the data directory every 60 s, G6).
import { readdirSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { CATALOGUE, registerGauge } from './metrics';
import type { Clock, Scheduler } from './clock';
import type { Telemetry } from './telemetry';

export const DISK_POLL_MS = 60_000;

/** The runtime gauges, each one series. */
export const RUNTIME_GAUGES = [
  'catan.runtime.cpu.user_seconds',
  'catan.runtime.cpu.system_seconds',
  'catan.runtime.memory.rss_bytes',
  'catan.runtime.memory.heap_used_bytes',
  'catan.runtime.memory.heap_total_bytes',
  'catan.runtime.event_loop.delay_p50_seconds',
  'catan.runtime.event_loop.delay_p99_seconds',
  'catan.runtime.event_loop.delay_max_seconds',
  'catan.runtime.open_fds',
  'catan.runtime.uptime_seconds',
] as const;

function openFds(): number {
  try {
    return readdirSync('/proc/self/fd').length;
  } catch {
    return 0;
  }
}

/**
 * Registers the runtime gauges and the disk gauge. The disk gauge reports the last statfs of `dataDir`, refreshed every
 * DISK_POLL_MS through the injected scheduler; it reports nothing for an in-memory store. Returns a stop function.
 */
export function startRuntimeMetrics(t: Telemetry, clock: Clock & Scheduler, dbPath: string): () => void {
  const delay = monitorEventLoopDelay({ resolution: 20 });
  delay.enable();
  const ns = (v: number) => (Number.isFinite(v) ? v / 1e9 : 0);
  const values: Readonly<Record<(typeof RUNTIME_GAUGES)[number], () => number>> = {
    'catan.runtime.cpu.user_seconds': () => process.cpuUsage().user / 1e6,
    'catan.runtime.cpu.system_seconds': () => process.cpuUsage().system / 1e6,
    'catan.runtime.memory.rss_bytes': () => process.memoryUsage().rss,
    'catan.runtime.memory.heap_used_bytes': () => process.memoryUsage().heapUsed,
    'catan.runtime.memory.heap_total_bytes': () => process.memoryUsage().heapTotal,
    'catan.runtime.event_loop.delay_p50_seconds': () => ns(delay.percentile(50)),
    'catan.runtime.event_loop.delay_p99_seconds': () => ns(delay.percentile(99)),
    'catan.runtime.event_loop.delay_max_seconds': () => ns(delay.max),
    'catan.runtime.open_fds': openFds,
    'catan.runtime.uptime_seconds': () => process.uptime(),
  };
  for (const name of RUNTIME_GAUGES) t.observableGauge(name, { description: 'runtime whitelist' }, () => [{ value: values[name]() }]);

  let free: number | null = null;
  const dataDir = dbPath === ':memory:' ? null : path.dirname(path.resolve(dbPath));
  const poll = () => {
    if (dataDir === null) return;
    statfs(dataDir).then(
      (s) => {
        free = s.bavail * s.bsize;
      },
      () => {
        free = null;
      },
    );
  };
  registerGauge(t, CATALOGUE.diskFreeBytes, () => (free === null ? [] : [{ value: free }]));
  poll();
  const timer = clock.setInterval(poll, DISK_POLL_MS);
  return () => {
    clock.clear(timer);
    delay.disable();
  };
}
