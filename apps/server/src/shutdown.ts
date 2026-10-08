// ShutdownCoordinator (design §5.8, ADR-0005; AC27): SIGTERM/SIGINT or RunningServer.drain() → drain-and-flush.
//
// 1. Draining: /healthz, new upgrades and POST /api/rooms → 503 (never counted as errors); deploy.forced is reported.
// 2. action/lobby/control → error/server_draining. The commit path is synchronous, so no command is half-applied when
//    the flag flips.
// 3. Run every stop registered through ServerContext.onDrainStop (the AbandonmentJob registers there), before any
//    snapshot.
// 4. Snapshot every loaded game at head, each after faults.hit('duringDrain').
// 5. Close every socket with 1012 (disconnect reason server_restart); wait ≤ 1 s.
// 6. Shutdown marker, wal_checkpoint(TRUNCATE), close the DB and the listener, server.stopped, then the telemetry
//    flush (≤ 2 s), so that server.stopped is part of it. The caller exits.
// Steps 1–6 run inside one root server.drain span, which ends before the flush starts. Every step is independent: one
// that throws is reported as a fault (catan.errors{component}, action.error kind drain.<step>), marks the drain span
// ERROR, and the next step runs.
// ops.drainTimeoutSec bounds steps 4–5: once it passes, the remaining snapshots are skipped (the log already holds
// every acked command) and sockets are terminated without waiting. Deadlines are wall-clock: they bound real I/O within
// the platform's kill grace, which an injected FakeClock would never advance.
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { SpanKind, type Span } from '@opentelemetry/api';
import { CloseCode } from '@hexlands/protocol';
import { logEvent, reportFault, type LogEventFields } from './log-events';
import type { RoomManager } from './room-manager';
import type { ServerContext } from './server';
import { markFailed, withRootSpanAsync, type Telemetry } from './telemetry';
import type { WsGateway } from './ws-gateway';

type FaultComponent = LogEventFields['action.error']['component'];

/** Longest wait for sockets to finish their closing handshake (design §5.8 step 5). */
export const SOCKET_CLOSE_WAIT_MS = 1000;
/** Longest wait for the final telemetry flush and shutdown (design §5.8 step 6). */
export const TELEMETRY_FLUSH_MS = 2000;
/** Name of the forced-deploy marker that deploy.sh --force leaves next to the database (design §9.5). */
export const DEPLOY_FORCED_FILE = 'deploy-forced';

export interface ShutdownParts {
  readonly ctx: ServerContext;
  readonly rooms: RoomManager;
  readonly gateway: WsGateway;
  /** Stops registered through ServerContext.onDrainStop, in registration order. */
  readonly drainStops: readonly (() => void)[];
  /** Flips the HTTP surface (/healthz, POST /api/rooms) to 503. */
  setDraining(): void;
  /** Stops the HTTP listener and resolves once it is closed. */
  closeHttp(): Promise<void>;
}

export class ShutdownCoordinator {
  private running: Promise<void> | null = null;

  constructor(private readonly parts: ShutdownParts) {}

  /** Runs the drain once; later calls return the same promise. Never rejects. */
  drain(): Promise<void> {
    this.running ??= this.run();
    return this.running;
  }

  private async run(): Promise<void> {
    const { ctx } = this.parts;
    try {
      // One root server.drain span (design §9.3) over steps 1–6. It ends before the telemetry flush, so it is exported
      // by that flush and never adds to its time box.
      await withRootSpanAsync(ctx.telemetry.tracer, 'server.drain', SpanKind.INTERNAL, {}, (span) => this.steps(span));
    } catch {
      // The span carries the failure (status ERROR); the flush still runs and the caller still exits.
    }
    await flushTelemetry(ctx.telemetry);
  }

  /**
   * Drain steps 1–6. Steps 1–4 run synchronously within drain(), so no timer fires after the drain begins (D22). Each
   * step is independent: a step that throws is reported (catan.errors{component} plus an ERROR
   * action.error with kind drain.<step> and the error type only) and the drain carries on, so the later steps and
   * server.stopped still happen.
   */
  private async steps(span: Span): Promise<void> {
    const { ctx, rooms, gateway } = this.parts;
    const started = performance.now();
    const deadline = started + ctx.config.ops.drainTimeoutSec * 1000;
    const left = () => deadline - performance.now();

    // Steps 1–2.
    this.step(span, 'http', 'set_draining', () => this.parts.setDraining());
    rooms.draining = true;
    this.step(span, 'ws', 'gateway_draining', () => gateway.setDraining(true));
    logEvent(ctx.telemetry, 'server.draining', {});
    this.reportForcedDeploy();

    // Step 3, one stop at a time.
    for (const stop of this.parts.drainStops) this.step(span, 'job', 'stop', stop);

    // Step 4, one game at a time, until the deadline.
    let flushed = 0;
    for (const room of rooms.loadedRooms()) {
      if (left() <= 0) break;
      this.step(span, 'persist', 'snapshot', () => {
        if (room.flushSnapshot()) flushed += 1;
      });
    }

    // Step 5.
    await this.stepAsync(span, 'ws', 'close_sockets', () => gateway.close(CloseCode.SERVICE_RESTART, 'drain', Math.min(SOCKET_CLOSE_WAIT_MS, Math.max(0, left()))));

    // Step 6. Without the marker the next start reads as unclean and replays from the snapshots, which is still lossless.
    this.step(span, 'persist', 'shutdown_marker', () => ctx.store.writeShutdownMarker(ctx.clock.now()));
    this.step(span, 'persist', 'checkpoint', () => ctx.store.checkpoint());
    this.step(span, 'persist', 'close_store', () => ctx.store.close());
    await this.stepAsync(span, 'http', 'close_http', () => this.parts.closeHttp());
    span.setAttributes({ 'catan.drain.games_flushed': flushed, 'catan.drain.deadline_hit': left() <= 0 });
    logEvent(ctx.telemetry, 'server.stopped', { drain_ms: Math.round(performance.now() - started), games_flushed: flushed });
  }

  /** Runs one synchronous drain step; a throw is reported, marks the drain span ERROR, and is swallowed. */
  private step(span: Span, component: FaultComponent, kind: string, run: () => unknown): void {
    try {
      run();
    } catch (err) {
      this.fault(span, component, kind, err);
    }
  }

  /** stepAsync for a step that returns a promise; a rejection is handled the same way. */
  private async stepAsync(span: Span, component: FaultComponent, kind: string, run: () => Promise<unknown>): Promise<void> {
    try {
      await run();
    } catch (err) {
      this.fault(span, component, kind, err);
    }
  }

  private fault(span: Span, component: FaultComponent, kind: string, err: unknown): void {
    markFailed(span, err);
    reportFault(this.parts.ctx.telemetry, { component, kind: `drain.${kind}`, error: err instanceof Error ? err.name : 'unknown' });
  }

  /** deploy.forced {active_games} (WARN) when deploy.sh --force left its marker; the marker is then removed. */
  private reportForcedDeploy(): void {
    const { ctx, rooms } = this.parts;
    if (ctx.dbPath === ':memory:') return;
    const marker = path.join(path.dirname(ctx.dbPath), DEPLOY_FORCED_FILE);
    try {
      if (!existsSync(marker)) return;
      logEvent(ctx.telemetry, 'deploy.forced', { active_games: rooms.countByState().active });
      rmSync(marker, { force: true });
    } catch {
      // A marker that cannot be read or removed never blocks the drain.
    }
  }
}

/**
 * Flushes and shuts telemetry down within TELEMETRY_FLUSH_MS (wall clock). A timeout or failure is logged as WARN
 * telemetry.flush_failed (it still reaches stdout) and never rejects.
 */
export async function flushTelemetry(telemetry: Telemetry, limitMs: number = TELEMETRY_FLUSH_MS): Promise<void> {
  await within(telemetry, limitMs, async () => {
    await telemetry.forceFlush();
    await telemetry.shutdown();
  });
}

/**
 * Exports everything recorded so far within TELEMETRY_FLUSH_MS, keeping telemetry running (used at boot so the
 * zero-initialised alerting counters reach the backend before the boot events). Same failure handling as
 * flushTelemetry; never rejects.
 */
export async function forceFlushWithin(telemetry: Telemetry, limitMs: number = TELEMETRY_FLUSH_MS): Promise<void> {
  await within(telemetry, limitMs, () => telemetry.forceFlush());
}

async function within(telemetry: Telemetry, limitMs: number, run: () => Promise<void>): Promise<void> {
  const work = run();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), limitMs);
    timer.unref();
  });
  const result = await Promise.race([work.then(() => 'ok' as const, () => 'error' as const), timeout]);
  clearTimeout(timer);
  if (result !== 'ok') {
    work.catch(() => undefined);
    logEvent(telemetry, 'telemetry.flush_failed', { cause: result });
  }
}

/**
 * Production signal wiring: SIGTERM and SIGINT start the drain once, then exit(0). A second signal during the drain is
 * ignored. Returns a function that removes the handlers.
 */
export function exitOnShutdownSignals(
  server: { drain(): Promise<void> },
  proc: Pick<NodeJS.Process, 'on' | 'off' | 'exit'> = process,
): () => void {
  let started = false;
  const onSignal = () => {
    if (started) return;
    started = true;
    void server.drain().finally(() => proc.exit(0));
  };
  proc.on('SIGTERM', onSignal);
  proc.on('SIGINT', onSignal);
  return () => {
    proc.off('SIGTERM', onSignal);
    proc.off('SIGINT', onSignal);
  };
}
