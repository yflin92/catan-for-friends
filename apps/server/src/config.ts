// Server configuration loading (design §3.9, TH16). The effective ServerConfig is DEFAULT_SERVER_CONFIG, overlaid by
// HEXLANDS_* environment variables, overlaid by startServer({config}). Objects merge deeply; arrays and scalars
// replace. The merged result is validated, and validation errors name the key path or variable, never the value.
import path from 'node:path';
import { DEFAULT_SERVER_CONFIG, LIFECYCLE_BOUNDS, type ServerConfig } from '@hexlands/engine';
import { z } from 'zod';
import { parseCidr } from './ws-gateway/client-ip';

/** Recursive Partial in which arrays are replaced wholesale rather than merged. */
export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { readonly [K in keyof T]?: DeepPartial<T[K]> }
    : T;

/** Raised for any invalid configuration input. The message lists key paths or variable names only. */
export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`invalid server configuration: ${problems.join('; ')}`);
    this.name = 'ConfigError';
  }
}

export type Environment = (typeof ENVIRONMENTS)[number];
export const ENVIRONMENTS = ['prod', 'dev', 'loadtest'] as const;

export type TelemetryMode = (typeof TELEMETRY_MODES)[number];
export const TELEMETRY_MODES = ['otlp', 'memory', 'off'] as const;

type Env = Readonly<Record<string, string | undefined>>;

const posInt = z.number().int().min(1);
const nonNegInt = z.number().int().min(0);
const isoInstant = z.iso.datetime({ offset: true });

/** A lifecycle key: an integer within its LIFECYCLE_BOUNDS (design D4). */
const lifecycleInt = (key: keyof typeof LIFECYCLE_BOUNDS) =>
  z.number().int().min(LIFECYCLE_BOUNDS[key][0]).max(LIFECYCLE_BOUNDS[key][1]);

const serverConfigSchema = z.strictObject({
  lifecycle: z.strictObject({
    inactivityAbandonMin: lifecycleInt('inactivityAbandonMin'),
    allDisconnectedAbandonMin: lifecycleInt('allDisconnectedAbandonMin'),
    resumeWindowDays: lifecycleInt('resumeWindowDays'),
    lobbyExpiryHours: lifecycleInt('lobbyExpiryHours'),
    finishedRetentionDays: lifecycleInt('finishedRetentionDays'),
    checkIntervalSec: lifecycleInt('checkIntervalSec'),
  }),
  rooms: z.strictObject({
    maxActiveGames: posInt,
    // ≥ 6 symbols from the 32-symbol alphabet keeps room codes at ≥ 30 bits (P7, design §4).
    roomCodeLength: z.number().int().min(6).max(16),
    createPassphrase: z.string().min(1).nullable(),
    failedCodeAttemptsPerIpPerMin: posInt,
    createsPerIpPerHour: z.number().int().min(1).max(1000),
  }),
  features: z.strictObject({ chat: z.boolean(), undo: z.boolean(), counterOffers: z.boolean() }),
  ops: z.strictObject({
    drainTimeoutSec: posInt,
    maxMsgsPerSecPerConn: posInt,
    maxMsgBurstPerConn: posInt,
    malformedCloseThreshold: z.strictObject({ count: posInt, windowSec: posInt }),
    healthProbeIntervalSec: posInt,
    healthAlertConsecutiveFailures: posInt,
    gameNightWindows: z.array(
      z
        .strictObject({ start: isoInstant, end: isoInstant })
        .refine((w) => Date.parse(w.start) < Date.parse(w.end), { message: 'start must precede end' }),
    ),
    deployGuardWhileGamesActive: z.boolean(),
    trustedProxies: z.array(z.string().refine((c) => parseCidr(c) !== null, { message: 'invalid CIDR' })),
  }),
  telemetry: z.strictObject({
    backgroundGraceSec: nonNegInt,
    reconnectSloWindowDays: posInt,
    reconnectSloMinSamples: nonNegInt,
  }),
});

/** Builds the effective, validated and frozen ServerConfig. */
export function loadServerConfig(env: Env, override?: DeepPartial<ServerConfig>): ServerConfig {
  const merged = deepMerge(deepMerge(DEFAULT_SERVER_CONFIG, configFromEnv(env)), override ?? {});
  const parsed = serverConfigSchema.safeParse(merged);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) =>
        i.code === 'unrecognized_keys'
          ? i.keys.map((k) => `${formatPath([...i.path, k])} (unknown key)`).join('; ')
          : `${formatPath(i.path)} (${i.code})`,
      ),
    );
  }
  return deepFreeze(parsed.data);
}

/** Environment variable for a config key path, e.g. ['ops', 'maxMsgsPerSecPerConn'] → HEXLANDS_OPS_MAX_MSGS_PER_SEC_PER_CONN. */
export function envVarName(path: readonly string[]): string {
  return `HEXLANDS_${path.map((p) => p.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()).join('_')}`;
}

/**
 * Reads every HEXLANDS_* variable that corresponds to a ServerConfig leaf. The expected type comes from the default:
 * numbers are parsed strictly, booleans accept true/false/1/0, arrays are JSON, and the nullable passphrase treats an
 * empty string as null.
 */
export function configFromEnv(env: Env): DeepPartial<ServerConfig> {
  const problems: string[] = [];
  const read = (defaults: object, path: readonly string[]): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [key, def] of Object.entries(defaults)) {
      const keyPath = [...path, key];
      if (def !== null && typeof def === 'object' && !Array.isArray(def)) {
        const nested = read(def, keyPath);
        if (Object.keys(nested).length > 0) out[key] = nested;
        continue;
      }
      const name = envVarName(keyPath);
      const raw = env[name];
      if (raw === undefined) continue;
      const value = parseEnvValue(def, raw);
      if (value === INVALID) problems.push(name);
      else out[key] = value;
    }
    return out;
  };
  const result = read(DEFAULT_SERVER_CONFIG, []);
  if (problems.length > 0) throw new ConfigError(problems);
  return result as DeepPartial<ServerConfig>;
}

export interface ProcessSettings {
  /** deployment.environment (design §9.1). */
  readonly environment: Environment;
  readonly telemetry: TelemetryMode;
  /** NODE_ENV === 'test' or HEXLANDS_TEST_HOOKS === '1'. */
  readonly testHooksEnabled: boolean;
  /** Absolute directory of the built web bundle (HEXLANDS_STATIC_DIR); null = no static files are served. */
  readonly staticDir: string | null;
}

/**
 * Process-level settings that are not part of ServerConfig:
 * - HEXLANDS_ENV ∈ prod|dev|loadtest (default dev);
 * - HEXLANDS_TELEMETRY ∈ otlp|memory|off (default off under NODE_ENV=test, else otlp), overridden by
 *   startServer({telemetry});
 * - HEXLANDS_STATIC_DIR, the web bundle directory;
 * - the test-hook gate. The OTLP endpoint comes from the standard OTEL_EXPORTER_OTLP_* variables.
 */
export function loadProcessSettings(env: Env, telemetryOverride?: TelemetryMode): ProcessSettings {
  const problems: string[] = [];
  const environment = pick(env, 'HEXLANDS_ENV', ENVIRONMENTS, 'dev', problems);
  const defaultMode: TelemetryMode = env['NODE_ENV'] === 'test' ? 'off' : 'otlp';
  const telemetry = telemetryOverride ?? pick(env, 'HEXLANDS_TELEMETRY', TELEMETRY_MODES, defaultMode, problems);
  if (telemetryOverride !== undefined && !TELEMETRY_MODES.includes(telemetryOverride)) problems.push('telemetry');
  if (problems.length > 0) throw new ConfigError(problems);
  const staticDir = env['HEXLANDS_STATIC_DIR'] ? path.resolve(env['HEXLANDS_STATIC_DIR']) : null;
  return { environment, telemetry, testHooksEnabled: testHooksEnabled(env), staticDir };
}

export function testHooksEnabled(env: Env): boolean {
  return env['NODE_ENV'] === 'test' || env['HEXLANDS_TEST_HOOKS'] === '1';
}

const INVALID = Symbol('invalid');

function parseEnvValue(def: unknown, raw: string): unknown {
  if (typeof def === 'number') return /^-?(0|[1-9]\d*)(\.\d+)?$/.test(raw.trim()) ? Number(raw.trim()) : INVALID;
  if (typeof def === 'boolean') {
    const v = raw.trim().toLowerCase();
    if (v === 'true' || v === '1') return true;
    if (v === 'false' || v === '0') return false;
    return INVALID;
  }
  if (Array.isArray(def)) {
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : INVALID;
    } catch {
      return INVALID;
    }
  }
  if (def === null || typeof def === 'string') return raw === '' ? null : raw;
  return INVALID;
}

function pick<T extends string>(env: Env, name: string, allowed: readonly T[], fallback: T, problems: string[]): T {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  problems.push(name);
  return fallback;
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function deepMerge(base: unknown, over: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(over)) return over === undefined ? base : over;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v !== undefined) out[k] = deepMerge(base[k], v);
  }
  return out;
}

function deepFreeze<T>(x: T): T {
  if (typeof x === 'object' && x !== null && !Object.isFrozen(x)) {
    Object.freeze(x);
    for (const v of Object.values(x)) deepFreeze(v);
  }
  return x;
}

function formatPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return '(root)';
  return path.map((p, i) => (typeof p === 'number' ? `[${p}]` : `${i === 0 ? '' : '.'}${String(p)}`)).join('');
}
