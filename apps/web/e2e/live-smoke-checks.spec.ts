// Checks on the live smoke (live-smoke.spec.ts) itself, each running it in a child Playwright (Chromium) against a local
// harness whose server requires a random sentinel passphrase; the live settings are at their defaults unless a test
// says otherwise, with no game-night windows ('[]').
// - The passphrase never leaks: a passing run and a failing one (a wrong passphrase from the environment, so the failure
//   output and error context are written too) are scanned, stdout, stderr, JSON report, HTML report (its embedded zip
//   unpacked) and test-results directory, for the passphrase they were given. Traces, screenshots and video are off by
//   default for live runs, so neither run leaves any; nor does the failing run keep a page snapshot, which in the lobby
//   would show the invite and rejoin links. A control run with HEXLANDS_E2E_LIVE_ARTIFACTS=on shows the
//   scan finds the passphrase where it is present: in the trace.
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
import { expect, startHarness, type Harness } from './harness';

const WEB_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SENTINEL = `sentinel-${randomUUID()}`;

const test = base.extend<object, { sentinelHarness: Harness }>({
  sentinelHarness: [
    // eslint-disable-next-line no-empty-pattern -- Playwright fixtures require an object pattern
    async ({}, use) => {
      const h = await startHarness({ config: { rooms: { createPassphrase: SENTINEL, createsPerIpPerHour: 1000 } } });
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
 * Runs live-smoke.spec.ts on Chromium against `baseURL` with `passphrase` (and `extraEnv`) in the environment, the
 * live settings otherwise at their defaults, every output under a temp dir.
 */
function runLiveSmoke(baseURL: string, passphrase: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<ChildRun> {
  const dir = mkdtempSync(join(tmpdir(), 'hexlands-live-sentinel-'));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HEXLANDS_E2E_BASE_URL: baseURL,
    HEXLANDS_ROOMS_CREATE_PASSPHRASE: passphrase,
    PLAYWRIGHT_JSON_OUTPUT_FILE: join(dir, 'report.json'),
    PLAYWRIGHT_HTML_OUTPUT_DIR: join(dir, 'html'),
    PLAYWRIGHT_HTML_OPEN: 'never',
  };
  for (const name of ['HEXLANDS_E2E_LIVE_ARTIFACTS', 'HEXLANDS_E2E_LIVE_INSECURE_TLS', 'HEXLANDS_E2E_LIVE_OVERRIDE_WINDOW']) {
    delete env[name];
  }
  env['HEXLANDS_OPS_GAME_NIGHT_WINDOWS'] = '[]';
  Object.assign(env, extraEnv);
  const args = ['test', 'e2e/live-smoke.spec.ts', '--project=chromium', '--reporter=list,json,html', `--output=${join(dir, 'test-results')}`];
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

/** Where `secret` appears in a run's output: 'stdout', 'stderr', or a file path (with '!entry' inside a zip). */
function findSecret(run: ChildRun, secret: string): string[] {
  const hits: string[] = [];
  if (run.stdout.includes(secret)) hits.push('stdout');
  if (run.stderr.includes(secret)) hits.push('stderr');
  for (const rel of filesUnder(run.dir)) {
    const bytes = readFileSync(join(run.dir, rel));
    if (bytes.includes(secret)) hits.push(rel);
    if (rel.endsWith('.zip')) for (const e of unzip(bytes)) if (e.data.includes(secret)) hits.push(`${rel}!${e.name}`);
    const embedded = /data:application\/zip;base64,([A-Za-z0-9+/=]+)/.exec(bytes.toString('latin1'));
    if (embedded) for (const e of unzip(Buffer.from(embedded[1]!, 'base64'))) if (e.data.includes(secret)) hits.push(`${rel}!${e.name}`);
  }
  return hits;
}

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

test.describe('the live smoke never leaks the room-creation passphrase', () => {
  test.describe.configure({ timeout: 180_000 });

  test('a passing run: the passphrase is in no output, report or result file, and no trace, screenshot or video exists', async ({ sentinelHarness }) => {
    const run = await runLiveSmoke(sentinelHarness.baseURL, SENTINEL);
    try {
      expect(run.exitCode, 'the live smoke passes against the harness').toBe(0);
      expect(readReport(run).stats).toMatchObject({ expected: 1, unexpected: 0, skipped: 0 });
      expect(htmlReportEntries(run).length, 'the HTML report data was unpacked').toBeGreaterThan(0);
      expect(filesUnder(run.dir).filter((f) => ARTIFACT.test(f))).toEqual([]);
      expect(findSecret(run, SENTINEL)).toEqual([]);
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  test('a failing run (wrong passphrase): the passphrase is in no output, report, error context or result file, and no page snapshot is kept', async ({ sentinelHarness }) => {
    const wrong = `wrong-${SENTINEL}`;
    const run = await runLiveSmoke(sentinelHarness.baseURL, wrong);
    try {
      expect(run.exitCode, 'the live smoke fails: the server rejects the passphrase').not.toBe(0);
      expect(run.stdout).toContain('the server refused to create the room: That passphrase isn’t right.');
      expect(readReport(run).stats).toMatchObject({ expected: 0, unexpected: 1 });
      expect(filesUnder(run.dir).some((f) => f.endsWith('error-context.md')), 'the failure wrote its error context').toBe(true);
      expect(filesUnder(run.dir).filter((f) => ARTIFACT.test(f))).toEqual([]);
      expect(findSecret(run, wrong)).toEqual([]);
      // No page snapshot either: in the lobby it would show the invite and rejoin links (room code, seat token).
      expect(findSecret(run, PAGE_SNAPSHOT), 'a failure page snapshot was written').toEqual([]);
    } finally {
      rmSync(run.dir, { recursive: true, force: true });
    }
  });

  test('control: with HEXLANDS_E2E_LIVE_ARTIFACTS=on the trace holds the passphrase, and the scan finds it there', async ({ sentinelHarness }) => {
    const run = await runLiveSmoke(sentinelHarness.baseURL, SENTINEL, { HEXLANDS_E2E_LIVE_ARTIFACTS: 'on' });
    try {
      expect(run.exitCode).toBe(0);
      expect(run.stderr + run.stdout).toContain('HEXLANDS_E2E_LIVE_ARTIFACTS=on');
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
