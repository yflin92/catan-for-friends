// Game-night pre-flight (deploy/README.md, "Game night" → "Pre-flight (day of)"): the six manual checks as one
// read-only command. Every check prints PASS, WARN, FAIL or UNKNOWN; any FAIL exits 1 (a usage error exits 2), and the
// summary names each UNKNOWN to verify by hand.
//
//   node --experimental-strip-types --no-warnings --import ./tooling/ts-resolve-hook.mjs tooling/gamenight-preflight.ts \
//     --sha <deployed sha> [--env deploy/.env] [--backups deploy/backups] [--base https://<host>] [--repo owner/name]
//
// Read-only: HTTP GETs to the server's public /healthz and /version.txt and to the Grafana API (Alertmanager alerts,
// and probe_success through the Prometheus datasource proxy with prom-client.ts), `gh api` GETs, and file reads. Secret
// values (tokens, the room-creation passphrase, URL userinfo, the backup remote) are only ever reported as set or
// not set; errors name URLs without userinfo or query.
import { execFile } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { CHECK_JOB } from '../deploy/observability/synthetic-monitoring.ts';
import { parseWindows } from '../deploy/observability/windows.ts';
import { promQuery, redactUrl } from './load/prom-client.ts';

export type Status = 'PASS' | 'WARN' | 'FAIL' | 'UNKNOWN';
export interface CheckResult {
  readonly n: number;
  readonly name: string;
  readonly status: Status;
  readonly detail: string;
}

/** The branch-protection checks main must require (docs/README.md, "Repository settings"). */
export const REQUIRED_CHECKS = ['lint', 'typecheck', 'depcruise', 'test', 'walker', 'e2e', 'secrets'] as const;
/** The Synthetic Monitoring check's job label. */
export const PROBE_JOB = CHECK_JOB;

export interface Options {
  readonly sha: string;
  readonly envFile: string;
  readonly backupsDir: string;
  /** The server's public origin; default: HEXLANDS_SITE_ADDRESS from the env file (https:// when it has no scheme). */
  readonly base?: string;
  /** owner/name; default: `gh repo view`. */
  readonly repo?: string;
  readonly now: Date;
}

export interface Deps {
  /** One GET. */
  get(url: string, headers?: Record<string, string>): Promise<{ status: number; text: string }>;
  /** Runs `gh` with these arguments (only `api` GETs and `repo view` are issued). */
  gh(args: readonly string[]): Promise<{ code: number | null; stdout: string; stderr: string; missing?: boolean }>;
}

const WORST: readonly Status[] = ['PASS', 'WARN', 'UNKNOWN', 'FAIL'];
const worst = (...s: Status[]): Status => s.reduce((a, b) => (WORST.indexOf(b) > WORST.indexOf(a) ? b : a), 'PASS');

/** KEY=VALUE lines of a .env file; comments and blank lines skipped, one level of quotes removed. */
export function readEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2]!.trim();
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) v = v.slice(1, -1);
    out[m[1]!] = v;
  }
  return out;
}

const siteOrigin = (site: string): string => (/^[a-z][a-z0-9+.-]*:\/\//i.test(site) ? site : `https://${site}`).replace(/\/$/, '');

interface Healthz {
  status?: unknown;
  draining?: unknown;
  version?: unknown;
  games?: { active?: unknown };
}

async function readHealthz(deps: Deps, base: string): Promise<{ health: Healthz | null; error: string | null }> {
  const url = `${base}/healthz`;
  try {
    const r = await deps.get(url);
    if (r.status !== 200) return { health: null, error: `${redactUrl(url)} → HTTP ${r.status}` };
    return { health: JSON.parse(r.text) as Healthz, error: null };
  } catch {
    return { health: null, error: `${redactUrl(url)} is unreachable` };
  }
}

function checkWindow(env: Record<string, string>, now: Date, health: Healthz | null, healthError: string | null): CheckResult {
  const name = 'window and activity';
  let windows;
  try {
    windows = parseWindows(env['HEXLANDS_OPS_GAME_NIGHT_WINDOWS']);
  } catch {
    return { n: 1, name, status: 'FAIL', detail: 'HEXLANDS_OPS_GAME_NIGHT_WINDOWS is not a valid list of {start, end}' };
  }
  const parts: string[] = [];
  let status: Status = 'PASS';
  const t = now.getTime();
  const current = windows.find((w) => Date.parse(w.start) <= t && t < Date.parse(w.end));
  const next = windows.filter((w) => Date.parse(w.start) > t).sort((a, b) => Date.parse(a.start) - Date.parse(b.start))[0];
  if (current) {
    status = 'WARN';
    parts.push(`inside the game-night window ${current.start} – ${current.end}: do not deploy now`);
  } else if (next) {
    parts.push(`next game-night window starts ${next.start}`);
  } else {
    status = 'WARN';
    parts.push(windows.length === 0 ? 'no game-night window set (the NFR9 window alert is inactive)' : 'no upcoming game-night window');
  }
  if (health === null) {
    status = worst(status, 'UNKNOWN');
    parts.push(`games.active unknown (${healthError ?? 'no /healthz'})`);
  } else {
    const active = Number(health.games?.active);
    if (!Number.isFinite(active)) {
      status = worst(status, 'UNKNOWN');
      parts.push('games.active missing from /healthz');
    } else if (active > 0) {
      status = worst(status, 'WARN');
      parts.push(`${active} game(s) active: a deploy would be refused`);
    } else {
      parts.push('no game active');
    }
  }
  return { n: 1, name, status, detail: parts.join('; ') };
}

async function checkServer(deps: Deps, base: string, sha: string, health: Healthz | null, healthError: string | null): Promise<CheckResult> {
  const name = 'server healthy, intended build';
  if (health === null) return { n: 2, name, status: 'FAIL', detail: healthError ?? '/healthz unavailable' };
  const problems: string[] = [];
  if (health.status !== 'ok') problems.push(`status is ${JSON.stringify(health.status)}`);
  if (health.draining !== false) problems.push('the server is draining');
  if (health.version !== sha) problems.push(`/healthz version is ${JSON.stringify(health.version)}, expected ${sha}`);
  const vurl = `${base}/version.txt`;
  try {
    const r = await deps.get(vurl);
    if (r.status !== 200) problems.push(`${redactUrl(vurl)} → HTTP ${r.status}`);
    else if (r.text.trim() !== sha) problems.push(`/version.txt is ${JSON.stringify(r.text.trim())}, expected ${sha}`);
  } catch {
    problems.push(`${redactUrl(vurl)} is unreachable`);
  }
  return problems.length === 0
    ? { n: 2, name, status: 'PASS', detail: `/healthz ok, not draining; version and /version.txt = ${sha}` }
    : { n: 2, name, status: 'FAIL', detail: problems.join('; ') };
}

/** The Grafana base URL without userinfo, and the Authorization header (the token, else the URL's userinfo). */
function grafanaAuth(raw: string, token: string | undefined): { base: string; headers: Record<string, string> } | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  else if (u.username !== '' || u.password !== '') {
    headers['Authorization'] = `Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')}`;
  }
  u.username = '';
  u.password = '';
  return { base: u.toString().replace(/\/$/, ''), headers };
}

async function checkGrafana(deps: Deps, env: Record<string, string>): Promise<CheckResult> {
  const name = 'dashboard: alerts and probe';
  const rawUrl = env['GRAFANA_URL'];
  const token = env['GRAFANA_SA_TOKEN'];
  if (!rawUrl || !token) {
    return { n: 3, name, status: 'UNKNOWN', detail: 'GRAFANA_URL or GRAFANA_SA_TOKEN not set: check the Catan folder and catan-healthz in Grafana by hand' };
  }
  const g = grafanaAuth(rawUrl, token);
  if (g === null) return { n: 3, name, status: 'FAIL', detail: 'GRAFANA_URL is not a valid URL' };
  const parts: string[] = [];
  let status: Status = 'PASS';

  const alertsUrl = `${g.base}/api/alertmanager/grafana/api/v2/alerts?active=true&silenced=false&inhibited=false`;
  try {
    const r = await deps.get(alertsUrl, g.headers);
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    const firing = (JSON.parse(r.text) as { labels?: Record<string, string>; status?: { state?: string } }[]).filter(
      (a) => a.labels?.['grafana_folder'] === 'Catan' && (a.status?.state ?? 'active') === 'active',
    );
    if (firing.length > 0) {
      status = 'FAIL';
      parts.push(`firing in Catan: ${[...new Set(firing.map((a) => a.labels?.['alertname'] ?? '?'))].join(', ')}`);
    } else {
      parts.push('no firing alerts in Catan');
    }
  } catch (e) {
    status = worst(status, 'UNKNOWN');
    const code = e instanceof Error && /^HTTP \d+$/.test(e.message) ? ` → ${e.message}` : ' failed';
    parts.push(`alerts: ${redactUrl(alertsUrl)}${code}`);
  }

  // promQuery reads the token from the environment and never prints it.
  process.env['GRAFANA_SA_TOKEN'] = token;
  const promUrl = `${g.base}/api/datasources/proxy/uid/${env['GRAFANA_PROM_UID'] || 'grafanacloud-prom'}`;
  try {
    const rows = await promQuery(promUrl, `probe_success{job="${PROBE_JOB}"}`);
    if (rows.length === 0) {
      status = 'FAIL';
      parts.push(`${PROBE_JOB}: no probe_success samples (check not running?)`);
    } else if (rows.some((r) => Number(r.value[1]) < 1)) {
      status = 'FAIL';
      parts.push(`${PROBE_JOB}: a probe is failing`);
    } else {
      parts.push(`${PROBE_JOB} passing`);
    }
  } catch (e) {
    status = worst(status, 'UNKNOWN');
    parts.push(e instanceof Error ? e.message : `${PROBE_JOB}: query failed`);
  }
  return { n: 3, name, status, detail: parts.join('; ') };
}

function checkRoomCreation(env: Record<string, string>): CheckResult {
  const name = 'room-creation decision (Q9)';
  if ((env['HEXLANDS_ROOMS_CREATE_PASSPHRASE'] ?? '') !== '') return { n: 4, name, status: 'PASS', detail: 'passphrase set (value not shown)' };
  if (env['HEXLANDS_ALLOW_OPEN_CREATION'] === 'yes') return { n: 4, name, status: 'PASS', detail: 'open room creation chosen (HEXLANDS_ALLOW_OPEN_CREATION=yes)' };
  return { n: 4, name, status: 'FAIL', detail: 'neither HEXLANDS_ROOMS_CREATE_PASSPHRASE nor HEXLANDS_ALLOW_OPEN_CREATION=yes is set' };
}

async function checkBranchProtection(deps: Deps, repoArg: string | undefined): Promise<CheckResult> {
  const name = 'branch protection';
  const manual = 'verify manually in GitHub settings';
  let repo = repoArg;
  if (repo === undefined) {
    const r = await deps.gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
    if (r.missing) return { n: 5, name, status: 'UNKNOWN', detail: `gh is not installed: ${manual}` };
    repo = r.code === 0 ? r.stdout.trim() : undefined;
    if (!repo) return { n: 5, name, status: 'UNKNOWN', detail: `the repository is unknown (pass --repo): ${manual}` };
  }
  const r = await deps.gh(['api', `repos/${repo}/branches/main/protection`]);
  if (r.missing) return { n: 5, name, status: 'UNKNOWN', detail: `gh is not installed: ${manual}` };
  if (r.code !== 0) {
    const http = /HTTP (\d{3})/.exec(r.stderr)?.[1];
    return { n: 5, name, status: 'UNKNOWN', detail: `${http ? `GitHub answered ${http}` : 'gh api failed'}: ${manual}` };
  }
  let body: { required_status_checks?: { contexts?: string[]; checks?: { context?: string }[] } | null };
  try {
    body = JSON.parse(r.stdout) as typeof body;
  } catch {
    return { n: 5, name, status: 'UNKNOWN', detail: `unreadable answer from GitHub: ${manual}` };
  }
  const rsc = body.required_status_checks;
  if (!rsc) return { n: 5, name, status: 'FAIL', detail: 'main requires no status checks' };
  const have = new Set([...(rsc.contexts ?? []), ...(rsc.checks ?? []).map((c) => c.context ?? '')]);
  const missing = REQUIRED_CHECKS.filter((c) => !have.has(c));
  return missing.length === 0
    ? { n: 5, name, status: 'PASS', detail: `main requires all ${REQUIRED_CHECKS.length} checks` }
    : { n: 5, name, status: 'FAIL', detail: `main does not require: ${missing.join(', ')}` };
}

const STAMP = /^hexlands-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.db$/;
const localDay = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function checkBackup(dir: string, env: Record<string, string>, now: Date): CheckResult {
  const name = 'backup taken';
  const remote = (env['HEXLANDS_BACKUP_REMOTE'] ?? '') !== '' ? 'remote set (value not shown)' : 'no remote (local copies only)';
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return { n: 6, name, status: 'FAIL', detail: `no backups directory; run deploy/backup.sh; ${remote}` };
  }
  const stamps = files
    .map((f) => STAMP.exec(f))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ file: m[0], at: new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!)) }))
    .sort((a, b) => b.at.getTime() - a.at.getTime());
  const newest = stamps[0];
  if (!newest) return { n: 6, name, status: 'FAIL', detail: `no backup found; run deploy/backup.sh; ${remote}` };
  return localDay(newest.at) === localDay(now)
    ? { n: 6, name, status: 'PASS', detail: `newest ${newest.file} is from today; ${remote}` }
    : { n: 6, name, status: 'FAIL', detail: `newest ${newest.file} is from ${localDay(newest.at)}, not today; run deploy/backup.sh; ${remote}` };
}

/** Runs the six checks in runbook order. */
export async function preflight(opts: Options, deps: Deps): Promise<CheckResult[]> {
  const env = readEnvFile(opts.envFile);
  const site = opts.base ?? (env['HEXLANDS_SITE_ADDRESS'] ? siteOrigin(env['HEXLANDS_SITE_ADDRESS']) : undefined);
  const { health, error } = site ? await readHealthz(deps, site) : { health: null, error: 'HEXLANDS_SITE_ADDRESS not set' };
  return [
    checkWindow(env, opts.now, health, error),
    site ? await checkServer(deps, site, opts.sha, health, error) : { n: 2, name: 'server healthy, intended build', status: 'FAIL', detail: 'HEXLANDS_SITE_ADDRESS not set' },
    await checkGrafana(deps, env),
    checkRoomCreation(env),
    await checkBranchProtection(deps, opts.repo),
    checkBackup(opts.backupsDir, env, opts.now),
  ];
}

/** The printed report and the exit code (1 when any check failed). */
export function report(results: readonly CheckResult[]): { text: string; code: number } {
  const lines = results.map((r) => `[${r.status}] ${r.n} ${r.name}: ${r.detail}`);
  const failed = results.filter((r) => r.status === 'FAIL');
  const unknown = results.filter((r) => r.status === 'UNKNOWN');
  const summary =
    failed.length > 0
      ? `Result: FAIL (${failed.map((r) => r.n).join(', ')})`
      : `Result: no failures${unknown.length > 0 ? `; verify by hand: ${unknown.map((r) => `${r.n} ${r.name}`).join(', ')}` : ''}`;
  return { text: [...lines, summary].join('\n'), code: failed.length > 0 ? 1 : 0 };
}

/** Production dependencies: fetch for GETs, the `gh` binary on PATH. */
export const realDeps: Deps = {
  async get(url, headers = {}) {
    const res = await fetch(url, { headers, redirect: 'follow' });
    return { status: res.status, text: await res.text() };
  },
  gh(args) {
    return new Promise((resolve) => {
      execFile('gh', [...args], { encoding: 'utf8' }, (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') resolve({ code: null, stdout: '', stderr: '', missing: true });
        else resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr });
      });
    });
  },
};

function parseArgs(argv: readonly string[]): Options | string {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const sha = get('--sha');
  if (!sha) return 'usage: gamenight-preflight --sha <deployed sha> [--env deploy/.env] [--backups deploy/backups] [--base https://<host>] [--repo owner/name]';
  const base = get('--base');
  const repo = get('--repo');
  return {
    sha,
    envFile: get('--env') ?? 'deploy/.env',
    backupsDir: get('--backups') ?? 'deploy/backups',
    ...(base ? { base: base.replace(/\/$/, '') } : {}),
    ...(repo ? { repo } : {}),
    now: new Date(),
  };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (typeof opts === 'string') {
    console.error(opts);
    process.exitCode = 2;
    return;
  }
  let results: CheckResult[];
  try {
    results = await preflight(opts, realDeps);
  } catch {
    console.error(`gamenight-preflight: cannot read ${opts.envFile}`);
    process.exitCode = 2;
    return;
  }
  const { text, code } = report(results);
  console.log(text);
  process.exitCode = code;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) void main();
