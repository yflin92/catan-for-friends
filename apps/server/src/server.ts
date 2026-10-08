// startServer: in-process boot of the HTTP + WebSocket listener with injectable clock, store path, telemetry, fault
// points and secret registry (design §3.12; TH7, TH9, TH10, TH12, TH16).
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import type { ServerConfig } from '@hexlands/engine';
import { SystemClock, type Clock, type Scheduler } from './clock';
import { constants as fsConstants } from 'node:fs';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { ConfigError, loadProcessSettings, loadServerConfig, type DeepPartial, type ProcessSettings, type TelemetryMode } from './config';
import type { FaultPoints } from './faults';
import type { SecretRegistry } from './secrets';
import { createTelemetry, type MetricSnapshot, type ReadableLogRecord, type ReadableSpan, type Telemetry } from './telemetry';
import { openGameStore, type SqliteGameStore } from './store/sqlite';
import { gateTestHooks, type TestHooks } from './test-hooks';
import { CreateRateLimiter, FailedCodeLimiter } from './ws-gateway/limits';
import { WsGateway, type CommandResult, type GatewayHandlers } from './ws-gateway';
import { handleHello, type HelloDeps } from './hello';
import { createHttpHandler, type HealthSource } from './http';
import { RoomManager } from './room-manager';

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
  /** Current {seq, stateHash} of the game behind roomCode; null when unknown, purged, or test hooks are disabled. */
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
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const env = process.env;
  const settings = loadProcessSettings(env, opts.telemetry);
  const config = loadServerConfig(env, opts.config);
  if (typeof opts.dbPath !== 'string' || opts.dbPath === '') throw new TypeError('startServer: dbPath must be a non-empty string');
  const buildVersion = opts.buildVersion ?? 'dev';
  const telemetry = createTelemetry({ mode: settings.telemetry, environment: settings.environment, serviceVersion: buildVersion });
  const staticDir = await resolveStaticDir(opts.staticDir !== undefined ? opts.staticDir : settings.staticDir);
  const hooks = gateTestHooks(settings.testHooksEnabled, opts);
  if (hooks.ignored) telemetry.log('WARN', 'server.test_hooks_ignored');
  let store: SqliteGameStore;
  try {
    store = openGameStore(opts.dbPath);
  } catch (err) {
    await telemetry.shutdown();
    throw err;
  }

  const ctx: ServerContext = {
    config,
    settings,
    clock: opts.clock ?? new SystemClock(),
    faults: hooks.faults,
    secrets: hooks.secrets,
    testHooks: hooks.testHooks,
    telemetry,
    dbPath: opts.dbPath,
    store,
    allowedOrigins: opts.allowedOrigins ?? [],
    buildVersion,
    staticDir,
  };
  await checkBundle(ctx);

  const startedAt = ctx.clock.now();
  let draining = false;
  const rooms = new RoomManager(ctx);
  telemetry.observableGauge(
    'catan.games',
    { description: 'games by lifecycle state', labels: { state: ['lobby', 'active', 'abandoned'] } },
    () => Object.entries(rooms.countByState()).map(([state, value]) => ({ value, attributes: { state } })),
  );
  // TODO(S-3/S-8): players_connected, last persist and job success come from the rooms and the job.
  const health: HealthSource = {
    draining: () => draining,
    playersConnected: () => 0,
    lastPersistOkAt: () => null,
    abandonmentJobLastSuccessAt: () => null,
  };
  const limits = {
    failedCodes: new FailedCodeLimiter(ctx.clock, config.rooms.failedCodeAttemptsPerIpPerMin),
    creates: new CreateRateLimiter(ctx.clock, config.rooms.createsPerIpPerHour, 3_600_000),
  };
  const http = createServer(createHttpHandler(ctx, rooms, health, startedAt, limits));
  const gateway: WsGateway = new WsGateway(ctx, roomHandlers({ ctx, rooms, gateway: () => gateway }), limits.failedCodes);
  http.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => gateway.handleUpgrade(req, socket, head));

  try {
    await listen(http, opts.port);
  } catch (err) {
    store.close();
    await telemetry.shutdown();
    throw err;
  }
  const port = (http.address() as AddressInfo).port;

  let closing: Promise<void> | null = null;

  const close = (): Promise<void> => {
    closing ??= (async () => {
      await gateway.close();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      store.close();
      await telemetry.shutdown();
    })();
    return closing;
  };

  // Components (rooms, lifecycle, shutdown) are constructed from ctx as their tasks land.
  void ctx;
  return {
    port,
    telemetry: {
      metrics: () => telemetry.metrics(),
      spans: () => telemetry.spans(),
      logs: () => telemetry.logs(),
    },
    // TODO(S-8): run the AbandonmentJob over all non-terminal games.
    runAbandonmentJob: () => undefined,
    // TODO(S-7): drain-and-flush per design §5.8; currently marks the server draining and closes it.
    drain: async () => {
      if (draining) return closing ?? undefined;
      draining = true;
      gateway.setDraining(true);
      await close();
    },
    close,
    // TODO(S-3): read {seq, stateHash} from the loaded GameRoom, else head_seq/hash_after from the store.
    stateHash: () => null,
  };
}

/**
 * Gateway handlers backed by the RoomManager. Hello is complete (S-4).
 * TODO(L-2/S-3/S-6): lobby ops, the action commit path, controls and resync.
 */
function roomHandlers(deps: HelloDeps): GatewayHandlers {
  const actions = deps.ctx.telemetry.counter('catan.actions', {
    description: 'outcomes of action, lobby and control messages, and failed hellos',
    labels: { result: ['ok', 'rule', 'turn', 'auth', 'error'] },
  });
  const notInRoom = (): CommandResult => ({ result: 'auth', reasonCode: 'unknown_room' });
  return {
    hello: (conn, msg) => handleHello(deps, conn, msg),
    action: notInRoom,
    lobby: notInRoom,
    control: notInRoom,
    outcome(_conn, kind, o) {
      // Successful hellos are not actions; failed ones count (design §9.4).
      if (kind === 'hello' && o.result === 'ok') return;
      actions.add(1, { result: o.result });
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

/** D12 startup checks: a production server without a bundle warns; a bundle from another build is an ERROR. */
async function checkBundle(ctx: ServerContext): Promise<void> {
  if (ctx.staticDir === null) {
    if (ctx.settings.environment === 'prod') ctx.telemetry.log('WARN', 'server.static_dir_unset');
    return;
  }
  const bundled = await readFile(path.join(ctx.staticDir, 'version.txt'), 'utf8').catch(() => null);
  if (bundled?.trim() !== ctx.buildVersion) ctx.telemetry.log('ERROR', 'server.bundle_version_mismatch');
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
