// The live smoke's settings (apps/web/e2e/live.ts) and what the Playwright config makes of them: the game-night window
// guard, the base URL, traces, screenshots, video and the failure page snapshot off for live runs (the first three on
// with HEXLANDS_E2E_LIVE_ARTIFACTS=on), the HTML reporter refused, and the wrapper that keeps secrets and the matcher's
// page snapshot out of a failure.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { activeGameNightWindow, guardGameNightWindow, guardLiveReporters, liveArtifactsOn, liveBaseURL, withoutSecrets } from '../apps/web/e2e/live';

const WINDOWS = JSON.stringify([
  { start: '2026-10-24T18:00:00Z', end: '2026-10-24T23:00:00Z' },
  { start: '2026-10-31T18:00:00Z', end: '2026-10-31T23:00:00Z' },
]);
const at = (iso: string) => new Date(iso);

describe('activeGameNightWindow', () => {
  it('finds the window `now` is in; start inclusive, end exclusive', () => {
    expect(activeGameNightWindow(WINDOWS, at('2026-10-31T18:00:00Z'))).toEqual({ start: '2026-10-31T18:00:00Z', end: '2026-10-31T23:00:00Z' });
    expect(activeGameNightWindow(WINDOWS, at('2026-10-24T22:59:59Z'))?.start).toBe('2026-10-24T18:00:00Z');
    expect(activeGameNightWindow(WINDOWS, at('2026-10-24T23:00:00Z'))).toBeNull();
    expect(activeGameNightWindow(WINDOWS, at('2026-10-24T17:59:59Z'))).toBeNull();
    expect(activeGameNightWindow('[]', at('2026-10-24T20:00:00Z'))).toBeNull();
  });

  it('throws on a malformed setting rather than treating it as no windows', () => {
    expect(() => activeGameNightWindow('{"start":"2026-10-24T18:00:00Z"}', at('2026-10-24T20:00:00Z'))).toThrow(/JSON array/);
    expect(() => activeGameNightWindow('[{"start":"tonight","end":"2026-10-24T23:00:00Z"}]', at('2026-10-24T20:00:00Z'))).toThrow(/\[0\] is not a valid range/);
    expect(() => activeGameNightWindow('[{"start":"2026-10-24T23:00:00Z","end":"2026-10-24T18:00:00Z"}]', at('2026-10-24T20:00:00Z'))).toThrow(/not a valid range/);
    expect(() => activeGameNightWindow('not json', at('2026-10-24T20:00:00Z'))).toThrow();
  });
});

describe('guardGameNightWindow', () => {
  const inside = at('2026-10-24T20:00:00Z');

  it('inside a window: fails fast, naming the window', () => {
    expect(() => guardGameNightWindow({ HEXLANDS_OPS_GAME_NIGHT_WINDOWS: WINDOWS }, inside)).toThrow(
      'refusing the live smoke inside the game-night window 2026-10-24T18:00:00Z – 2026-10-24T23:00:00Z',
    );
  });

  it('inside a window with HEXLANDS_E2E_LIVE_OVERRIDE_WINDOW=yes: runs, returning the window', () => {
    expect(guardGameNightWindow({ HEXLANDS_OPS_GAME_NIGHT_WINDOWS: WINDOWS, HEXLANDS_E2E_LIVE_OVERRIDE_WINDOW: 'yes' }, inside)).toEqual({
      start: '2026-10-24T18:00:00Z',
      end: '2026-10-24T23:00:00Z',
    });
  });

  it('only the exact override value counts', () => {
    for (const value of ['true', '1', 'YES', '']) {
      expect(() => guardGameNightWindow({ HEXLANDS_OPS_GAME_NIGHT_WINDOWS: WINDOWS, HEXLANDS_E2E_LIVE_OVERRIDE_WINDOW: value }, inside)).toThrow(/refusing/);
    }
  });

  it('outside every window, or with none: runs', () => {
    expect(guardGameNightWindow({ HEXLANDS_OPS_GAME_NIGHT_WINDOWS: WINDOWS }, at('2026-10-25T12:00:00Z'))).toBeNull();
    expect(guardGameNightWindow({ HEXLANDS_OPS_GAME_NIGHT_WINDOWS: '[]' }, inside)).toBeNull();
  });

  it('an unset or empty setting fails: it must be given, as "[]" when there are no windows', () => {
    expect(() => guardGameNightWindow({}, inside)).toThrow(/set HEXLANDS_OPS_GAME_NIGHT_WINDOWS/);
    expect(() => guardGameNightWindow({ HEXLANDS_OPS_GAME_NIGHT_WINDOWS: ' ' }, inside)).toThrow(/set HEXLANDS_OPS_GAME_NIGHT_WINDOWS/);
  });
});

describe('liveBaseURL and liveArtifactsOn', () => {
  it('reads the base URL, trimmed and without a trailing slash; unset or blank is no live run', () => {
    expect(liveBaseURL({ HEXLANDS_E2E_BASE_URL: ' https://hexlands.example.org/ ' })).toBe('https://hexlands.example.org');
    expect(liveBaseURL({})).toBeNull();
    expect(liveBaseURL({ HEXLANDS_E2E_BASE_URL: '  ' })).toBeNull();
  });

  it('keeps artifacts only for HEXLANDS_E2E_LIVE_ARTIFACTS=on', () => {
    expect(liveArtifactsOn({})).toBe(false);
    expect(liveArtifactsOn({ HEXLANDS_E2E_LIVE_ARTIFACTS: 'yes' })).toBe(false);
    expect(liveArtifactsOn({ HEXLANDS_E2E_LIVE_ARTIFACTS: 'on' })).toBe(true);
  });
});

describe('guardLiveReporters', () => {
  it('refuses the HTML reporter, from the config or the command line, unless HEXLANDS_E2E_LIVE_ARTIFACTS=on', () => {
    expect(() => guardLiveReporters([['list'], ['html']], {})).toThrow(/HTML reporter keeps raw failure values/);
    expect(() => guardLiveReporters([['html', { open: 'never' }]], {})).toThrow(/HTML reporter/);
    expect(() => guardLiveReporters([['list'], ['html']], { HEXLANDS_E2E_LIVE_ARTIFACTS: 'on' })).not.toThrow();
  });

  it('allows the other reporters', () => {
    expect(() => guardLiveReporters([['list', null], ['json'], ['line'], ['github']], {})).not.toThrow();
  });
});

describe('withoutSecrets', () => {
  const LINK = 'https://hexlands.example.org/#seat=ABCDEF.tok3n-v4lue';
  const secrets = new Set([LINK, 'ABCDEF', 'tok3n-v4lue', 'the passphrase', '']);

  it('a failed locator assertion: thrown again without its page snapshot, every secret redacted', async () => {
    const failure = Object.assign(new Error(`Locator: input[name="rejoin"]\nReceived: ${LINK}; code ABCDEF; the passphrase`), {
      matcherResult: { ariaSnapshot: `- textbox "Your rejoin link": ${LINK}` },
    });
    failure.stack = `${failure.message}\n    at live-smoke.spec.ts:120:5`;
    const thrown = await withoutSecrets(secrets, async () => {
      throw failure;
    }).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBe(failure);
    expect(thrown).not.toHaveProperty('matcherResult');
    const { message, stack } = thrown as Error;
    expect(message).toBe('Locator: input[name="rejoin"]\nReceived: <redacted>; code <redacted>; <redacted>');
    expect(stack).toContain('at live-smoke.spec.ts:120:5');
    for (const secret of [LINK, 'ABCDEF', 'tok3n-v4lue', 'the passphrase']) expect(`${message}${stack}`).not.toContain(secret);
  });

  it('a thrown non-Error becomes an Error, redacted', async () => {
    await expect(withoutSecrets(secrets, () => Promise.reject('refused for ABCDEF'))).rejects.toThrow(/^refused for <redacted>$/);
  });

  it('a passing body passes', async () => {
    await expect(withoutSecrets(secrets, async () => {})).resolves.toBeUndefined();
  });
});

describe('playwright.config for live runs', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  const load = async (env: Record<string, string>) => {
    for (const name of ['HEXLANDS_E2E_BASE_URL', 'HEXLANDS_E2E_LIVE_ARTIFACTS', 'HEXLANDS_E2E_LIVE_INSECURE_TLS', 'PLAYWRIGHT_NO_COPY_PROMPT']) {
      if (env[name] === undefined) vi.stubEnv(name, undefined);
      else vi.stubEnv(name, env[name]);
    }
    vi.resetModules();
    return (await import('../apps/web/playwright.config')).default;
  };

  it('a live run: traces, screenshots, video, the failure page snapshot and git metadata off, certificates checked', async () => {
    const config = await load({ HEXLANDS_E2E_BASE_URL: 'https://hexlands.example.org' });
    expect(config.use).toMatchObject({ trace: 'off', screenshot: 'off', video: 'off', ignoreHTTPSErrors: false });
    expect(process.env['PLAYWRIGHT_NO_COPY_PROMPT']).toBe('1');
    expect(config.captureGitInfo).toEqual({ commit: false, diff: false });
  });

  it('a live run with HEXLANDS_E2E_LIVE_ARTIFACTS=on keeps them, with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = await load({ HEXLANDS_E2E_BASE_URL: 'https://hexlands.example.org', HEXLANDS_E2E_LIVE_ARTIFACTS: 'on' });
    expect(config.use).toMatchObject({ trace: 'on', screenshot: 'on', video: 'on' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('may contain secrets'));
  });

  it('HEXLANDS_E2E_LIVE_INSECURE_TLS=yes accepts an untrusted certificate', async () => {
    const config = await load({ HEXLANDS_E2E_BASE_URL: 'https://localhost:8443', HEXLANDS_E2E_LIVE_INSECURE_TLS: 'yes' });
    expect(config.use).toMatchObject({ ignoreHTTPSErrors: true });
  });

  it('no live run: the suite keeps its own settings', async () => {
    const config = await load({});
    expect(config.use).toEqual({});
    expect(process.env['PLAYWRIGHT_NO_COPY_PROMPT']).toBeUndefined();
    expect(config.captureGitInfo).toBeUndefined();
  });
});
