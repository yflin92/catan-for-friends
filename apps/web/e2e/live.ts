// Settings for e2e runs against a deployed server (live-smoke.spec.ts). Everything comes from the environment:
//   HEXLANDS_E2E_BASE_URL                 the deployed origin, e.g. https://catan.example.org; unset = no live run
//   HEXLANDS_ROOMS_CREATE_PASSPHRASE      the room-creation passphrase (Q9), when the server requires one
//   HEXLANDS_OPS_GAME_NIGHT_WINDOWS       the game-night windows, as in deploy/.env (a JSON array of {start, end});
//                                         required for a live run, '[]' when there are none
//   HEXLANDS_E2E_LIVE_OVERRIDE_WINDOW=yes run even inside a game-night window
//   HEXLANDS_E2E_LIVE_ARTIFACTS=on        keep traces, screenshots and video (off by default; they can hold secrets)
//   HEXLANDS_E2E_LIVE_INSECURE_TLS=yes    accept an untrusted certificate (a local Caddy CA only, never a real host)
//   HEXLANDS_E2E_LIVE_FAIL_IN_LOBBY=yes   fail on purpose in the lobby, once the codes and tokens exist
//                                         (live-smoke-checks.spec.ts only)

export interface LiveEnv {
  readonly [name: string]: string | undefined;
}

/** The deployed origin to test, or null when no live run is configured. */
export function liveBaseURL(env: LiveEnv = process.env): string | null {
  const raw = env['HEXLANDS_E2E_BASE_URL']?.trim();
  return raw ? raw.replace(/\/+$/, '') : null;
}

/** The game-night window `now` falls in ({start, end} as configured), or null. Throws on a malformed setting. */
export function activeGameNightWindow(raw: string | undefined, now: Date): { start: string; end: string } | null {
  if (raw === undefined || raw.trim() === '') return null;
  const windows: unknown = JSON.parse(raw);
  if (!Array.isArray(windows)) throw new Error('HEXLANDS_OPS_GAME_NIGHT_WINDOWS must be a JSON array of {start, end}');
  for (const [i, w] of windows.entries()) {
    const { start, end } = (w ?? {}) as { start?: unknown; end?: unknown };
    const s = typeof start === 'string' ? Date.parse(start) : NaN;
    const e = typeof end === 'string' ? Date.parse(end) : NaN;
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) throw new Error(`HEXLANDS_OPS_GAME_NIGHT_WINDOWS[${i}] is not a valid range`);
    if (now.getTime() >= s && now.getTime() < e) return { start: start as string, end: end as string };
  }
  return null;
}

/**
 * Refuses a live run inside a game-night window: throws, naming the window, unless
 * HEXLANDS_E2E_LIVE_OVERRIDE_WINDOW=yes. Also throws when HEXLANDS_OPS_GAME_NIGHT_WINDOWS is unset, so a forgotten
 * setting cannot pass for "no windows" ('[]' says that). Returns the window when it was overridden, else null.
 */
export function guardGameNightWindow(env: LiveEnv, now: Date): { start: string; end: string } | null {
  const raw = env['HEXLANDS_OPS_GAME_NIGHT_WINDOWS'];
  if (raw === undefined || raw.trim() === '') {
    throw new Error("set HEXLANDS_OPS_GAME_NIGHT_WINDOWS to the deployment's value in deploy/.env ('[]' when it has none)");
  }
  const window = activeGameNightWindow(raw, now);
  if (window === null) return null;
  if (env['HEXLANDS_E2E_LIVE_OVERRIDE_WINDOW'] !== 'yes') {
    throw new Error(
      `refusing the live smoke inside the game-night window ${window.start} – ${window.end}; ` +
        'run it outside the window, or set HEXLANDS_E2E_LIVE_OVERRIDE_WINDOW=yes deliberately',
    );
  }
  return window;
}

/**
 * Refuses the HTML reporter for a live run unless HEXLANDS_E2E_LIVE_ARTIFACTS=on: it keeps every failed step's own
 * error, received values included, which a test-level redaction cannot reach. `reporters` is the run's resolved
 * config.reporter, command-line choices included.
 */
export function guardLiveReporters(reporters: readonly (readonly [string, unknown?])[], env: LiveEnv): void {
  if (liveArtifactsOn(env)) return;
  if (reporters.some(([name]) => name === 'html')) {
    throw new Error('the HTML reporter keeps raw failure values; use list, line or json for a live run (or HEXLANDS_E2E_LIVE_ARTIFACTS=on)');
  }
}

/** Whether a live run keeps traces, screenshots and video (opt-in only). */
export function liveArtifactsOn(env: LiveEnv = process.env): boolean {
  return env['HEXLANDS_E2E_LIVE_ARTIFACTS'] === 'on';
}

/**
 * Runs the test body so that a failure leaves no secret behind. Playwright attaches a page snapshot to a failed
 * locator assertion (error-context.md, the HTML report), and in the lobby that shows the invite and rejoin links; the
 * error is thrown again without it, with every secret value seen so far redacted from its message and stack.
 */
export async function withoutSecrets(secrets: ReadonlySet<string>, body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (e) {
    const values = [...secrets].filter((v) => v !== '').sort((a, b) => b.length - a.length);
    const redact = (text: string) => values.reduce((t, v) => t.split(v).join('<redacted>'), text);
    const error = new Error(redact(e instanceof Error ? e.message : String(e)));
    error.stack = redact((e instanceof Error ? e.stack : undefined) ?? error.message);
    throw error;
  }
}
