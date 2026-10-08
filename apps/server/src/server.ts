// startServer: in-process boot of the HTTP + WebSocket listener with injectable clock, store path, telemetry, fault
// points and secret registry (design §3.12; TH7, TH9, TH10, TH12, TH16).
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { SpanKind } from '@opentelemetry/api';
import type { ServerConfig } from '@hexlands/engine';
import { SystemClock, type Clock, type Scheduler } from './clock';
import { constants as fsConstants } from 'node:fs';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { ConfigError, loadProcessSettings, loadServerConfig, type DeepPartial, type ProcessSettings, type TelemetryMode } from './config';
import type { FaultPoints } from './faults';
import type { SecretRegistry } from './secrets';
import { createTelemetry, type MetricSnapshot, type ReadableLogRecord, type ReadableSpan, type Telemetry, withRootSpanAsync } from './telemetry';
import { openGameStore, type SqliteGameStore } from './store/sqlite';
import { gateTestHooks, type TestHooks } from './test-hooks';
import { CreateRateLimiter, FailedCodeLimiter } from './ws-gateway/limits';
import { WsGateway, type Connection, type GatewayHandlers } from './ws-gateway';
import { handleAction } from './action-handler';
import { handleControl } from './control';
import { AbandonmentJob, LifecycleService } from './lifecycle';
import { countReconnect, handleHello, handleResync, isReconnect, normalizeRoomCode, seatDisconnected, type HelloDeps } from './hello';
import { AbsenceService } from './absence';
import { broadcastRoom, handleLobby } from './lobby';
import { createHttpHandler, type HealthSource } from './http';
import { ReportedFault } from './game-room';
import { CATALOGUE, registerGauge, serverMetrics, zeroCounters } from './metrics';
import { startRuntimeMetrics } from './runtime-metrics';
import { RoomManager, type RecoveryResult } from './room-manager';
import { ShutdownCoordinator, flushTelemetry, forceFlushWithin } from './shutdown';
import { ClientTelemetry } from './client-telemetry';
import { logEvent, reportFault } from './log-events';
import { Presence } from './presence';

/** A failing gauge logs telemetry.gauge_failed at most once per this interval (it is counted every time). */
export const GAUGE_WARN_INTERVAL_MS = 60_000;

export interface ServerOptions {
  /** 0 = ephemeral. */
  port: number;
  dbPath: string | ':memory:';
  config?: DeepPartial<ServerConfig>;
  clock?: Clock & Scheduler;
  /** faults, secrets and testHooks are honoured only when NODE_ENV==='test' or HEXLANDS_TEST_HOOKS=1. */
  faults?: FaultPoints;
  secrets?: SecretRegistry;
  testHooks?: TestHooks;
  /** Directory of the built web bundle; overrides HEXLANDS_STATIC_DIR. null or unset = no static files (D12). */
  staticDir?: string | null;
  /** Overrides HEXLANDS_TELEMETRY. */
  telemetry?: TelemetryMode;
  allowedOrigins?: readonly string[];
  buildVersion?: string;
  /** Test-only, honoured like faults: receives every JSON log line in place of stdout (all telemetry modes). */
  logLine?: (line: string) => void;
}

export interface RunningServer {
  readonly port: number;
  /** TH10. Populated in 'memory' mode; empty otherwise. */
  readonly telemetry: {
    metrics(): MetricSnapshot;
    spans(): readonly ReadableSpan[];
    logs(): readonly ReadableLogRecord[];
  };
  /** Deterministic abandonment-job tick. */
  runAbandonmentJob(): void;
  /** The same path as SIGTERM. */
  drain(): Promise<void>;
  close(): Promise<void>;
  /**
   * Test-hook accessor (design §3.12, D2): the {seq, stateHash} of the game behind roomCode, from its live GameRoom or
   * else the store head; it never loads or resumes a game. null for an unknown, purged or not-yet-started room. Like
   * every test hook it sits behind the D1 gate (NODE_ENV=test or HEXLANDS_TEST_HOOKS=1) and always returns null
   * outside it.
   */
  stateHash(roomCode: string): { readonly seq: number; readonly stateHash: string } | null;
}

/** Everything a server component needs, resolved once by startServer. */
export interface ServerContext {
  readonly config: ServerConfig;
  readonly settings: ProcessSettings;
  readonly clock: Clock & Scheduler;
  readonly faults: FaultPoints;
  readonly secrets: SecretRegistry;
  readonly testHooks: TestHooks;
  readonly telemetry: Telemetry;
  readonly dbPath: string;
  readonly store: SqliteGameStore;
  readonly allowedOrigins: readonly string[];
  readonly buildVersion: string;
  /** Real path of the web bundle directory, or null when no static files are served. */
  readonly staticDir: string | null;
  /**
   * Registers a stop for drain step 3 (design §5.8): it runs once, after the server starts draining and before any
   * snapshot. Components that own timers (the AbandonmentJob, absence timers) clear them here.
   */
  readonly onDrainStop: (stop: () => void) => void;
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const env = process.env;
  const settings = loadProcessSettings(env, opts.telemetry);
  const config = loadServerConfig(env, opts.config);
  if (typeof opts.dbPath !== 'string' || opts.dbPath === '') throw new TypeError('startServer: dbPath must be a non-empty string');
  const buildVersion = opts.buildVersion ?? 'dev';
  const logLine = settings.testHooksEnabled ? opts.logLine : undefined;
  const clock = opts.clock ?? new SystemClock();
  const gaugeWarnedAt = new Map<string, number>();
  const telemetry: Telemetry = createTelemetry({
    mode: settings.telemetry,
    environment: settings.environment,
    serviceVersion: buildVersion,
    ...(logLine ? { writeLine: logLine } : {}),
    // A failed log write (stdout or OTLP) never reaches the caller; it is counted here (D25).
    onWriteError: () => serverMetrics(telemetry).errors.add(1, { component: 'telemetry' }),
    // A gauge callback that throws (e.g. the store) skips that collection: counted, and one WARN per gauge per minute.
    onGaugeError: (name) => {
      serverMetrics(telemetry).errors.add(1, { component: 'telemetry' });
      const now = clock.now();
      if (now - (gaugeWarnedAt.get(name) ?? -Infinity) < GAUGE_WARN_INTERVAL_MS) return;
      gaugeWarnedAt.set(name, now);
      logEvent(telemetry, 'telemetry.gauge_failed', { gauge: name });
    },
  });
  const staticDir = await resolveStaticDir(opts.staticDir !== undefined ? opts.staticDir : settings.staticDir);
  const hooks = gateTestHooks(settings.testHooksEnabled, opts);
  if (hooks.ignored) logEvent(telemetry, 'server.test_hooks_ignored', {});
  let store: SqliteGameStore;
  try {
    store = openGameStore(opts.dbPath);
  } catch (err) {
    await telemetry.shutdown();
    throw err;
  }

  const drainStops: (() => void)[] = [];
  const ctx: ServerContext = {
    config,
    settings,
    clock,
    faults: hooks.faults,
    secrets: hooks.secrets,
    testHooks: hooks.testHooks,
    telemetry,
    dbPath: opts.dbPath,
    store,
    allowedOrigins: opts.allowedOrigins ?? [],
    buildVersion,
    staticDir,
    onDrainStop: (stop) => void drainStops.push(stop),
  };
  await checkBundle(ctx);
  // D13/Q9: without rooms.createPassphrase anyone who finds the host can create rooms; in prod that is logged at
  // every start so an open host is always a visible decision.
  if (settings.environment === 'prod' && config.rooms.createPassphrase === null) logEvent(telemetry, 'server.create_passphrase_unset', {});

  const startedAt = ctx.clock.now();
  let draining = false;
  const rooms: RoomManager = new RoomManager(ctx, () => gateway);
  // Restart recovery (design §5.9), before the server listens.
  let previousShutdown: 'clean' | 'unclean';
  let recovery: RecoveryResult;
  try {
    // One root server.boot span (design §9.3) over the marker check and recovery; counts only, no game ids.
    [previousShutdown, recovery] = await withRootSpanAsync(telemetry.tracer, 'server.boot', SpanKind.INTERNAL, {}, async (span) => {
      const shutdown = store.takeShutdownMarker() === null ? 'unclean' : 'clean';
      span.setAttribute('catan.boot.previous_shutdown', shutdown);
      // Every counter series starts at 0 and is exported once before the boot events (server.starts,
      // lost_on_restart) and before the listener opens, so increase() over the restart sees those events and the
      // reconnect burst that follows.
      zeroCounters(telemetry);
      await forceFlushWithin(telemetry);
      serverMetrics(telemetry).serverStarts.add(1, { shutdown });
      const recovered = rooms.recover(startedAt);
      span.setAttributes({ 'catan.boot.games_restored': recovered.restored, 'catan.boot.lost_on_restart': recovered.lost });
      return [shutdown, recovered] as const;
    });
  } catch (err) {
    store.close();
    await flushTelemetry(telemetry);
    throw err;
  }
  registerGauge(
    telemetry,
    CATALOGUE.games,
    // Nothing to observe once the drain has closed the store.
    () => (store.isOpen ? Object.entries(rooms.countByState()).map(([state, value]) => ({ value, attributes: { state } })) : []),
  );
  const lifecycle = new LifecycleService({ ctx, rooms, gateway: () => gateway });
  const job = new AbandonmentJob({ ctx, rooms, gateway: () => gateway }, lifecycle);
  let lifecycleStopped = false;
  /** Stops the AbandonmentJob and flushes active play, once: drain step 3 or a plain close. */
  const stopLifecycle = (): void => {
    if (lifecycleStopped) return;
    lifecycleStopped = true;
    job.stop();
    try {
      lifecycle.flushAllPlay();
    } catch {
      serverMetrics(ctx.telemetry).errors.add(1, { component: 'job' });
    }
  };
  ctx.onDrainStop(stopLifecycle);
  const health: HealthSource = {
    draining: () => draining,
    playersConnected: () => gateway.seatedCount,
    lastPersistOkAt: () => rooms.lastPersistOkAt,
    abandonmentJobLastSuccessAt: () => job.lastSuccessAt,
  };
  const limits = {
    failedCodes: new FailedCodeLimiter(ctx.clock, config.rooms.failedCodeAttemptsPerIpPerMin),
    creates: new CreateRateLimiter(ctx.clock, config.rooms.createsPerIpPerHour, 3_600_000),
  };
  const http = createServer(createHttpHandler(ctx, rooms, health, startedAt, limits));
  const presence = new Presence(ctx, () => gateway);
  const clientTelemetry = new ClientTelemetry(telemetry, ctx.clock);
  const absence: AbsenceService = new AbsenceService({ ctx, rooms, gateway: () => gateway, broadcastRoom: (id) => broadcastRoom(handlerDeps, id) });
  const handlerDeps: HelloDeps = { ctx, rooms, gateway: () => gateway, lifecycle, presence, seatDrops: new Map(), absence };
  const gateway: WsGateway = new WsGateway(ctx, roomHandlers(handlerDeps, clientTelemetry), limits.failedCodes);
  // Absence timers stop at drain step 3; every commit and every restored room re-evaluates them (design §5.10).
  ctx.onDrainStop(() => absence.stop());
  /** Drain step 3 outside a drain (close(), a failed listen): every registered stop, a throwing one counted as a job error. */
  const runDrainStops = (): void => {
    for (const stop of drainStops) {
      try {
        stop();
      } catch {
        serverMetrics(ctx.telemetry).errors.add(1, { component: 'job' });
      }
    }
  };
  rooms.onCommitted = (gameId) => absence.committed(gameId);
  for (const room of rooms.loadedRooms()) absence.committed(room.gameId);
  http.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => gateway.handleUpgrade(req, socket, head));
  registerGauge(telemetry, CATALOGUE.wsConnections, () => [{ value: gateway.size }]);
  registerGauge(telemetry, CATALOGUE.playersConnected, () => [{ value: gateway.seatedCount }]);
  const stopRuntimeMetrics = startRuntimeMetrics(telemetry, ctx.clock, opts.dbPath);

  try {
    await listen(http, opts.port);
  } catch (err) {
    runDrainStops();
    stopRuntimeMetrics();
    store.close();
    await flushTelemetry(telemetry);
    throw err;
  }
  const port = (http.address() as AddressInfo).port;
  job.start();
  presence.start();

  logEvent(telemetry, 'server.started', {
    games_restored: recovery.restored,
    lost_on_restart: recovery.lost,
    previous_shutdown: previousShutdown,
  });

  const closeHttp = async (): Promise<void> => {
    stopRuntimeMetrics();
    presence.stop();
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  };
  const shutdown = new ShutdownCoordinator({
    ctx,
    rooms,
    gateway,
    drainStops,
    setDraining: () => {
      draining = true;
    },
    closeHttp,
  });
  // Whichever of drain() and close() comes first decides how the server stops; the other returns the same promise.
  let closing: Promise<void> | null = null;
  const drain = (): Promise<void> => (closing ??= shutdown.drain());
  // close() without a drain writes no snapshots and no shutdown marker, so the next start reads as unclean. It runs the
  // drain's step-3 stops first, so no timer (the AbandonmentJob's, the absence timers re-armed by the socket drops
  // below) outlives the store.
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      runDrainStops();
      await gateway.close();
      await closeHttp();
      store.close();
      await flushTelemetry(telemetry);
    })());

  return {
    port,
    telemetry: {
      metrics: () => telemetry.metrics(),
      spans: () => telemetry.spans(),
      logs: () => telemetry.logs(),
    },
    runAbandonmentJob: () => job.run(),
    drain,
    close,
    stateHash: (roomCode) => (ctx.settings.testHooksEnabled ? headOf(ctx, rooms, roomCode) : null),
  };
}

/**
 * {seq, stateHash} of the game behind roomCode: from its live GameRoom, else from the store's head (the last event's
 * hash_after, or the latest snapshot's hash when no event follows it). Never loads a GameRoom.
 */
function headOf(ctx: ServerContext, rooms: RoomManager, roomCode: string): { seq: number; stateHash: string } | null {
  const meta = ctx.store.findByRoomCode(normalizeRoomCode(roomCode));
  if (!meta) return null;
  const live = rooms.loaded(meta.id);
  if (live) return live.head();
  const game = ctx.store.loadGame(meta.id);
  const last = game?.events.at(-1);
  if (last) return { seq: last.seq, stateHash: last.hashAfter };
  return game?.snapshot ? { seq: game.snapshot.seq, stateHash: game.snapshot.stateHash } : null;
}

/**
 * Gateway handlers backed by the RoomManager: hello and reconnects (S-4, S-6), the action commit path (S-3), lobby ops
 * (L-2), resync (S-6), and the `resume` control plus seated-socket presence for the lifecycle (S-8). While the server
 * drains, action, lobby and control get error/server_draining (design §5.8). relinkSeat and skipAbsent are controls too;
 * presence also feeds the AbsenceService (waitingOn, skippable, turn timer).
 */
function roomHandlers(deps: HelloDeps, clientTelemetry: ClientTelemetry): GatewayHandlers {
  const m = serverMetrics(deps.ctx.telemetry);
  /** The highest seq each socket has acked in its current game; only a first ack of a seq is a delivery. */
  const acked = new WeakMap<Connection, { readonly gameId: string; readonly seq: number }>();
  return {
    hello: (conn, msg) => handleHello(deps, conn, msg),
    action: (conn, msg) => handleAction(deps, conn, msg),
    lobby: (conn, msg) => handleLobby(deps, conn, msg),
    control: (conn, msg) => handleControl(deps, conn, msg),
    resync: (conn) => handleResync(deps, conn),
    ack(conn, seq) {
      const b = conn.binding;
      if (b === null) return;
      const mark = acked.get(conn);
      if (mark !== undefined && mark.gameId === b.gameId && seq <= mark.seq) return;
      acked.set(conn, { gameId: b.gameId, seq });
      deps.rooms.loaded(b.gameId)?.acked(seq);
    },
    telemetry: (conn, msg) => clientTelemetry.ingest(conn, msg),
    telemetryDropped: () => clientTelemetry.dropped(),
    // A seated socket left: counters (T-2), player.disconnected (S-5), all_disconnected_since (S-8), then
    // waitingOn/skippable (§5.10).
    disconnected(conn, info) {
      deps.presence?.disconnected(conn, info);
      seatDisconnected(deps, info);
      if (info.binding !== null && info.binding.seat !== null) {
        deps.lifecycle.presenceChanged(info.binding.gameId);
        deps.absence?.seatLeft(info.binding.gameId, info.binding.seat);
      }
    },
    // A throw that escaped a handler: catan.errors{component=ws} and an action.error line with the game's head; a
    // ReportedFault was already reported. A failed reconnect hello also counts as reconnects{outcome=failed_error}.
    handlerError(err, kind, conn, msg) {
      if (msg.t === 'hello' && isReconnect(msg)) countReconnect(deps.ctx, 'failed_error');
      if (err instanceof ReportedFault) return;
      const gameId = conn.binding?.gameId;
      const head = gameId !== undefined ? deps.rooms.loaded(gameId)?.head() : undefined;
      reportFault(deps.ctx.telemetry, {
        component: 'ws',
        kind,
        error: err instanceof Error ? err.name : 'unknown',
        game_id: gameId,
        seq: head?.seq,
        state_hash: head?.stateHash,
      });
    },
    outcome(_conn, kind, o) {
      // Successful hellos are not actions; failed ones count (design §9.4).
      if (kind === 'hello' && o.result === 'ok') return;
      m.actions.add(1, { result: o.result });
      // Every non-ok outcome, error class included (design §9.2, V32).
      if (o.result !== 'ok') m.actionsRejected.add(1, { reason_code: o.reasonCode ?? 'other' });
    },
  };
}

/** Resolves the bundle directory to its real path; a missing or unreadable directory fails startup (D12). */
async function resolveStaticDir(dir: string | null): Promise<string | null> {
  if (dir === null) return null;
  try {
    const real = await realpath(path.resolve(dir));
    if (!(await stat(real)).isDirectory()) throw new Error('not a directory');
    await access(real, fsConstants.R_OK);
    return real;
  } catch {
    throw new ConfigError(['staticDir']);
  }
}

/**
 * D12/D15 startup checks. Without a bundle: WARN server.static_dir_unset in prod. With one: a missing version.txt is
 * WARN server.bundle_version_missing and a different version is ERROR server.bundle_version_mismatch; both checks are
 * skipped when either side is 'dev'.
 */
async function checkBundle(ctx: ServerContext): Promise<void> {
  if (ctx.staticDir === null) {
    if (ctx.settings.environment === 'prod') logEvent(ctx.telemetry, 'server.static_dir_unset', {});
    return;
  }
  if (ctx.buildVersion === 'dev') return;
  const bundled = await readFile(path.join(ctx.staticDir, 'version.txt'), 'utf8').catch(() => null);
  if (bundled === null) return logEvent(ctx.telemetry, 'server.bundle_version_missing', {});
  const version = bundled.trim();
  if (version !== 'dev' && version !== ctx.buildVersion) logEvent(ctx.telemetry, 'server.bundle_version_mismatch', {});
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once('error', onError);
    server.listen(port, () => {
      server.off('error', onError);
      resolve();
    });
  });
}
