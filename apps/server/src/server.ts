// startServer: in-process boot of the HTTP + WebSocket listener with injectable clock, store path, telemetry, fault
// points and secret registry (design §3.12; TH7, TH9, TH10, TH12, TH16).
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import type { ServerConfig } from '@hexlands/engine';
import { CloseCode } from '@hexlands/protocol';
import { SystemClock, type Clock, type Scheduler } from './clock';
import { loadProcessSettings, loadServerConfig, type DeepPartial, type ProcessSettings, type TelemetryMode } from './config';
import type { FaultPoints } from './faults';
import type { SecretRegistry } from './secrets';
import { createTelemetry, type MetricSnapshot, type ReadableLogRecord, type ReadableSpan, type Telemetry } from './telemetry';
import { openGameStore, type SqliteGameStore } from './store/sqlite';
import { gateTestHooks, type TestHooks } from './test-hooks';
import { WsGateway, type GatewayHandlers } from './ws-gateway';
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
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const env = process.env;
  const settings = loadProcessSettings(env, opts.telemetry);
  const config = loadServerConfig(env, opts.config);
  if (typeof opts.dbPath !== 'string' || opts.dbPath === '') throw new TypeError('startServer: dbPath must be a non-empty string');
  const buildVersion = opts.buildVersion ?? 'dev';
  const telemetry = createTelemetry({ mode: settings.telemetry, environment: settings.environment, serviceVersion: buildVersion });
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
  };

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
  const http = createServer(createHttpHandler(ctx, rooms, health, startedAt));
  const gateway = new WsGateway(ctx, defaultHandlers());
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
 * Handlers used until rooms exist. No room can be found yet, so every hello is an unknown room (counted against the
 * client's IP) and every other command has no room to act on.
 * TODO(S-4/L-2/S-3): replace with the RoomManager-backed handlers.
 */
function defaultHandlers(): GatewayHandlers {
  return {
    hello(conn) {
      conn.recordFailedRoomCode();
      return { result: 'auth', reasonCode: 'unknown_room', close: CloseCode.AUTH_FAILED };
    },
    action: () => ({ result: 'auth', reasonCode: 'unknown_room' }),
    lobby: () => ({ result: 'auth', reasonCode: 'unknown_room' }),
    control: () => ({ result: 'auth', reasonCode: 'unknown_room' }),
  };
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
