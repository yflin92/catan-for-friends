// Configuration (design §3.9, requirements §13). GameRules is engine-visible and frozen into GameState at start (so it
// is part of stateHash). AbsencePolicy and LifecycleConfig are server-layer settings carried in the per-game GameConfig.
// ServerConfig is server-wide; every P7 limit is read from it so test instances can override it (TH16).

export interface GameRules {
  /** Victory points needed to win; integer 5..20. */
  readonly vpTarget: number;
  /** A hand larger than this discards ⌊n/2⌋ on a 7; integer 3..20. */
  readonly discardLimit: number;
  /** noAdjacentRedNumbers: no edge-adjacent pair among {6, 8}. */
  readonly boardConstraints: { readonly noAdjacentRedNumbers: boolean };
  /** When enabled, the robber may not target a hex touching a seat (other than the mover) with public VP ≤ maxPublicVp,
   *  unless that leaves no legal hex (R9 fallback). maxPublicVp is an integer 0..vpTarget−1. */
  readonly friendlyRobber: { readonly enabled: boolean; readonly maxPublicVp: number };
}

/** Per-game absent-player policy (server layer, ADR-0014). */
export interface AbsencePolicy {
  readonly mode: 'pause' | 'pause_host_skip' | 'turn_timer';
  /** Seconds a waited-on seat must be disconnected before it can be skipped; integer 10..3600. */
  readonly skipAfterSec: number;
  /** Turn timer in seconds, integer 30..3600. Required (non-null) iff mode = 'turn_timer'; for any other mode, null or
   *  a valid value is accepted and ignored. */
  readonly turnTimerSec: number | null;
  readonly skipBy: 'host_or_any_if_host_absent' | 'host_only';
  readonly seatRelinkEnabled: boolean;
}

/** Server-wide lifecycle thresholds, copied into each game row at creation. All are positive integers. Not
 *  host-settable: lobby setConfig accepts only rules and absencePolicy. */
export interface LifecycleConfig {
  readonly inactivityAbandonMin: number;
  readonly allDisconnectedAbandonMin: number;
  readonly resumeWindowDays: number;
  readonly lobbyExpiryHours: number;
  readonly finishedRetentionDays: number;
  readonly checkIntervalSec: number;
}

export interface ServerConfig {
  readonly lifecycle: LifecycleConfig;
  readonly rooms: {
    /** Non-terminal games counted: lobby + active. */
    readonly maxActiveGames: number;
    readonly roomCodeLength: number;
    /** Non-null gates room creation (Q9). */
    readonly createPassphrase: string | null;
    readonly failedCodeAttemptsPerIpPerMin: number;
  };
  readonly features: { readonly chat: boolean; readonly undo: boolean; readonly counterOffers: boolean };
  readonly ops: {
    readonly drainTimeoutSec: number;
    readonly maxMsgsPerSecPerConn: number;
    readonly maxMsgBurstPerConn: number;
    readonly malformedCloseThreshold: { readonly count: number; readonly windowSec: number };
    readonly healthProbeIntervalSec: number;
    readonly healthAlertConsecutiveFailures: number;
    /** ISO-8601 start/end pairs. */
    readonly gameNightWindows: readonly { readonly start: string; readonly end: string }[];
    readonly deployGuardWhileGamesActive: boolean;
    /** CIDRs of reverse proxies whose X-Forwarded-For is trusted for the client IP (D11); [] = never trust it. */
    readonly trustedProxies: readonly string[];
  };
  readonly telemetry: {
    readonly backgroundGraceSec: number;
    readonly reconnectSloWindowDays: number;
    readonly reconnectSloMinSamples: number;
  };
}

/** The per-game configuration persisted with the room. */
export interface GameConfig {
  readonly version: 1;
  readonly playerCount: { readonly min: 3; readonly max: 4 };
  readonly rules: GameRules;
  readonly absencePolicy: AbsencePolicy;
  readonly lifecycle: LifecycleConfig;
}

function deepFreeze<T>(x: T): T {
  if (typeof x === 'object' && x !== null && !Object.isFrozen(x)) {
    Object.freeze(x);
    for (const v of Object.values(x)) deepFreeze(v);
  }
  return x;
}

const DEFAULT_LIFECYCLE: LifecycleConfig = {
  inactivityAbandonMin: 30,
  allDisconnectedAbandonMin: 10,
  resumeWindowDays: 7,
  lobbyExpiryHours: 24,
  finishedRetentionDays: 7,
  checkIntervalSec: 60,
};

export const DEFAULT_GAME_CONFIG: GameConfig = deepFreeze({
  version: 1,
  playerCount: { min: 3, max: 4 },
  rules: {
    vpTarget: 10,
    discardLimit: 7,
    boardConstraints: { noAdjacentRedNumbers: true },
    friendlyRobber: { enabled: false, maxPublicVp: 2 },
  },
  absencePolicy: {
    mode: 'pause_host_skip',
    skipAfterSec: 60,
    turnTimerSec: null,
    skipBy: 'host_or_any_if_host_absent',
    seatRelinkEnabled: true,
  },
  lifecycle: { ...DEFAULT_LIFECYCLE },
});

export const DEFAULT_SERVER_CONFIG: ServerConfig = deepFreeze({
  lifecycle: { ...DEFAULT_LIFECYCLE },
  rooms: { maxActiveGames: 10, roomCodeLength: 6, createPassphrase: null, failedCodeAttemptsPerIpPerMin: 10 },
  features: { chat: false, undo: false, counterOffers: false },
  ops: {
    drainTimeoutSec: 10,
    maxMsgsPerSecPerConn: 20,
    maxMsgBurstPerConn: 40,
    malformedCloseThreshold: { count: 100, windowSec: 60 },
    healthProbeIntervalSec: 120,
    healthAlertConsecutiveFailures: 3,
    gameNightWindows: [],
    deployGuardWhileGamesActive: true,
    trustedProxies: ['127.0.0.0/8', '::1/128', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7'],
  },
  telemetry: { backgroundGraceSec: 60, reconnectSloWindowDays: 14, reconnectSloMinSamples: 100 },
});

// ── validation ───────────────────────────────────────────────────────────────────────────────────────────────────

type Obj = Readonly<Record<string, unknown>>;

class Checker {
  readonly errors: string[] = [];

  object(value: unknown, path: string, keys: readonly string[]): Obj | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      this.errors.push(`${path}: expected an object`);
      return null;
    }
    for (const k of Object.keys(value)) {
      if (!keys.includes(k)) this.errors.push(`${path}.${k}: unknown key`);
    }
    for (const k of keys) {
      if (!(k in value)) this.errors.push(`${path}.${k}: missing`);
    }
    return value as Obj;
  }

  int(o: Obj, key: string, path: string, min: number, max: number): void {
    if (!(key in o)) return;
    const v = o[key];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
      this.errors.push(`${path}.${key}: expected an integer in [${min}, ${max}]`);
    }
  }

  bool(o: Obj, key: string, path: string): void {
    if (key in o && typeof o[key] !== 'boolean') this.errors.push(`${path}.${key}: expected a boolean`);
  }

  oneOf(o: Obj, key: string, path: string, allowed: readonly unknown[]): void {
    if (key in o && !allowed.includes(o[key])) {
      this.errors.push(`${path}.${key}: expected one of ${allowed.map((a) => JSON.stringify(a)).join(', ')}`);
    }
  }
}

const MAX_INT = Number.MAX_SAFE_INTEGER;

function checkRules(c: Checker, value: unknown, path: string): void {
  const r = c.object(value, path, ['vpTarget', 'discardLimit', 'boardConstraints', 'friendlyRobber']);
  if (!r) return;
  c.int(r, 'vpTarget', path, 5, 20);
  c.int(r, 'discardLimit', path, 3, 20);
  if ('boardConstraints' in r) {
    const b = c.object(r['boardConstraints'], `${path}.boardConstraints`, ['noAdjacentRedNumbers']);
    if (b) c.bool(b, 'noAdjacentRedNumbers', `${path}.boardConstraints`);
  }
  if ('friendlyRobber' in r) {
    const f = c.object(r['friendlyRobber'], `${path}.friendlyRobber`, ['enabled', 'maxPublicVp']);
    if (f) {
      c.bool(f, 'enabled', `${path}.friendlyRobber`);
      const vpTarget = r['vpTarget'];
      const maxVp = typeof vpTarget === 'number' && Number.isInteger(vpTarget) ? Math.min(vpTarget - 1, 19) : 19;
      c.int(f, 'maxPublicVp', `${path}.friendlyRobber`, 0, maxVp);
    }
  }
}

function checkAbsencePolicy(c: Checker, value: unknown, path: string): void {
  const a = c.object(value, path, ['mode', 'skipAfterSec', 'turnTimerSec', 'skipBy', 'seatRelinkEnabled']);
  if (!a) return;
  c.oneOf(a, 'mode', path, ['pause', 'pause_host_skip', 'turn_timer']);
  c.int(a, 'skipAfterSec', path, 10, 3600);
  if ('turnTimerSec' in a) {
    if (a['turnTimerSec'] === null) {
      if (a['mode'] === 'turn_timer') c.errors.push(`${path}.turnTimerSec: required when mode is "turn_timer"`);
    } else {
      c.int(a, 'turnTimerSec', path, 30, 3600);
    }
  }
  c.oneOf(a, 'skipBy', path, ['host_or_any_if_host_absent', 'host_only']);
  c.bool(a, 'seatRelinkEnabled', path);
}

function checkLifecycle(c: Checker, value: unknown, path: string): void {
  const keys = [
    'inactivityAbandonMin',
    'allDisconnectedAbandonMin',
    'resumeWindowDays',
    'lobbyExpiryHours',
    'finishedRetentionDays',
    'checkIntervalSec',
  ] as const;
  const l = c.object(value, path, keys);
  if (!l) return;
  for (const k of keys) c.int(l, k, path, 1, MAX_INT);
}

/**
 * Validates a complete GameConfig. Unknown keys, missing keys, non-integers and out-of-range values are all errors, and
 * cross-field rules (maxPublicVp < vpTarget) are checked on the whole object, so a lobby setConfig partial must be
 * deep-merged onto the current config before validation. Error strings name the key path and never echo the value. On
 * success the returned config is a deep-frozen copy of the input.
 */
export function validateGameConfig(
  input: unknown,
): { ok: true; config: GameConfig } | { ok: false; errors: readonly string[] } {
  const c = new Checker();
  const g = c.object(input, 'config', ['version', 'playerCount', 'rules', 'absencePolicy', 'lifecycle']);
  if (g) {
    c.oneOf(g, 'version', 'config', [1]);
    if ('playerCount' in g) {
      const p = c.object(g['playerCount'], 'config.playerCount', ['min', 'max']);
      if (p) {
        c.oneOf(p, 'min', 'config.playerCount', [3]);
        c.oneOf(p, 'max', 'config.playerCount', [4]);
      }
    }
    if ('rules' in g) checkRules(c, g['rules'], 'config.rules');
    if ('absencePolicy' in g) checkAbsencePolicy(c, g['absencePolicy'], 'config.absencePolicy');
    if ('lifecycle' in g) checkLifecycle(c, g['lifecycle'], 'config.lifecycle');
  }
  if (c.errors.length > 0) return { ok: false, errors: c.errors };
  return { ok: true, config: deepFreeze(structuredCloneJson(input) as GameConfig) };
}

function structuredCloneJson(x: unknown): unknown {
  return JSON.parse(JSON.stringify(x)) as unknown;
}
