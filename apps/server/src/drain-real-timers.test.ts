// verify-Va #83: D22 with real timers, the deadline with throwing/hanging steps, no message in logs or span events.
import { describe, expect, it } from 'vitest';
import { loadServerConfig } from './config';
import type { RoomManager } from './room-manager';
import type { ServerContext } from './server';
import { ShutdownCoordinator, TELEMETRY_FLUSH_MS } from './shutdown';
import { createTelemetry } from './telemetry';
import type { WsGateway } from './ws-gateway';

function coordinator(opts: { throwAll?: boolean; throwFirst?: boolean; hangClose?: boolean; stop?: () => void }) {
  const boom = (n: string) => { if (opts.throwAll) throw new RangeError(`${n} SECRETROOM token=SECRETTOKEN`); };
  const telemetry = createTelemetry({ mode: 'memory', environment: 'dev', serviceVersion: 'unit' });
  const store = { writeShutdownMarker: () => boom('m'), checkpoint: () => boom('c'), close: () => boom('s') };
  const ctx = { config: loadServerConfig({}), store, dbPath: ':memory:', telemetry, clock: { now: () => 0 } } as unknown as ServerContext;
  let closeWait = -1;
  const rooms = { draining: false, loadedRooms: () => [{ flushSnapshot: () => { boom('snap'); return true; } }, { flushSnapshot: () => true }], countByState: () => ({ active: 0 }) } as unknown as RoomManager;
  const gateway = {
    setDraining: () => boom('g'),
    close: (_c: number, _r: string, wait: number) => { closeWait = wait; return opts.hangClose ? new Promise((_, rej) => setTimeout(() => rej(new Error('close SECRETTOKEN')), wait)) : opts.throwAll ? Promise.reject(new Error('SECRETROOM')) : Promise.resolve(); },
  } as unknown as WsGateway;
  const c = new ShutdownCoordinator({
    ctx, rooms, gateway,
    drainStops: [() => boom('stop'), opts.stop ?? (() => undefined)],
    setDraining: () => { if (opts.throwFirst || opts.throwAll) throw new Error('first SECRETROOM'); },
    closeHttp: () => (opts.throwAll ? Promise.reject(new Error('http SECRETTOKEN')) : Promise.resolve()),
  });
  return { c, telemetry, closeWait: () => closeWait };
}

describe('verify-Va #83', () => {
  it('D22: a job timer already DUE when drain() is called never fires (steps 1–3 run synchronously), even when step 1 throws', async () => {
    let fired = 0;
    const t = setTimeout(() => (fired += 1), 0);
    const until = performance.now() + 5; while (performance.now() < until) { /* make the timer due */ }
    const { c } = coordinator({ throwFirst: true, stop: () => clearTimeout(t) });
    await c.drain();
    await new Promise((r) => setTimeout(r, 20));
    expect(fired).toBe(0);
  });

  it('every step throws and the socket close hangs for its full wait: resolves within drainTimeoutSec + flush bound; counts per component; no message anywhere', async () => {
    const { c, telemetry, closeWait } = coordinator({ throwAll: true, hangClose: true });
    const t0 = performance.now();
    await expect(c.drain()).resolves.toBeUndefined();
    const ms = performance.now() - t0;
    const deadline = loadServerConfig({}).ops.drainTimeoutSec * 1000;
    const errs = Object.fromEntries((telemetry.metrics()['catan.errors']?.points ?? []).filter((p) => (p.value ?? 0) > 0).map((p) => [p.attributes['component'], p.value]));
    const logs = telemetry.logs().map((r) => JSON.parse(r.body as string) as Record<string, unknown>);
    const kinds = logs.filter((e) => e['event'] === 'action.error').map((e) => e['kind']);
    const span = telemetry.spans().find((x) => x.name === 'server.drain')!;
    expect(ms).toBeLessThan(deadline + TELEMETRY_FLUSH_MS);
    expect(closeWait()).toBeLessThanOrEqual(deadline);
    expect(errs).toEqual({ http: 2, ws: 2, job: 1, persist: 4 });
    expect(kinds).toEqual(['drain.set_draining', 'drain.gateway_draining', 'drain.stop', 'drain.snapshot', 'drain.close_sockets', 'drain.shutdown_marker', 'drain.checkpoint', 'drain.close_store', 'drain.close_http']);
    expect(logs.filter((e) => e['event'] === 'server.stopped')).toHaveLength(1);
    const dump = JSON.stringify([logs, span.attributes, span.events, span.status]);
    expect(dump).not.toContain('SECRETROOM');
    expect(dump).not.toContain('SECRETTOKEN');
  }, 30_000);
});
