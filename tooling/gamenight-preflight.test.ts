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
const TOOLS = ['bash', 'dirname', 'env', 'id', 'mktemp', 'rm', 'head', 'readlink', 'sed', 'cat', 'mkdir'] as const;
const TOOL_PATHS: Record<string, string> = Object.fromEntries(
  TOOLS.map((t) => [t, ['/usr/bin', '/bin'].map((d) => path.join(d, t)).find((p) => existsSync(p))!]),
);

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

// ── fakes ───────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Fake {
  healthz?: { status: number; body: unknown } | 'down' | 'empty';
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

/** The fake site's hostname; the fake docker resolves it to 127.0.0.1 only when the run has `--add-host SITE:host-gateway`. */
const SITE = 'hexlands.example';

async function fakeHttp(fake: Fake): Promise<{ base: string; site: string; calls: HttpCall[] }> {
  const calls: HttpCall[] = [];
  const server: Server = createServer((req, res) => {
    calls.push({ method: req.method ?? '?', url: req.url ?? '', auth: req.headers.authorization });
    const send = (status: number, body: string, type = 'application/json') => res.writeHead(status, { 'Content-Type': type }).end(body);
    const url = req.url ?? '';
    if (url === '/healthz') {
      const h = fake.healthz ?? { status: 200, body: HEALTHY };
      if (h === 'down') return void req.socket.destroy();
      if (h === 'empty') return send(200, '', 'text/plain');
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
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, site: `http://${SITE}:${port}`, calls };
}

/**
 * Fake gh: logs its arguments; answers `repo view`, the branch-protection API (FAKE_GH: ok | 403 | 404 | unprotected,
 * with FAKE_CONTEXTS) and the rulesets on main (FAKE_RULES: ok | 403, with FAKE_RULE_CONTEXTS). Errors are shaped like
 * gh's: GitHub's JSON body on stdout, `gh: <message> (HTTP <code>)` on stderr, exit 1.
 */
const FAKE_GH = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_LOG"
err() {
  printf '{"message":"%s","documentation_url":"https://docs.github.com/rest","status":"%s"}' "$2" "$1"
  echo "gh: $2 (HTTP $1)" >&2
  exit 1
}
case "$1 $2" in
  "repo view") echo "owner/hexlands"; exit 0 ;;
  "api repos/owner/hexlands/branches/main/protection")
    case "$FAKE_GH" in
      ok) printf '{"required_status_checks":{"contexts":[%s]}}' "$FAKE_CONTEXTS" ;;
      403) err 403 'Resource not accessible by integration' ;;
      404) err 404 'Not Found' ;;
      unprotected) err 404 'Branch not protected' ;;
    esac ;;
  "api repos/owner/hexlands/rules/branches/main")
    case "$FAKE_RULES" in
      ok) printf '[{"type":"deletion","ruleset_id":1},{"type":"required_status_checks","ruleset_id":2,"parameters":{"strict_required_status_checks_policy":true,"required_status_checks":[%s]}}]' "$FAKE_RULE_CONTEXTS" ;;
      none) printf '[]' ;;
      403) err 403 'Resource not accessible by integration' ;;
    esac ;;
  *) exit 1 ;;
esac
`;
const contexts = (names: readonly string[]) => names.map((n) => `"${n}"`).join(',');
const ruleContexts = (names: readonly string[]) => names.map((n) => `{"context":"${n}","integration_id":15368}`).join(',');

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
  /** The rulesets answer; default `none` (`[]`, as for a repo without rulesets). */
  readonly rules?: 'ok' | 'none' | '403';
  readonly rulesChecks?: readonly string[];
  /** --base; default: the fake site by name. null: none (the site comes from HEXLANDS_SITE_ADDRESS). */
  readonly base?: string | null;
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
    HEXLANDS_SITE_ADDRESS: SITE,
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
    '--sha', SHA, '--env', envFile, '--backups', backups,
    ...(r.base === null ? [] : ['--base', r.base ?? http.site]),
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
      FAKE_RULES: r.rules ?? 'none',
      FAKE_RULE_CONTEXTS: ruleContexts(r.rulesChecks ?? []),
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
    site: http.site,
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
    expect(r.gh).toEqual(['api repos/owner/hexlands/branches/main/protection', 'api repos/owner/hexlands/rules/branches/main']);
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
    ['an empty 200 (another site behind the proxy)', { healthz: 'empty' as const }, 'answered 200 without /healthz JSON'],
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

describe('check 5: branch protection (branch protection rule ∪ rulesets; read-only gh api; never a false PASS)', () => {
  const ALL = REQUIRED_CHECKS;
  const without = (...names: string[]) => ALL.filter((c) => !names.includes(c));

  it.each([
    ['classic rule only', { gh: 'ok', rules: 'none' }, 'branch protection)'],
    ['ruleset only (classic: 404 "Branch not protected")', { gh: 'unprotected', rules: 'ok', rulesChecks: ALL }, '(rulesets)'],
    ['both partial, the union covers all', { ghChecks: without('e2e', 'walker'), rules: 'ok', rulesChecks: ['e2e', 'walker'] }, 'branch protection + rulesets'],
    ['the rulesets unreadable, the classic rule covers all', { rules: '403' }, '(branch protection)'],
    ['the classic rule unreadable (403), the rulesets cover all', { gh: '403', rules: 'ok', rulesChecks: ALL }, '(rulesets)'],
  ] as const)('%s → PASS', async (_n, opts, via) => {
    const r = await run(opts as Run);
    expect(status(r.out, 5), line(r.out, 5)).toBe('PASS');
    expect(line(r.out, 5)).toContain(`main requires all 7 checks`);
    expect(line(r.out, 5)).toContain(via);
    expect(writes(r)).toEqual([]);
  }, 30_000);

  it.each([
    ['both partial', { ghChecks: without('secrets', 'e2e'), rules: 'ok', rulesChecks: ['e2e'] }],
    ['ruleset only (classic: 404 "Branch not protected"), the ruleset missing a check', { gh: 'unprotected', rules: 'ok', rulesChecks: without('secrets') }],
  ] as const)('both read, %s, a required check missing from both → FAIL listing it', async (_n, opts) => {
    const r = await run(opts as Run);
    expect(status(r.out, 5), line(r.out, 5)).toBe('FAIL');
    expect(line(r.out, 5)).toContain('main does not require: secrets');
    expect(r.code).toBe(1);
  }, 30_000);

  it('404 "Branch not protected" and no ruleset requiring checks → FAIL: branch protection not configured on main', async () => {
    const r = await run({ gh: 'unprotected' });
    expect(status(r.out, 5)).toBe('FAIL');
    expect(line(r.out, 5)).toContain('branch protection not configured on main');
    expect(r.out).toContain('Result: FAIL');
    expect(r.code).toBe(1);
    expect(writes(r)).toEqual([]);
    expectNoSecrets(r);
  }, 30_000);

  it.each([
    ['the classic rule 403, no rulesets', { gh: '403' }, 'branch protection: GitHub answered 403'],
    ['the classic rule 404 Not Found, no rulesets', { gh: '404' }, 'branch protection: GitHub answered 404'],
    ['the classic rule 403, the rulesets partial', { gh: '403', rules: 'ok', rulesChecks: without('secrets') }, 'does not require: secrets'],
    ['the classic rule partial, the rulesets 403', { ghChecks: without('lint'), rules: '403' }, 'rulesets: GitHub answered 403'],
    ['the classic rule 404 "Branch not protected", the rulesets 403', { gh: 'unprotected', rules: '403' }, 'rulesets: GitHub answered 403'],
    ['neither readable', { gh: '403', rules: '403' }, 'branch protection: GitHub answered 403; rulesets: GitHub answered 403'],
  ] as const)('%s → UNKNOWN: verify manually in GitHub settings; exit 0 with a hand-check note', async (_n, opts, text) => {
    const r = await run(opts as Run);
    expect(status(r.out, 5), line(r.out, 5)).toBe('UNKNOWN');
    expect(line(r.out, 5)).toContain(text);
    expect(line(r.out, 5)).toContain('verify manually in GitHub settings');
    expect(r.out).toContain('verify by hand: 5 branch protection');
    expect(r.code).toBe(0);
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
    expect(r.gh).toEqual([
      'repo view --json nameWithOwner --jq .nameWithOwner',
      'api repos/owner/hexlands/branches/main/protection',
      'api repos/owner/hexlands/rules/branches/main',
    ]);
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
    expect(call).toMatch(
      new RegExp(`^run --rm --user \\d+:\\d+ -e TZ --add-host ${SITE}:host-gateway -v .* -w /repo ${SERVER_IMAGE} node --experimental-strip-types `),
    );
    expect(call).not.toMatch(/--privileged|docker\.sock|-e \S+=|--env-file|--network/);
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
    expect(code).not.toMatch(/docker\.sock|--privileged|--env-file|-e [A-Z_]+=|--network|compose|curl|deploy\.sh|backup\.sh/);
    expect(statSync(WRAPPER).mode & 0o111).not.toBe(0);
  });
});

describe('the site from the container (--add-host <site>:host-gateway; no hairpin NAT needed)', () => {
  it('/healthz reaches the site by name only through --add-host (the name resolves nowhere else)', async () => {
    const r = await run();
    expect(r.docker[1]).toContain(`--add-host ${SITE}:host-gateway`);
    expect(status(r.out, 2), line(r.out, 2)).toBe('PASS');
    // The request goes to the site under its own name: the Host header (and, over https, SNI) is the site's.
    expect(r.http.some((c) => c.url === '/healthz')).toBe(true);
  }, 30_000);

  it.each([
    ['--base with scheme, port and path', { base: 'https://play.example.org:8443/x/' }],
    ['HEXLANDS_SITE_ADDRESS bare', { base: null, env: { HEXLANDS_SITE_ADDRESS: 'play.example.org' } }],
    ['HEXLANDS_SITE_ADDRESS with scheme and slash', { base: null, env: { HEXLANDS_SITE_ADDRESS: 'https://play.example.org/' } }],
    ['HEXLANDS_SITE_ADDRESS quoted, with a port and trailing space', { base: null, env: { HEXLANDS_SITE_ADDRESS: '"play.example.org:443" ' } }],
  ] as const)('%s → --add-host play.example.org:host-gateway (the bare hostname)', async (_n, opts) => {
    const r = await run({ ...opts, fake: { healthz: 'down' } } as Run);
    expect(r.docker[1]).toContain(' --add-host play.example.org:host-gateway ');
    expect(r.docker[1]!.match(/--add-host/g)).toHaveLength(1);
  }, 30_000);

  it('an IP address as the site → no --add-host (nothing to name)', async () => {
    const r = await run({ base: 'http://192.0.2.10', fake: { healthz: 'down' } });
    expect(r.docker[1]).not.toContain('--add-host');
  }, 30_000);

  it.each(['http://127.0.0.1:8080', 'http://localhost', 'https://[::1]:443'])('--base %s (the container itself) → exit 2 before docker run', async (base) => {
    const r = await run({ base });
    expect(r.code).toBe(2);
    expect(r.out).toContain('must name the site');
    expect(r.docker.filter((c) => c.startsWith('run '))).toEqual([]);
  }, 30_000);

  it('--base with credentials → exit 2, the credentials never printed', async () => {
    const r = await run({ base: `https://ops:${SENTINEL}-base@play.example.org` });
    expect(r.code).toBe(2);
    expect(r.out).toContain('must not contain credentials');
    expect(r.docker).toEqual([]);
    expectNoSecrets(r);
  }, 30_000);
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
    const anchor = "      const r = await deps.gh(['api', src.path(repo)]);";
    expect(src).toContain(anchor);
    const mutant = src.replace(
      anchor,
      `      await deps.gh(['api', '-X', 'PUT', src.path(repo)]);
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
