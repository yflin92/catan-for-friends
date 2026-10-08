// Reducer, game-creation and replay result types (design §3.4). The functions themselves land with the reducer
// (W1-E4) and board generation (E-a).
import type { GameRules } from './config';
import type { GameEvent } from './events';
import type { EngineReasonCode } from './reasons';
import type { RngStream } from './rng';
import type { GameState } from './state';

export type ReduceResult =
  | { readonly ok: true; readonly state: GameState; readonly events: readonly GameEvent[] }
  | { readonly ok: false; readonly reason: EngineReasonCode };

export interface GameInit {
  readonly config: GameRules;
  readonly playerCount: 3 | 4;
  /** ≥ 128-bit CSPRNG hex seed, minted by the server. */
  readonly seed: string;
  /** Per-stream seed overrides (TH2). */
  readonly streamSeeds?: Partial<Record<RngStream, string>>;
}

export interface ReplayResult {
  readonly state: GameState;
  readonly results: readonly ReduceResult[];
  /** hashes[i] is stateHash after commands[i]. */
  readonly hashes: readonly string[];
}

/** Semver of the rules and serialization; bumped on any rules or serialization change. */
export const ENGINE_VERSION: string = '0.1.0';
