// Checks on the live smoke (live-smoke.spec.ts) itself, each running it in a child Playwright (Chromium) against a local
// harness whose server requires a random sentinel passphrase and records every room code and seat token it issues;
// the live settings are at their defaults unless a test says otherwise, with no game-night windows ('[]').
// - No secret leaks. Every run's stdout, stderr, JSON report and test-results directory (and the HTML report, where
//   one is allowed, its embedded zip unpacked) are scanned for the passphrase, every issued room code and seat token,
//   invite or rejoin fragments with a value, and a page snapshot. The runs: a passing one; one failing on the home page
//   (a wrong passphrase); and one failing on purpose in the lobby (HEXLANDS_E2E_LIVE_FAIL_IN_LOBBY=yes, a locator
//   assertion once the invite and rejoin links are on screen). Traces, screenshots, video and the failure page
//   snapshot are off by default for live runs, and the HTML reporter, which keeps raw failure values, is refused.
//   A control run with HEXLANDS_E2E_LIVE_ARTIFACTS=on shows the scan finds the passphrase where it is present: in the
//   trace.
// - The game-night window guard: inside a configured window the run fails before any page opens and the server sees
//   no game; with HEXLANDS_E2E_LIVE_OVERRIDE_WINDOW=yes it runs, with a warning.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { test as base } from '@playwright/test';
import { RecordingSecrets } from '@hexlands/server/testing';
import { expect, startHarness, type Harness } from './harness';

const WEB_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SENTINEL = `sentinel-${randomUUID()}`;
/** Every room code and seat token the harness server issues (its secrets registry is a test hook). */
const issued = new RecordingSecrets();

const test = base.extend<object, { sentinelHarness: Harness }>({
  sentinelHarness: [
    // eslint-disable-next-line no-empty-pattern -- Playwright fixtures require an object pattern
    async ({}, use) => {
      const saved = process.env['HEXLANDS_TEST_HOOKS'];
      process.env['HEXLANDS_TEST_HOOKS'] = '1';
      const h = await startHarness({ config: { rooms: { createPassphrase: SENTINEL, createsPerIpPerHour: 1000 } }, secrets: issued });
      if (saved === undefined) delete process.env['HEXLANDS_TEST_HOOKS'];
      else process.env['HEXLANDS_TEST_HOOKS'] = saved;
      await use(h);
      await h.close();
    },
    { scope: 'worker' },
  ],
});

interface ChildRun {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly dir: string;
}

/**
 * Runs live-smoke.spec.ts on Chromium against `baseURL` with `passphrase` (and `extraEnv`) in the environment and the
 * given reporters, the live settings otherwise at their defaults, every output under a temp dir.
 */
function runLiveSmoke(baseURL: string, passphrase: string, extraEnv: NodeJS.ProcessEnv = {}, reporters = 'list,json'): Promise<ChildRun> {
  const dir = mkdtempSync(join(tmpdir(), 'hexlands-live-sentinel-'));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HEXLANDS_E2E_BASE_URL: baseURL,
    HEXLANDS_ROOMS_CREATE_PASSPHRASE: passphrase,
    PLAYWRIGHT_JSON_OUTPUT_FILE: join(dir, 'report.json'),
    PLAYWRIGHT_HTML_OUTPUT_DIR: join(dir, 'html'),
    PLAYWRIGHT_HTML_OPEN: 'never',
  };
  for (const name of [
    'HEXLANDS_E2E_LIVE_ARTIFACTS',
    'HEXLANDS_E2E_LIVE_INSECURE_TLS',
    'HEXLANDS_E2E_LIVE_OVERRIDE_WINDOW',
    'HEXLANDS_E2E_LIVE_FAIL_IN_LOBBY',
    'HEXLANDS_TEST_HOOKS',
    'PLAYWRIGHT_NO_COPY_PROMPT',
  ]) {
    delete env[name];
  }
  env['HEXLANDS_OPS_GAME_NIGHT_WINDOWS'] = '[]';
  Object.assign(env, extraEnv);
  const args = ['test', 'e2e/live-smoke.spec.ts', '--project=chromium', `--reporter=${reporters}`, `--output=${join(dir, 'test-results')}`];
  return new Promise((resolve, reject) => {
    const child = spawn(join(WEB_ROOT, 'node_modules/.bin/playwright'), args, { cwd: WEB_ROOT, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.once('error', reject);
    child.once('close', (exitCode) => resolve({ exitCode, stdout, stderr, dir }));
  });
}

/** Every file under `dir`, relative to it. */
function filesUnder(dir: string, prefix = ''): string[] {
  return readdirSync(join(dir, prefix)).flatMap((name) => {
    const rel = join(prefix, name);
    return statSync(join(dir, rel)).isDirectory() ? filesUnder(dir, rel) : [rel];
  });
}

/** The entries of a zip archive, decompressed (stored and deflate entries, as Playwright writes them). */
function unzip(zip: Buffer): { name: string; data: Buffer }[] {
  let eocd = zip.length - 22;
  while (eocd >= 0 && zip.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip archive');
  const entries: { name: string; data: Buffer }[] = [];
  let at = zip.readUInt32LE(eocd + 16);
  for (let i = 0; i < zip.readUInt16LE(eocd + 10); i++) {
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(start, start + size);
    entries.push({ name, data: method === 8 ? inflateRawSync(raw) : raw });
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return entries;
}

/** Where `needle` appears in a run's output: 'stdout', 'stderr', or a file path (with '!entry' inside a zip). */
function findSecret(run: ChildRun, needle: string | RegExp): string[] {
  const has = (text: string) => (typeof needle === 'string' ? text.includes(needle) : needle.test(text));
  const hits: string[] = [];
  if (has(run.stdout)) hits.push('stdout');
  if (has(run.stderr)) hits.push('stderr');
  for (const rel of filesUnder(run.dir)) {
    const text = readFileSync(join(run.dir, rel), 'latin1');
    if (has(text)) hits.push(rel);
    const bytes = Buffer.from(text, 'latin1');
    if (rel.endsWith('.zip')) for (const e of unzip(bytes)) if (has(e.data.toString('latin1'))) hits.push(`${rel}!${e.name}`);
    const embedded = /data:application\/zip;base64,([A-Za-z0-9+/=]+)/.exec(text);
    if (embedded) for (const e of unzip(Buffer.from(embedded[1]!, 'base64'))) if (has(e.data.toString('latin1'))) hits.push(`${rel}!${e.name}`);
  }
  return hits;
}

/** An invite or rejoin fragment with its value (source text such as `split('#join=')` does not match). */
const FRAGMENT = /#(?:join|seat)=[A-Za-z0-9]/;

/**
 * Every leak in a run, named without the value: the passphrase, each issued room code and seat token, a link fragment,
 * a page snapshot.
 */
function leaks(run: ChildRun, passphrase: string): string[] {
  const needles: [string, string | RegExp][] = [
    ['passphrase', passphrase],
    ...issued.all().map(({ kind, value }, i): [string, string] => [`${kind} #${i}`, value]),
    ['link fragment', FRAGMENT],
    ['page snapshot', PAGE_SNAPSHOT],
  ];
  return needles.flatMap(([name, needle]) => findSecret(run, needle).map((where) => `${name} in ${where}`));
}

/** How many room codes and seat tokens the harness has issued so far. */
const issuedCount = () => ({ roomCodes: issued.valuesOf('roomCode').length, seatTokens: issued.valuesOf('seatToken').length });

/** The HTML report's embedded data, unpacked: the entry names, for checking the scan saw inside it. */
function htmlReportEntries(run: ChildRun): string[] {
  const html = readFileSync(join(run.dir, 'html', 'index.html'), 'latin1');
  const embedded = /data:application\/zip;base64,([A-Za-z0-9+/=]+)/.exec(html);
  return embedded ? unzip(Buffer.from(embedded[1]!, 'base64')).map((e) => e.name) : [];
}

// The child run is Chromium whatever the project, so the checks run once, in the chromium project.
test.skip(({ browserName }) => browserName !== 'chromium', 'the live-smoke checks run once, in the chromium project');

/** Text in every aria page snapshot of the app, as a failed test's error context would hold it. */
const PAGE_SNAPSHOT = 'heading "Hexlands"';

const ARTIFACT = /(\.zip|\.png|\.jpe?g|\.webm)$/;

interface Report {
  readonly stats: Record<string, number>;
}
const readReport = (run: ChildRun): Report => JSON.parse(readFileSync(join(run.dir, 'report.json'), 'utf8')) as Report;

/** Games the harness server holds, in any lifecycle state. */
async function gameCount(h: Harness): Promise<number> {
  const health = (await (await fetch(`http://127.0.0.1:${h.server.port}/healthz`)).json()) as { games: Record<string, number> };
  return Object.values(health.games).reduce((a, b) => a + b, 0);
}

test.describe('the live smoke leaks no secret', () => {
  test.describe.configure({ timeout: 180_000 });

  test('a passing run: no secret in any output, report or result file, and no trace, screenshot or video', async ({ sentinelHarness }) => {
    const before = issuedCount();
    const run = await runLiveSmoke(sentinelHarness.baseURL, SENTINEL);
    try {
      expect(run.exitCode, 'the live smoke passes against the harness').toBe(0);
      expect(readReport(run).stats).toMatchObject({ expected: 1, unexpected: 0, skipped: 0 });
      expect(issuedCount().roomCodes - before.roomCodes, 'a room was created').toBe(1);
      expect(issuedCount().seatTokens - before.seatTokens, 'three seats were issued').toBe(3);
      expect(filesUnder(run.dir).filter((f) => ARTIFACT.test(f))).toEqual([]);
      expect(leaks(run, SENTINEL)).toEqual([]);
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  test('a run failing on the home page (wrong passphrase): no secret anywhere, the refusal reported', async ({ sentinelHarness }) => {
    const wrong = `wrong-${SENTINEL}`;
    const run = await runLiveSmoke(sentinelHarness.baseURL, wrong);
    try {
      expect(run.exitCode, 'the live smoke fails: the server rejects the passphrase').not.toBe(0);
      expect(run.stdout).toContain('the server refused to create the room: That passphrase isn’t right.');
      expect(readReport(run).stats).toMatchObject({ expected: 0, unexpected: 1 });
      expect(filesUnder(run.dir).some((f) => f.endsWith('error-context.md')), 'the failure wrote its error context').toBe(true);
      expect(filesUnder(run.dir).filter((f) => ARTIFACT.test(f))).toEqual([]);
      expect(leaks(run, wrong)).toEqual([]);
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  test('a run failing in the lobby, with the room code and seat tokens on screen: no secret and no page snapshot anywhere', async ({ sentinelHarness }) => {
    const before = issuedCount();
    const run = await runLiveSmoke(sentinelHarness.baseURL, SENTINEL, { HEXLANDS_E2E_LIVE_FAIL_IN_LOBBY: 'yes' });
    try {
      expect(run.exitCode).not.toBe(0);
      expect(run.stdout).toContain('the deliberate lobby failure');
      expect(readReport(run).stats).toMatchObject({ expected: 0, unexpected: 1 });
      expect(issuedCount().roomCodes - before.roomCodes, 'the room existed').toBe(1);
      expect(issuedCount().seatTokens - before.seatTokens, 'the seats existed').toBe(3);
      expect(filesUnder(run.dir).some((f) => f.endsWith('error-context.md')), 'the failure wrote its error context').toBe(true);
      expect(filesUnder(run.dir).filter((f) => ARTIFACT.test(f))).toEqual([]);
      expect(leaks(run, SENTINEL)).toEqual([]);
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  test('the HTML reporter is refused before any page opens, and the server sees no game', async ({ sentinelHarness }) => {
    const before = await gameCount(sentinelHarness);
    const run = await runLiveSmoke(sentinelHarness.baseURL, SENTINEL, {}, 'list,json,html');
    try {
      expect(run.exitCode).not.toBe(0);
      expect(run.stdout).toContain('the HTML reporter keeps raw failure values');
      expect(await gameCount(sentinelHarness)).toBe(before);
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  test('control: with HEXLANDS_E2E_LIVE_ARTIFACTS=on the trace holds the passphrase, and the scan finds it there', async ({ sentinelHarness }) => {
    const run = await runLiveSmoke(sentinelHarness.baseURL, SENTINEL, { HEXLANDS_E2E_LIVE_ARTIFACTS: 'on' }, 'list,json,html');
    try {
      expect(run.exitCode).toBe(0);
      expect(run.stderr + run.stdout).toContain('HEXLANDS_E2E_LIVE_ARTIFACTS=on');
      expect(htmlReportEntries(run).length, 'the HTML report data was unpacked').toBeGreaterThan(0);
      expect(filesUnder(run.dir).filter((f) => f.endsWith('trace.zip')).length).toBeGreaterThan(0);
      expect(findSecret(run, SENTINEL).some((hit) => /trace\.zip!/.test(hit)), 'the scan sees inside the trace').toBe(true);
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });
});

test.describe('the live smoke refuses a game-night window', () => {
  test.describe.configure({ timeout: 120_000 });
  const window = () => {
    const now = Date.now();
    return JSON.stringify([{ start: new Date(now - 3_600_000).toISOString(), end: new Date(now + 3_600_000).toISOString() }]);
  };

  test('inside a window it fails before opening a page, and the server sees no game', async ({ sentinelHarness }) => {
    const before = await gameCount(sentinelHarness);
    const run = await runLiveSmoke(sentinelHarness.baseURL, SENTINEL, { HEXLANDS_OPS_GAME_NIGHT_WINDOWS: window() });
    try {
      expect(run.exitCode).not.toBe(0);
      expect(run.stdout).toContain('refusing the live smoke inside the game-night window');
      expect(readReport(run).stats).toMatchObject({ expected: 0, unexpected: 1 });
      expect(await gameCount(sentinelHarness)).toBe(before);
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  test('inside a window with HEXLANDS_E2E_LIVE_OVERRIDE_WINDOW=yes it runs, with a warning', async ({ sentinelHarness }) => {
    const run = await runLiveSmoke(sentinelHarness.baseURL, SENTINEL, { HEXLANDS_OPS_GAME_NIGHT_WINDOWS: window(), HEXLANDS_E2E_LIVE_OVERRIDE_WINDOW: 'yes' });
    try {
      expect(run.exitCode).toBe(0);
      expect(run.stdout + run.stderr).toContain('live smoke running inside the game-night window');
      expect(readReport(run).stats).toMatchObject({ expected: 1, unexpected: 0, skipped: 0 });
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });
});
