// Public entry point of @hexlands/engine: the pure, deterministic rules engine shared by server and client
// (design §3, ADR-0003). Server and client import only this entry; tests may also import @hexlands/engine/testing.
export type { EdgeId, HexId, Seat, Topology, VertexId } from './ids';
export {
  STANDARD_TOPOLOGY,
  edgeToPixels,
  hexIndex,
  hexToPixel,
  isEdgeId,
  isHexId,
  isVertexId,
  vertexToPixel,
} from './topology';
export type {
  Board,
  DevCardKind,
  GameState,
  HarborKind,
  Phase,
  PhaseName,
  PlayerState,
  Resource,
  ResourceCounts,
  Terrain,
  TradeOffer,
} from './state';
export { RESOURCES, TERRAIN_YIELD } from './state';
export type { Action, ActionGroup, ActionType, Command, GameEvent, LogEntry, SystemAction } from './events';
export { actionGroup } from './events';
export type { GameInit, ReduceResult, ReplayResult } from './api';
export { ENGINE_VERSION } from './api';
export type { RngStream, RngStreamState, Sfc32 } from './rng';
export { RNG_STREAMS } from './rng';
export type { LegalActions } from './legal';
export type { PlayerView, PlayerViewData, PublicProjection } from './view';
export type { EngineReasonCode, OutcomeResult, ResultCategory } from './reasons';
export { ReasonCode, reasonCategory } from './reasons';
export type { AbsencePolicy, GameConfig, GameRules, LifecycleConfig, ServerConfig } from './config';
export { DEFAULT_GAME_CONFIG, DEFAULT_SERVER_CONFIG, validateGameConfig } from './config';
