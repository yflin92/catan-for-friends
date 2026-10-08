import { DEFAULT_SERVER_CONFIG } from '@hexlands/engine';
import { describe, expect, it } from 'vitest';
import { ConfigError, envVarName, loadProcessSettings, loadServerConfig } from './config';

function configError(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ConfigError) return err;
    throw err;
  }
  throw new Error('expected a ConfigError');
}

describe('loadServerConfig (design §3.9, TH16)', () => {
  it('returns the defaults when nothing is overridden', () => {
    expect(loadServerConfig({})).toEqual(DEFAULT_SERVER_CONFIG);
  });

  it('derives env names from key paths', () => {
    expect(envVarName(['ops', 'maxMsgsPerSecPerConn'])).toBe('HEXLANDS_OPS_MAX_MSGS_PER_SEC_PER_CONN');
    expect(envVarName(['ops', 'malformedCloseThreshold', 'count'])).toBe('HEXLANDS_OPS_MALFORMED_CLOSE_THRESHOLD_COUNT');
    expect(envVarName(['lifecycle', 'inactivityAbandonMin'])).toBe('HEXLANDS_LIFECYCLE_INACTIVITY_ABANDON_MIN');
  });

  it('applies env over defaults and opts.config over env, merging objects deeply', () => {
    const cfg = loadServerConfig(
      {
        HEXLANDS_OPS_MAX_MSGS_PER_SEC_PER_CONN: '5',
        HEXLANDS_OPS_MAX_MSG_BURST_PER_CONN: '7',
        HEXLANDS_ROOMS_FAILED_CODE_ATTEMPTS_PER_IP_PER_MIN: '3',
        HEXLANDS_FEATURES_CHAT: 'true',
      },
      { ops: { maxMsgsPerSecPerConn: 2, malformedCloseThreshold: { count: 4 } } },
    );
    expect(cfg.ops.maxMsgsPerSecPerConn).toBe(2);
    expect(cfg.ops.maxMsgBurstPerConn).toBe(7);
    expect(cfg.ops.malformedCloseThreshold).toEqual({ count: 4, windowSec: 60 });
    expect(cfg.rooms.failedCodeAttemptsPerIpPerMin).toBe(3);
    expect(cfg.features.chat).toBe(true);
    expect(cfg.lifecycle).toEqual(DEFAULT_SERVER_CONFIG.lifecycle);
  });

  it('replaces arrays rather than merging them', () => {
    const w1 = { start: '2026-10-09T18:00:00Z', end: '2026-10-09T23:00:00Z' };
    const w2 = { start: '2026-10-10T18:00:00Z', end: '2026-10-10T23:00:00Z' };
    const cfg = loadServerConfig({ HEXLANDS_OPS_GAME_NIGHT_WINDOWS: JSON.stringify([w1, w2]) }, { ops: { gameNightWindows: [w2] } });
    expect(cfg.ops.gameNightWindows).toEqual([w2]);
  });

  it('treats an empty passphrase variable as null and any other value as the passphrase', () => {
    expect(loadServerConfig({ HEXLANDS_ROOMS_CREATE_PASSPHRASE: '' }).rooms.createPassphrase).toBeNull();
    expect(loadServerConfig({ HEXLANDS_ROOMS_CREATE_PASSPHRASE: 'open sesame' }).rooms.createPassphrase).toBe('open sesame');
  });

  it.each([
    ['checkIntervalSec', 1, 3600],
    ['inactivityAbandonMin', 1, 1440],
    ['allDisconnectedAbandonMin', 1, 1440],
    ['lobbyExpiryHours', 1, 720],
    ['resumeWindowDays', 1, 365],
    ['finishedRetentionDays', 1, 365],
    ['tombstoneDays', 1, 365],
  ] as const)('lifecycle.%s accepts %i..%i; just outside is an error naming the key path, never the value (D4)', (key, min, max) => {
    for (const ok of [min, max]) expect(loadServerConfig({}, { lifecycle: { [key]: ok } }).lifecycle[key]).toBe(ok);
    const below = configError(() => loadServerConfig({}, { lifecycle: { [key]: min - 1 } }));
    expect(below.problems).toEqual([`lifecycle.${key} (too_small)`]);
    const above = configError(() => loadServerConfig({}, { lifecycle: { [key]: max + 1 } }));
    expect(above.problems).toEqual([`lifecycle.${key} (too_big)`]);
    expect(above.message).not.toContain(String(max + 1));
  });

  it('applies the lifecycle bounds to env values too', () => {
    const err = configError(() => loadServerConfig({ HEXLANDS_LIFECYCLE_CHECK_INTERVAL_SEC: '3601' }));
    expect(err.problems).toEqual(['lifecycle.checkIntervalSec (too_big)']);
  });

  it('returns a frozen config', () => {
    const cfg = loadServerConfig({}, { ops: { drainTimeoutSec: 3 } });
    expect(Object.isFrozen(cfg)).toBe(true);
    expect(Object.isFrozen(cfg.ops.malformedCloseThreshold)).toBe(true);
  });

  it('rejects unparseable env values, naming the variable but never the value', () => {
    const err = configError(() =>
      loadServerConfig({ HEXLANDS_OPS_DRAIN_TIMEOUT_SEC: 'ten-secret', HEXLANDS_FEATURES_UNDO: 'maybe-secret' }),
    );
    expect(err.problems).toEqual(['HEXLANDS_FEATURES_UNDO', 'HEXLANDS_OPS_DRAIN_TIMEOUT_SEC']);
    expect(err.message).not.toContain('secret');
  });

  it('rejects out-of-range merged values by key path without echoing them', () => {
    const err = configError(() =>
      loadServerConfig({ HEXLANDS_ROOMS_MAX_ACTIVE_GAMES: '0' }, { ops: { malformedCloseThreshold: { windowSec: 1.5 } } }),
    );
    expect(err.problems).toEqual(['rooms.maxActiveGames (too_small)', 'ops.malformedCloseThreshold.windowSec (invalid_type)']);
  });

  it('rejects a room code shorter than 6 symbols (P7 ≥ 30 bits)', () => {
    expect(configError(() => loadServerConfig({}, { rooms: { roomCodeLength: 5 } })).problems).toEqual([
      'rooms.roomCodeLength (too_small)',
    ]);
  });

  it('rejects malformed or inverted game-night windows', () => {
    const err = configError(() =>
      loadServerConfig({}, { ops: { gameNightWindows: [{ start: 'tonight', end: '2026-10-09T23:00:00Z' }] } }),
    );
    expect(err.problems).toContain('ops.gameNightWindows[0].start (invalid_format)');
    const inverted = { start: '2026-10-09T23:00:00Z', end: '2026-10-09T18:00:00Z' };
    expect(configError(() => loadServerConfig({}, { ops: { gameNightWindows: [inverted] } })).problems).toEqual([
      'ops.gameNightWindows[0] (custom)',
    ]);
  });

  it('reads ops.trustedProxies from env JSON and rejects an invalid CIDR by key path only (D11)', () => {
    expect(loadServerConfig({ HEXLANDS_OPS_TRUSTED_PROXIES: '["10.1.0.0/16"]' }).ops.trustedProxies).toEqual(['10.1.0.0/16']);
    expect(loadServerConfig({}, { ops: { trustedProxies: [] } }).ops.trustedProxies).toEqual([]);
    const err = configError(() => loadServerConfig({}, { ops: { trustedProxies: ['10.0.0.0/8', 'secret-host/99'] } }));
    expect(err.problems).toEqual(['ops.trustedProxies[1] (custom)']);
    expect(err.message).not.toContain('secret');
    expect(configError(() => loadServerConfig({ HEXLANDS_OPS_TRUSTED_PROXIES: 'nope' })).problems).toEqual([
      'HEXLANDS_OPS_TRUSTED_PROXIES',
    ]);
  });

  it('rejects unknown keys in the override', () => {
    const override = { ops: { maxMsgsPerSec: 3 } } as unknown as Parameters<typeof loadServerConfig>[1];
    expect(configError(() => loadServerConfig({}, override)).problems).toEqual(['ops.maxMsgsPerSec (unknown key)']);
  });

  it('never echoes a rejected passphrase', () => {
    const err = configError(() => loadServerConfig({}, { rooms: { createPassphrase: '', maxActiveGames: -1 } }));
    expect(err.problems).toEqual(['rooms.maxActiveGames (too_small)', 'rooms.createPassphrase (too_small)']);
  });
});

describe('loadProcessSettings', () => {
  it('defaults to dev, telemetry off under NODE_ENV=test and otlp otherwise', () => {
    expect(loadProcessSettings({ NODE_ENV: 'test' })).toEqual({
      environment: 'dev',
      telemetry: 'off',
      testHooksEnabled: true,
      staticDir: null,
    });
    expect(loadProcessSettings({ NODE_ENV: 'production' })).toEqual({
      environment: 'dev',
      telemetry: 'otlp',
      testHooksEnabled: false,
      staticDir: null,
    });
  });

  it('reads HEXLANDS_ENV and HEXLANDS_TELEMETRY, with the option overriding the variable', () => {
    expect(loadProcessSettings({ HEXLANDS_ENV: 'prod', HEXLANDS_TELEMETRY: 'off' })).toMatchObject({
      environment: 'prod',
      telemetry: 'off',
    });
    expect(loadProcessSettings({ HEXLANDS_TELEMETRY: 'off' }, 'memory').telemetry).toBe('memory');
  });

  it('enables test hooks with NODE_ENV=test or HEXLANDS_TEST_HOOKS=1 only', () => {
    expect(loadProcessSettings({ HEXLANDS_TEST_HOOKS: '1' }).testHooksEnabled).toBe(true);
    expect(loadProcessSettings({ HEXLANDS_TEST_HOOKS: 'true' }).testHooksEnabled).toBe(false);
    expect(loadProcessSettings({}).testHooksEnabled).toBe(false);
  });

  it('rejects an unknown environment or telemetry mode by variable name', () => {
    expect(configError(() => loadProcessSettings({ HEXLANDS_ENV: 'staging', HEXLANDS_TELEMETRY: 'x' })).problems).toEqual([
      'HEXLANDS_ENV',
      'HEXLANDS_TELEMETRY',
    ]);
  });
});
