// Game-night pre-flight (deploy/gamenight-preflight.sh → tooling/gamenight-preflight.ts). Hermetic: the wrapper runs
// as a subprocess against a fake HTTP server (the game server's /healthz and /version.txt, and Grafana's Alertmanager
// and Prometheus proxy), with a fake `gh` on PATH. Both record every call, so the tests can assert that only reads were
// issued. The env file carries a unique sentinel in every secret-bearing value; no output may contain one.
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { REQUIRED_CHECKS } from './gamenight-preflight.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const WRAPPER = path.join(ROOT, 'deploy/gamenight-preflight.sh');
const SHA = 'abc1234def5678';
const SENTINEL = `SENTINEL${Math.random().toString(36).slice(2)}`;
const SECRETS = {
  GRAFANA_SA_TOKEN: `${SENTINEL}-token`,
  HEXLANDS_ROOMS_CREATE_PASSPHRASE: `${SENTINEL}-passphrase`,
  HEXLANDS_BACKUP_REMOTE: `b2:${SENTINEL}-remote`,
  GRAFANA_CLOUD_TOKEN: `${SENTINEL}-cloud`,
  SM_ACCESS_TOKEN: `${SENTINEL}-sm`,
};
const USERINFO = `grafana:${SENTINEL}-userinfo`;

/** Absolute paths of the shell tools the wrapper and the fake gh use. */
const TOOLS = ['bash', 'dirname', 'env', 'id', 'mktemp', 'rm', 'head', 'readlink', 'sed', 'cat'] as const;
const TOOL_PATHS: Record<string, string> = Object.fromEntries(
  TOOLS.map((t) => [t, ['/usr/bin', '/bin'].map((d) => path.join(d, t)).find((p) => existsSync(p))!]),
);

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

// ── fakes ───────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Fake {
  healthz?: { status: number; body: unknown } | 'down';
  version?: { status: number; body: string };
  alerts?: unknown[] | number;
  probe?: { metric: Record<string, string>; value: [number, string] }[] | number;
}
interface HttpCall {
  readonly method: string;
  readonly url: string;
  readonly auth: string | undefined;
}

const HEALTHY = { status: 'ok', version: SHA, uptime_s: 1, draining: false, games: { lobby: 0, active: 0, abandoned: 0 } };

async function fakeHttp(fake: Fake): Promise<{ base: string; calls: HttpCall[] }> {
  const calls: HttpCall[] = [];
  const server: Server = createServer((req, res) => {
    calls.push({ method: req.method ?? '?', url: req.url ?? '', auth: req.headers.authorization });
    const send = (status: number, body: string, type = 'application/json') => res.writeHead(status, { 'Content-Type': type }).end(body);
    const url = req.url ?? '';
    if (url === '/healthz') {
      const h = fake.healthz ?? { status: 200, body: HEALTHY };
      if (h === 'down') return void req.socket.destroy();
      return send(h.status, JSON.stringify(h.body));
    }
    if (url === '/version.txt') {
      const v = fake.version ?? { status: 200, body: `${SHA}\n` };
      return send(v.status, v.body, 'text/plain');
    }
    if (url.startsWith('/api/alertmanager/grafana/api/v2/alerts')) {
      const a = fake.alerts ?? [];
      return typeof a === 'number' ? send(a, '{}') : send(200, JSON.stringify(a));
    }
    if (url.startsWith('/api/datasources/proxy/uid/grafanacloud-prom/api/v1/query')) {
      const p = fake.probe ?? [{ metric: { job: 'catan-healthz' }, value: [0, '1'] }];
      return typeof p === 'number' ? send(p, '{}') : send(200, JSON.stringify({ status: 'success', data: { resultType: 'vector', result: p } }));
    }
    send(404, '{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise((r) => server.close(() => r(undefined))));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls };
}

/**
 * Fake gh: logs its arguments; FAKE_GH answers the protection API (ok | 403 | 404 | unprotected) and `repo view`. Errors
 * are shaped like gh's: GitHub's JSON body on stdout, `gh: <message> (HTTP <code>)` on stderr, exit 1.
 */
const FAKE_GH = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_LOG"
case "$1 $2" in
  "repo view") echo "owner/hexlands"; exit 0 ;;
esac
err() {
  printf '{"message":"%s","documentation_url":"https://docs.github.com/rest/branches/branch-protection#get-branch-protection","status":"%s"}' "$2" "$1"
  echo "gh: $2 (HTTP $1)" >&2
  exit 1
}
case "$FAKE_GH" in
  ok) printf '{"required_status_checks":{"contexts":[%s]}}' "$FAKE_CONTEXTS" ;;
  403) err 403 'Resource not accessible by integration' ;;
  404) err 404 'Not Found' ;;
  unprotected) err 404 'Branch not protected' ;;
esac
`;
const contexts = (names: readonly string[]) => names.map((n) => `"${n}"`).join(',');

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const iso = (offsetH: number) => new Date(Date.now() + offsetH * 3_600_000).toISOString();

/** The fake docker (a Node script) and the image deploy.sh builds for SHA. */
const FAKE_DOCKER_JS = path.join(HERE, 'gamenight-preflight.fake-docker.mjs');
const SERVER_IMAGE = `catan-server:${SHA}`;

interface Run {
  readonly env?: Record<string, string | null>;
  readonly fake?: Fake;
  readonly gh?: 'ok' | '403' | '404' | 'unprotected' | 'absent';
  readonly ghChecks?: readonly string[];
  readonly backups?: readonly Date[] | 'none';
  readonly repo?: string | null;
  readonly args?: readonly string[];
  /** Images `docker image inspect` finds; default: the server image for SHA. */
  readonly images?: readonly string[];
  /** The host's TZ for the wrapper; default UTC. */
  readonly tz?: string;
  /** A copy of the CLI to run directly with Node instead of the wrapper (the write mutant). */
  readonly cli?: string;
}

async function run(r: Run = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'hexlands-preflight-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const http = await fakeHttp(r.fake ?? {});
  const env: Record<string, string> = {
    HEXLANDS_ENV: 'prod',
    HEXLANDS_SITE_ADDRESS: 'hexlands.example',
    HEXLANDS_OPS_GAME_NIGHT_WINDOWS: JSON.stringify([{ start: iso(3), end: iso(6) }]),
    GRAFANA_URL: http.base.replace('://', `://${USERINFO}@`),
    ...SECRETS,
  };
  for (const [k, v] of Object.entries(r.env ?? {})) {
    if (v === null) delete env[k];
    else env[k] = v;
  }
  const envFile = path.join(dir, '.env');
  writeFileSync(envFile, `${Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n')}\n`);
  const backups = path.join(dir, 'backups');
  if (r.backups !== 'none') {
    mkdirSync(backups);
    for (const d of r.backups ?? [new Date()]) writeFileSync(path.join(backups, `hexlands-${stamp(d)}.db`), '');
  }
  // PATH: the fake bin (gh, docker) and the shell tools the wrapper needs. No Node, no real gh, docker or curl.
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  if (r.gh !== 'absent') {
    writeFileSync(path.join(bin, 'gh'), FAKE_GH);
    chmodSync(path.join(bin, 'gh'), 0o755);
  }
  writeFileSync(path.join(bin, 'docker'), `#!/usr/bin/env bash\nexec "$FAKE_NODE" "$FAKE_DOCKER_JS" "$@"\n`);
  chmodSync(path.join(bin, 'docker'), 0o755);
  const tools = path.join(dir, 'tools');
  mkdirSync(tools);
  for (const t of TOOLS) symlinkSync(TOOL_PATHS[t]!, path.join(tools, t));
  const log = path.join(dir, 'gh.log');
  const dockerLog = path.join(dir, 'docker.log');
  writeFileSync(log, '');
  writeFileSync(dockerLog, '');
  const args = [
    '--sha', SHA, '--env', envFile, '--backups', backups, '--base', http.base,
    ...(r.repo === null ? [] : ['--repo', r.repo ?? 'owner/hexlands']),
    ...(r.args ?? []),
  ];
  const cmd = r.cli
    ? [process.execPath, '--experimental-strip-types', '--no-warnings', '--import', './tooling/ts-resolve-hook.mjs', r.cli, ...args]
    : [TOOL_PATHS['bash']!, WRAPPER, ...args];
  const child = spawn(cmd[0]!, cmd.slice(1), {
    cwd: ROOT,
    env: {
      PATH: `${bin}:${tools}`,
      HOME: dir,
      TMPDIR: dir,
      TZ: r.tz ?? 'UTC',
      FAKE_LOG: log,
      FAKE_GH: r.gh ?? 'ok',
      FAKE_CONTEXTS: contexts(r.ghChecks ?? REQUIRED_CHECKS),
      DOCKER_LOG: dockerLog,
      FAKE_IMAGES: (r.images ?? [SERVER_IMAGE]).join(','),
      FAKE_NODE: process.execPath,
      FAKE_DOCKER_JS,
    },
  });
  let out = '';
  child.stdout.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr.on('data', (d: Buffer) => (out += d.toString()));
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
  return {
    code,
    out,
    dir,
    envFile,
    backups,
    http: http.calls,
    gh: readFileSync(log, 'utf8').split('\n').filter(Boolean),
    docker: readFileSync(dockerLog, 'utf8').split('\n').filter(Boolean),
  };
}

const line = (out: string, n: number) => out.split('\n').find((l) => new RegExp(`^\\[[A-Z]+\\] ${n} `).test(l)) ?? '';
const status = (out: string, n: number) => /^\[([A-Z]+)\]/.exec(line(out, n))?.[1];

/**
 * Every call that is not a read: a non-GET HTTP request; a gh call other than `api <path>` / `repo view`; a docker call
 * other than `image inspect` or a `run --rm` whose mounts are all read-only, without --privileged or the Docker socket.
 */

function writes(r: { http: readonly HttpCall[]; gh: readonly string[]; docker?: readonly string[] }): string[] {
  const http = r.http.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.url}`);
  const gh = r.gh.filter((c) => !(/^repo view /.test(c) || (/^api \S+$/.test(c) && !/-X|--method|-f |--field|--input/.test(c))));
  const readOnlyRun = (c: string) =>
    /^run --rm /.test(c) && !/--privileged|docker\.sock/.test(c) && [...c.matchAll(/-v (\S+)/g)].every((m) => m[1]!.endsWith(':ro'));
  const docker = (r.docker ?? []).filter((c) => !(/^image inspect \S+$/.test(c) || readOnlyRun(c)));
  return [...http, ...gh, ...docker.map((c) => `docker ${c}`)];
}

/** No secret in the output or in the docker command line. */
function expectNoSecrets(r: { out: string; docker: readonly string[] }): void {
  expect(r.out).not.toContain(SENTINEL);
  expect(r.docker.join('\n')).not.toContain(SENTINEL);
}

// ── tests ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('gamenight-preflight: all green', () => {
  it('every check passes, exit 0, only reads, no secret in the output', async () => {
    const r = await run();
    expect(r.code).toBe(0);
    for (const n of [1, 2, 3, 4, 5, 6]) expect(status(r.out, n), line(r.out, n)).toBe('PASS');
    expect(r.out).toContain('Result: no failures');
    expect(writes(r)).toEqual([]);
    expect(r.gh).toEqual(['api repos/owner/hexlands/branches/main/protection']);
    // Grafana calls carry the token; the server calls carry nothing.
    expect(r.http.filter((c) => c.url.startsWith('/api/')).every((c) => c.auth === `Bearer ${SECRETS.GRAFANA_SA_TOKEN}`)).toBe(true);
    expect(r.http.filter((c) => !c.url.startsWith('/api/')).every((c) => c.auth === undefined)).toBe(true);
    expectNoSecrets(r);
  }, 30_000);

  it('without --sha: usage, exit 2', async () => {
    const child = spawn(TOOL_PATHS['bash']!, [WRAPPER], { cwd: ROOT, env: { PATH: path.dirname(TOOL_PATHS['dirname']!) } });
    let out = '';
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    expect(await new Promise((r) => child.on('close', r))).toBe(2);
    expect(out).toContain('usage: deploy/gamenight-preflight.sh --sha');
  }, 30_000);
});

describe('check 1: window and activity', () => {
  it('inside a game-night window → WARN (do not deploy now)', async () => {
    const r = await run({ env: { HEXLANDS_OPS_GAME_NIGHT_WINDOWS: JSON.stringify([{ start: iso(-1), end: iso(2) }]) } });
    expect(status(r.out, 1)).toBe('WARN');
    expect(line(r.out, 1)).toContain('do not deploy now');
    expect(r.code).toBe(0);
  }, 30_000);

  it('active games → WARN (a deploy would be refused); no window set → WARN', async () => {
    const r = await run({ env: { HEXLANDS_OPS_GAME_NIGHT_WINDOWS: '[]' }, fake: { healthz: { status: 200, body: { ...HEALTHY, games: { active: 2 } } } } });
    expect(status(r.out, 1)).toBe('WARN');
    expect(line(r.out, 1)).toContain('2 game(s) active: a deploy would be refused');
    expect(line(r.out, 1)).toContain('no game-night window set');
  }, 30_000);

  it('an invalid window list → FAIL, exit 1', async () => {
    const r = await run({ env: { HEXLANDS_OPS_GAME_NIGHT_WINDOWS: '{"start":1}' } });
    expect(status(r.out, 1)).toBe('FAIL');
    expect(r.code).toBe(1);
    expectNoSecrets(r);
  }, 30_000);
});

describe('check 2: server healthy, intended build', () => {
  it.each([
    ['another version', { healthz: { status: 200, body: { ...HEALTHY, version: 'oldsha' } } }, 'expected'],
    ['draining', { healthz: { status: 200, body: { ...HEALTHY, draining: true } } }, 'draining'],
    ['/healthz 503', { healthz: { status: 503, body: { status: 'draining' } } }, 'HTTP 503'],
    ['/version.txt differs', { version: { status: 200, body: 'oldsha\n' } }, '/version.txt is'],
    ['server unreachable', { healthz: 'down' as const }, 'unreachable'],
  ])('%s → FAIL, exit 1', async (_n, fake, text) => {
    const r = await run({ fake });
    expect(status(r.out, 2)).toBe('FAIL');
    expect(line(r.out, 2)).toContain(text);
    expect(r.code).toBe(1);
    expectNoSecrets(r);
    expect(writes(r)).toEqual([]);
  }, 30_000);
});

describe('check 3: alerts in Catan and the catan-healthz probe', () => {
  it('a firing alert in Catan → FAIL naming it; alerts elsewhere and resolved ones are ignored', async () => {
    const r = await run({
      fake: {
        alerts: [
          { labels: { alertname: 'A2 down', grafana_folder: 'Catan' }, status: { state: 'active' } },
          { labels: { alertname: 'Other', grafana_folder: 'Elsewhere' }, status: { state: 'active' } },
        ],
      },
    });
    expect(status(r.out, 3)).toBe('FAIL');
    expect(line(r.out, 3)).toContain('firing in Catan: A2 down');
    expect(line(r.out, 3)).not.toContain('Other');
    expect(r.code).toBe(1);
    expectNoSecrets(r);
  }, 30_000);

  it.each([
    ['a failing probe', [{ metric: { job: 'catan-healthz' }, value: [0, '0'] as [number, string] }], 'a probe is failing'],
    ['no probe samples', [], 'no probe_success samples'],
  ])('%s → FAIL', async (_n, probe, text) => {
    const r = await run({ fake: { probe } });
    expect(status(r.out, 3)).toBe('FAIL');
    expect(line(r.out, 3)).toContain(text);
    expectNoSecrets(r);
  }, 30_000);

  it('Grafana answering 500 → UNKNOWN (never PASS), with the URL redacted', async () => {
    const r = await run({ fake: { alerts: 500, probe: 500 } });
    expect(status(r.out, 3)).toBe('UNKNOWN');
    expect(line(r.out, 3)).toContain('HTTP 500');
    expectNoSecrets(r);
  }, 30_000);

  it('GRAFANA_URL or GRAFANA_SA_TOKEN not set → UNKNOWN, no Grafana call', async () => {
    const r = await run({ env: { GRAFANA_SA_TOKEN: null } });
    expect(status(r.out, 3)).toBe('UNKNOWN');
    expect(r.http.some((c) => c.url.startsWith('/api/'))).toBe(false);
    expect(r.out).toContain('verify by hand: 3 dashboard');
    expectNoSecrets(r);
  }, 30_000);

  it('Grafana unreachable → UNKNOWN, no secret in the error', async () => {
    const r = await run({ env: { GRAFANA_URL: `http://${USERINFO}@127.0.0.1:9/` } });
    expect(status(r.out, 3)).toBe('UNKNOWN');
    expectNoSecrets(r);
  }, 30_000);
});

describe('check 4: room-creation decision (Q9), presence only', () => {
  it('open creation → PASS; neither → FAIL, exit 1; the passphrase is never printed', async () => {
    const open = await run({ env: { HEXLANDS_ROOMS_CREATE_PASSPHRASE: null, HEXLANDS_ALLOW_OPEN_CREATION: 'yes' } });
    expect(status(open.out, 4)).toBe('PASS');
    expect(line(open.out, 4)).toContain('open room creation');
    const neither = await run({ env: { HEXLANDS_ROOMS_CREATE_PASSPHRASE: null } });
    expect(status(neither.out, 4)).toBe('FAIL');
    expect(neither.code).toBe(1);
    const set = await run();
    expect(line(set.out, 4)).toContain('passphrase set (value not shown)');
    for (const r of [open, neither, set]) expectNoSecrets(r);
  }, 60_000);
});

describe('check 5: branch protection (read-only gh api; 404 "Branch not protected" → FAIL; other 403/404 → UNKNOWN, never PASS)', () => {
  it('a required check missing → FAIL listing it', async () => {
    const r = await run({ ghChecks: REQUIRED_CHECKS.filter((c) => c !== 'secrets') });
    expect(status(r.out, 5)).toBe('FAIL');
    expect(line(r.out, 5)).toContain('does not require: secrets');
    expect(r.code).toBe(1);
  }, 30_000);

  it.each(['403', '404'] as const)('GitHub answers %s → UNKNOWN: verify manually in GitHub settings; exit 0 with a hand-check note', async (code) => {
    const r = await run({ gh: code });
    expect(status(r.out, 5)).toBe('UNKNOWN');
    expect(line(r.out, 5)).toContain(`GitHub answered ${code}: verify manually in GitHub settings`);
    expect(r.out).not.toMatch(/^\[PASS\] 5 /m);
    expect(r.out).toContain('verify by hand: 5 branch protection');
    expect(r.code).toBe(0);
    expect(writes(r)).toEqual([]);
  }, 30_000);

  it('GitHub answers 404 "Branch not protected" → FAIL: branch protection not configured on main', async () => {
    const r = await run({ gh: 'unprotected' });
    expect(status(r.out, 5)).toBe('FAIL');
    expect(line(r.out, 5)).toContain('branch protection not configured on main');
    expect(r.out).toContain('Result: FAIL');
    expect(r.code).toBe(1);
    expect(writes(r)).toEqual([]);
    expectNoSecrets(r);
  }, 30_000);

  it('gh not installed → UNKNOWN', async () => {
    const r = await run({ gh: 'absent' });
    expect(status(r.out, 5)).toBe('UNKNOWN');
    expect(line(r.out, 5)).toContain('gh is not installed');
  }, 30_000);

  it('without --repo: `gh repo view` (a read) names the repository', async () => {
    const r = await run({ repo: null });
    expect(r.gh).toEqual(['repo view --json nameWithOwner --jq .nameWithOwner', 'api repos/owner/hexlands/branches/main/protection']);
    expect(status(r.out, 5)).toBe('PASS');
    expect(writes(r)).toEqual([]);
  }, 30_000);
});

describe('check 6: backup taken', () => {
  it('the newest backup from yesterday → FAIL; no backups → FAIL; the remote is reported by presence only', async () => {
    const old = await run({ backups: [new Date(Date.now() - 40 * 3_600_000)] });
    expect(status(old.out, 6)).toBe('FAIL');
    expect(line(old.out, 6)).toContain('not today');
    expect(line(old.out, 6)).toContain('remote set (value not shown)');
    const none = await run({ backups: 'none', env: { HEXLANDS_BACKUP_REMOTE: null } });
    expect(status(none.out, 6)).toBe('FAIL');
    expect(line(none.out, 6)).toContain('no backups directory');
    expect(line(none.out, 6)).toContain('no remote (local copies only)');
    for (const r of [old, none]) {
      expect(r.code).toBe(1);
      expectNoSecrets(r);
    }
  }, 60_000);
});

describe('the container (Docker is the only host prerequisite)', () => {
  it('runs in catan-server:<sha>: every mount read-only, TZ by name, no socket, no privileges, no secret in the command', async () => {
    const r = await run();
    expect(r.code).toBe(0);
    expect(r.docker).toHaveLength(2);
    expect(r.docker[0]).toBe(`image inspect ${SERVER_IMAGE}`);
    const call = r.docker[1]!;
    const mounts = [...call.matchAll(/-v (\S+)/g)].map((m) => m[1]!);
    expect(mounts).toEqual([
      `${ROOT}:/repo:ro`,
      `${r.envFile}:/preflight/env:ro`,
      expect.stringMatching(/:\/preflight\/gh:ro$/),
      `${r.backups}:/preflight/backups:ro`,
    ]);
    expect(call).toMatch(new RegExp(`^run --rm --user \\d+:\\d+ -e TZ -v .* -w /repo ${SERVER_IMAGE} node --experimental-strip-types `));
    expect(call).not.toMatch(/--privileged|docker\.sock|-e \S+=|--env-file/);
    expectNoSecrets(r);
    // The wrapper prints the invocation (a dry-run view of what it runs).
    expect(r.out).toContain(`gamenight-preflight: docker ${call}`);
    expect(writes(r)).toEqual([]);
    // The gh answer directory is removed afterwards.
    const ghDir = /-v (\S+):\/preflight\/gh:ro/.exec(call)![1]!;
    expect(existsSync(ghDir)).toBe(false);
  }, 30_000);

  it('without the deployed image: the pinned Node image, the same base as deploy/Dockerfile', async () => {
    const r = await run({ images: [] });
    const call = r.docker[1]!;
    const image = /-w \/repo (\S+) node /.exec(call)![1]!;
    expect(image).toBe('node:22-bookworm-slim');
    expect(readFileSync(path.join(ROOT, 'deploy/Dockerfile'), 'utf8')).toContain(`FROM ${image} AS runtime`);
    expect(r.code).toBe(0);
  }, 30_000);

  it('a missing backups directory is not mounted (Docker would create it) and check 6 fails', async () => {
    const r = await run({ backups: 'none' });
    expect(r.docker[1]).not.toContain(':/preflight/backups');
    expect(status(r.out, 6)).toBe('FAIL');
  }, 30_000);

  it('"today" is the host\'s day: TZ reaches the container (a game night just before midnight)', async () => {
    // 2026-10-08 23:30 UTC = 16:30 in Los Angeles; the check runs at 2026-10-09 06:50 UTC = 23:50 the same LA evening.
    const backup = [new Date('2026-10-08T23:30:00Z')];
    const args = ['--now', '2026-10-09T06:50:00Z'];
    const la = await run({ tz: 'America/Los_Angeles', backups: backup, args });
    expect(status(la.out, 6), line(la.out, 6)).toBe('PASS');
    const utc = await run({ tz: 'UTC', backups: backup, args });
    expect(status(utc.out, 6)).toBe('FAIL');
    expect(line(utc.out, 6)).toContain('is from 2026-10-08, not today');
  }, 60_000);

  it('the wrapper never passes secrets on the command line and never touches the Docker socket', () => {
    const code = readFileSync(WRAPPER, 'utf8').split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
    expect(code).not.toMatch(/docker\.sock|--privileged|--env-file|-e [A-Z_]+=|compose|curl|deploy\.sh|backup\.sh/);
    expect(statSync(WRAPPER).mode & 0o111).not.toBe(0);
  });
});

describe('REQUIRED_CHECKS', () => {
  it('matches the required checks listed in docs/README.md ("Repository settings")', () => {
    const doc = readFileSync(path.join(ROOT, 'docs/README.md'), 'utf8');
    const section = doc.slice(doc.indexOf('with these required checks'), doc.indexOf('3. **Require branches to be up to date'));
    const listed = [...section.matchAll(/^\s+- `([a-z0-9-]+)`$/gm)].map((m) => m[1]);
    expect(listed.length).toBeGreaterThan(0);
    expect([...REQUIRED_CHECKS].sort()).toEqual([...listed].sort());
  });
});

describe('read-only and secret guards', () => {
  it('a write mutant (gh api -X PUT, an HTTP POST to Grafana) is caught by the read-only check', async () => {
    const src = readFileSync(path.join(HERE, 'gamenight-preflight.ts'), 'utf8');
    const anchor = "  const r = await deps.gh(['api', `repos/${repo}/branches/main/protection`]);";
    expect(src).toContain(anchor);
    const mutant = src.replace(
      anchor,
      `  await deps.gh(['api', '-X', 'PUT', \`repos/\${repo}/branches/main/protection\`]);
  await fetch(\`\${(readEnvFile(process.argv[process.argv.indexOf('--env') + 1]!)['GRAFANA_URL'] ?? '').replace(/\\/\\/[^@]*@/, '//')}/api/folders\`, { method: 'POST' }).catch(() => undefined);
${anchor}`,
    );
    const file = path.join(HERE, `.gamenight-preflight-mutant-${process.pid}.ts`);
    writeFileSync(file, mutant);
    cleanups.push(() => rmSync(file, { force: true }));
    const r = await run({ cli: path.relative(ROOT, file) });
    expect(writes(r)).toEqual(expect.arrayContaining([expect.stringMatching(/^api -X PUT /), expect.stringMatching(/^POST \/api\/folders/)]));
  }, 30_000);

});
