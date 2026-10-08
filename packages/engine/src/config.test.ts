import { describe, expect, it } from 'vitest';
import { DEFAULT_GAME_CONFIG, DEFAULT_SERVER_CONFIG, validateGameConfig, type GameConfig } from './config';

type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };
const clone = (): Mutable<GameConfig> => JSON.parse(JSON.stringify(DEFAULT_GAME_CONFIG)) as Mutable<GameConfig>;

function errorsFor(mutate: (c: Mutable<GameConfig>) => void): readonly string[] {
  const c = clone();
  mutate(c);
  const r = validateGameConfig(c);
  return r.ok ? [] : r.errors;
}

describe('DEFAULT_GAME_CONFIG (requirements §13)', () => {
  it('matches the documented defaults', () => {
    expect(DEFAULT_GAME_CONFIG).toEqual({
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
      lifecycle: {
        inactivityAbandonMin: 30,
        allDisconnectedAbandonMin: 10,
        resumeWindowDays: 7,
        lobbyExpiryHours: 24,
        finishedRetentionDays: 7,
        checkIntervalSec: 60,
      },
    });
  });

  it('is deeply frozen', () => {
    expect(Object.isFrozen(DEFAULT_GAME_CONFIG)).toBe(true);
    expect(Object.isFrozen(DEFAULT_GAME_CONFIG.rules.friendlyRobber)).toBe(true);
    expect(Object.isFrozen(DEFAULT_GAME_CONFIG.lifecycle)).toBe(true);
  });

  it('is accepted by validateGameConfig', () => {
    const r = validateGameConfig(DEFAULT_GAME_CONFIG);
    expect(r).toEqual({ ok: true, config: DEFAULT_GAME_CONFIG });
  });
});

describe('DEFAULT_SERVER_CONFIG (design §3.9)', () => {
  it('matches the documented defaults', () => {
    expect(DEFAULT_SERVER_CONFIG).toEqual({
      lifecycle: DEFAULT_GAME_CONFIG.lifecycle,
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
      },
      telemetry: { backgroundGraceSec: 60, reconnectSloWindowDays: 14, reconnectSloMinSamples: 100 },
    });
    expect(Object.isFrozen(DEFAULT_SERVER_CONFIG.ops.malformedCloseThreshold)).toBe(true);
  });
});

describe('validateGameConfig', () => {
  it('returns a frozen copy, not the input', () => {
    const input = clone();
    const r = validateGameConfig(input);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config).not.toBe(input);
      expect(Object.isFrozen(r.config.rules)).toBe(true);
    }
  });

  it.each([
    ['vpTarget below 5', (c: Mutable<GameConfig>) => { c.rules.vpTarget = 4; }, 'config.rules.vpTarget'],
    ['vpTarget above 20', (c: Mutable<GameConfig>) => { c.rules.vpTarget = 21; }, 'config.rules.vpTarget'],
    ['non-integer vpTarget', (c: Mutable<GameConfig>) => { c.rules.vpTarget = 10.5; }, 'config.rules.vpTarget'],
    ['discardLimit below 3', (c: Mutable<GameConfig>) => { c.rules.discardLimit = 2; }, 'config.rules.discardLimit'],
    ['discardLimit above 20', (c: Mutable<GameConfig>) => { c.rules.discardLimit = 21; }, 'config.rules.discardLimit'],
    ['non-boolean noAdjacentRedNumbers', (c: Mutable<GameConfig>) => {
      (c.rules.boardConstraints as Record<string, unknown>)['noAdjacentRedNumbers'] = 'yes';
    }, 'config.rules.boardConstraints.noAdjacentRedNumbers'],
    ['maxPublicVp ≥ vpTarget', (c: Mutable<GameConfig>) => { c.rules.vpTarget = 6; c.rules.friendlyRobber.maxPublicVp = 6; },
      'config.rules.friendlyRobber.maxPublicVp'],
    ['negative maxPublicVp', (c: Mutable<GameConfig>) => { c.rules.friendlyRobber.maxPublicVp = -1; },
      'config.rules.friendlyRobber.maxPublicVp'],
    ['unknown mode', (c: Mutable<GameConfig>) => {
      (c.absencePolicy as Record<string, unknown>)['mode'] = 'kick';
    }, 'config.absencePolicy.mode'],
    ['skipAfterSec below 10', (c: Mutable<GameConfig>) => { c.absencePolicy.skipAfterSec = 5; }, 'config.absencePolicy.skipAfterSec'],
    ['turn_timer without turnTimerSec', (c: Mutable<GameConfig>) => { c.absencePolicy.mode = 'turn_timer'; },
      'config.absencePolicy.turnTimerSec'],
    ['turnTimerSec below 30', (c: Mutable<GameConfig>) => { c.absencePolicy.mode = 'turn_timer'; c.absencePolicy.turnTimerSec = 10; },
      'config.absencePolicy.turnTimerSec'],
    ['unknown skipBy', (c: Mutable<GameConfig>) => {
      (c.absencePolicy as Record<string, unknown>)['skipBy'] = 'anyone';
    }, 'config.absencePolicy.skipBy'],
    ['zero inactivityAbandonMin', (c: Mutable<GameConfig>) => { c.lifecycle.inactivityAbandonMin = 0; },
      'config.lifecycle.inactivityAbandonMin'],
    ['wrong version', (c: Mutable<GameConfig>) => { (c as Record<string, unknown>)['version'] = 2; }, 'config.version'],
    ['playerCount other than 3..4', (c: Mutable<GameConfig>) => {
      (c.playerCount as Record<string, unknown>)['max'] = 6;
    }, 'config.playerCount.max'],
    ['unknown top-level key', (c: Mutable<GameConfig>) => { (c as Record<string, unknown>)['seed'] = 'abc'; }, 'config.seed'],
    ['unknown nested key', (c: Mutable<GameConfig>) => { (c.rules as Record<string, unknown>)['robberOff'] = true; },
      'config.rules.robberOff'],
    ['missing key', (c: Mutable<GameConfig>) => { delete (c.rules as Partial<typeof c.rules>).discardLimit; },
      'config.rules.discardLimit'],
  ])('rejects %s', (_name, mutate, path) => {
    const errors = errorsFor(mutate);
    expect(errors.some((e) => e.startsWith(`${path}:`))).toBe(true);
  });

  it('accepts a valid turn_timer config and the friendly robber at its maximum', () => {
    expect(errorsFor((c) => { c.absencePolicy.mode = 'turn_timer'; c.absencePolicy.turnTimerSec = 90; })).toEqual([]);
    expect(errorsFor((c) => { c.rules.friendlyRobber = { enabled: true, maxPublicVp: 9 }; })).toEqual([]);
  });

  it.each([null, undefined, 42, 'config', []])('rejects non-object input %j', (input) => {
    const r = validateGameConfig(input);
    expect(r.ok).toBe(false);
  });
});
