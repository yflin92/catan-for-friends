// Test-only server hooks and their gate (design §3.12 with diffs D1/D2; TH9, TH12). faults, secrets and testHooks
// from ServerOptions are honoured only when NODE_ENV==='test' or HEXLANDS_TEST_HOOKS=1, as read inside startServer.
// Otherwise they are replaced by inert defaults and one WARN `server.test_hooks_ignored` is logged.
import type { GameInit, GameState } from '@hexlands/engine';
import { NoFaults, type FaultPoints } from './faults';
import { NoSecrets, type SecretRegistry } from './secrets';

/** In-process hooks for seeded or pre-built games (design ruling G-A). There is no HTTP or WS route to them. */
export interface TestHooks {
  /** At `start`: replaces the server-drawn CSPRNG seed (and optionally per-stream seeds) for this room. undefined → normal draw. */
  seedFor?(roomCode: string): { readonly seed: string; readonly streamSeeds?: GameInit['streamSeeds'] } | undefined;
  /** At `start`, after createGame: replaces the seq-0 state for this room. undefined → keep the created state. */
  initialState?(roomCode: string, created: GameState): GameState | undefined;
}

export interface GatedHooks {
  readonly faults: FaultPoints;
  readonly secrets: SecretRegistry;
  readonly testHooks: TestHooks;
  /** True when at least one supplied hook was dropped because the gate is closed. */
  readonly ignored: boolean;
}

const NO_TEST_HOOKS: TestHooks = Object.freeze({});

export function gateTestHooks(
  enabled: boolean,
  supplied: { readonly faults?: FaultPoints; readonly secrets?: SecretRegistry; readonly testHooks?: TestHooks },
): GatedHooks {
  if (enabled) {
    return {
      faults: supplied.faults ?? NoFaults,
      secrets: supplied.secrets ?? NoSecrets,
      testHooks: supplied.testHooks ?? NO_TEST_HOOKS,
      ignored: false,
    };
  }
  const ignored = supplied.faults !== undefined || supplied.secrets !== undefined || supplied.testHooks !== undefined;
  return { faults: NoFaults, secrets: NoSecrets, testHooks: NO_TEST_HOOKS, ignored };
}
