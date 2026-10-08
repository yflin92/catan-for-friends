// Production entry point of @hexlands/server. Test-only helpers live in @hexlands/server/testing.
export { startServer } from './server';
export { HEARTBEAT_INTERVAL_MS, HEARTBEAT_TIMEOUT_MS, MAX_BUFFERED_BYTES, WS_PATH, WsGateway, originAllowed } from './ws-gateway';
export type { Binding, CommandResult, Connection, DisconnectInfo, GatewayHandlers } from './ws-gateway';
export { classifyDisconnect } from './ws-gateway/disconnect';
export type { DisconnectClass, DisconnectFacts, ServerCloseCause } from './ws-gateway/disconnect';
export type { RunningServer, ServerContext, ServerOptions } from './server';
export { FakeClock, SystemClock } from './clock';
export type { Clock, Scheduler, TimerHandle } from './clock';
export { ConfigError, configFromEnv, envVarName, loadProcessSettings, loadServerConfig } from './config';
export type { DeepPartial, Environment, ProcessSettings, TelemetryMode } from './config';
export { FAULT_POINTS, InjectedFault, NoFaults } from './faults';
export type { FaultAction, FaultContext, FaultPoint, FaultPoints } from './faults';
export { NoSecrets } from './secrets';
export type { SecretKind, SecretRegistry } from './secrets';
export type { TestHooks } from './test-hooks';
export type { MetricSnapshot, ReadableLogRecord, ReadableSpan } from './telemetry';
export { SCHEMA_VERSION, SeqGapError, SqliteGameStore, openGameStore } from './store/sqlite';
export type {
  GameMetaRow,
  GameStore,
  Lifecycle,
  LoadedGame,
  NewEvent,
  NewRoomRow,
  SeatRow,
  SnapshotRow,
  StoredEvent,
} from './store/game-store';
