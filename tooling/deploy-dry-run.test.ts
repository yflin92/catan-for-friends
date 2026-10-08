// deploy.sh --dry-run (X-deploy-rehearsal item 8): runs the preflight and the guard's /healthz read, prints the steps
// it would take, and changes nothing. Hermetic: a copy of deploy.sh runs against a placeholder .env with fake `docker`,
// `git` and `curl` on PATH that log every call, so no Docker daemon, network or host is involved.
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const DEPLOY_SH = path.join(path.dirname(fileURLToPath(import.meta.url)), '../deploy/deploy.sh');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ENV_OK = ['HEXLANDS_ENV=prod', 'HEXLANDS_SITE_ADDRESS=http://localhost', 'HEXLANDS_ALLOW_OPEN_CREATION=yes', 'HEXLANDS_DEPLOY_ALLOW_NO_OBSERVABILITY=yes'];

/** Fake docker: logs its arguments; `compose ps -q` prints an id when FAKE_RUNNING=1; the healthz read prints FAKE_ACTIVE. */
const FAKE_DOCKER = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_LOG"
case "$*" in
  *" ps -q "*) [ "$FAKE_RUNNING" = 1 ] && echo 0123456789ab ;;
  *"games.active"*) echo "$FAKE_ACTIVE" ;;
esac
exit 0
`;

function dryRun(opts: { args?: string[]; env?: string[]; running?: boolean; active?: number; dry?: boolean; shellEnv?: Record<string, string> }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'hexlands-dry-run-'));
  dirs.push(dir);
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  copyFileSync(DEPLOY_SH, path.join(dir, 'deploy.sh'));
  writeFileSync(path.join(dir, '.env'), `${(opts.env ?? ENV_OK).join('\n')}\n`);
  writeFileSync(path.join(bin, 'docker'), FAKE_DOCKER);
  writeFileSync(path.join(bin, 'git'), '#!/usr/bin/env bash\necho abc123def456\n');
  writeFileSync(path.join(bin, 'curl'), '#!/usr/bin/env bash\necho "curl $*" >> "$FAKE_LOG"\n');
  for (const f of ['docker', 'git', 'curl']) chmodSync(path.join(bin, f), 0o755);
  const log = path.join(dir, 'calls.log');
  writeFileSync(log, '');
  const r = spawnSync('bash', [path.join(dir, 'deploy.sh'), ...(opts.dry === false ? [] : ['--dry-run']), ...(opts.args ?? [])], {
    encoding: 'utf8',
    env: {
      ...opts.shellEnv,
      PATH: `${bin}:${process.env['PATH'] ?? ''}`,
      FAKE_LOG: log,
      FAKE_RUNNING: opts.running ? '1' : '0',
      FAKE_ACTIVE: String(opts.active ?? 0),
    },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, calls: readFileSync(log, 'utf8').split('\n').filter(Boolean) };
}

/** A call that would change the host: build, up/down/stop/start, cp, run, prune, a write inside the container, or curl. */
const mutating = (calls: string[]) =>
  calls.filter((c) => / build | up | down | stop | start | cp | run |image prune|writeFileSync|^curl /.test(` ${c} `));

describe('deploy.sh --dry-run', () => {
  it('with no running server: preflight passes, the plan is printed, and only `compose ps` is called', () => {
    const r = dryRun({});
    expect(r.code).toBe(0);
    expect(r.out).toContain('guard: no running catan-server');
    for (const step of ['build catan-server:abc123def456', 'recreate the stack', 'smoke-test http://localhost/healthz', 'prune dangling images']) {
      expect(r.out).toContain(`dry-run: would ${step}`);
    }
    expect(r.out).toContain('dry-run complete: nothing changed');
    expect(mutating(r.calls)).toEqual([]);
    expect(r.calls.every((c) => / ps -q /.test(` ${c} `))).toBe(true);
  });

  it('with a running server and no active games: reads /healthz, changes nothing', () => {
    const r = dryRun({ running: true, active: 0 });
    expect(r.code).toBe(0);
    expect(r.out).toContain('guard: games active = 0');
    expect(r.calls.some((c) => c.includes('games.active'))).toBe(true);
    expect(mutating(r.calls)).toEqual([]);
  });

  it('with active games and no --force: exits 2 like the real deploy would', () => {
    const r = dryRun({ running: true, active: 2 });
    expect(r.code).toBe(2);
    expect(r.out).toContain('refusing to deploy: games active = 2');
    expect(mutating(r.calls)).toEqual([]);
  });

  it('with active games and --force: reports the deploy-forced marker it would write, writes nothing', () => {
    const r = dryRun({ running: true, active: 2, args: ['--force'] });
    expect(r.code).toBe(0);
    expect(r.out).toContain('dry-run: would write /data/deploy-forced');
    expect(mutating(r.calls)).toEqual([]);
  });

  it('the preflight still fails as in a real deploy (no site address → exit 1, no docker call)', () => {
    const r = dryRun({ env: ['HEXLANDS_ENV=prod', 'HEXLANDS_ALLOW_OPEN_CREATION=yes', 'HEXLANDS_DEPLOY_ALLOW_NO_OBSERVABILITY=yes'] });
    expect(r.code).toBe(1);
    expect(r.out).toContain('HEXLANDS_SITE_ADDRESS is not set');
    expect(r.calls).toEqual([]);
  });

  // HEXLANDS_DEPLOY_COMPOSE_OVERLAYS is honoured only under the rehearsal marker (the first line of deploy/.env).
  const OVERLAY = { HEXLANDS_DEPLOY_COMPOSE_OVERLAYS: 'validate/compose.loki.yml' };
  it.each([true, false])('a prod .env with the overlay variable exported refuses (exit 1) before any docker call (dry run: %s)', (dry) => {
    const r = dryRun({ dry, running: true, shellEnv: OVERLAY });
    expect(r.code).toBe(1);
    expect(r.out).toContain('HEXLANDS_DEPLOY_COMPOSE_OVERLAYS is set but deploy/.env is not a local rehearsal .env');
    expect(r.calls).toEqual([]);
  });

  it('a rehearsal .env applies the overlay to every compose call and the dry run prints the compose files', () => {
    const r = dryRun({ env: ['# Local rehearsal only (deploy/validate/rehearse.sh): placeholder values, never a real host.', ...ENV_OK], running: true, shellEnv: OVERLAY });
    expect(r.code).toBe(0);
    expect(r.out).toContain('dry-run: compose files: -f docker-compose.yml -f validate/compose.loki.yml');
    const composeCalls = r.calls.filter((c) => c.startsWith('compose '));
    expect(composeCalls.length).toBeGreaterThan(0);
    for (const c of composeCalls) expect(c).toContain('-f docker-compose.yml -f validate/compose.loki.yml');
  });

  it('without the overlay variable the compose files are docker-compose.yml alone', () => {
    const r = dryRun({ running: true });
    expect(r.out).toContain('dry-run: compose files: -f docker-compose.yml\n');
    for (const c of r.calls) expect(c).not.toContain('validate/');
  });

  // Alloy exits on an unparseable endpoint, so a GRAFANA_* / SM_* line left at its .env.example placeholder must stop
  // the deploy before anything starts; blank values are the no-observability setup and pass.
  const TEMPLATE_PLACEHOLDERS = readFileSync(path.join(path.dirname(DEPLOY_SH), '.env.example'), 'utf8')
    .split('\n')
    .filter((l) => /^(GRAFANA|SM)_[A-Z0-9_]+=<.*>$/.test(l));
  const keyOf = (line: string) => line.slice(0, line.indexOf('='));

  it('the template has placeholders for the Grafana Cloud and Synthetic Monitoring keys', () => {
    expect(TEMPLATE_PLACEHOLDERS.map(keyOf)).toEqual(expect.arrayContaining(['GRAFANA_MIMIR_URL', 'GRAFANA_CLOUD_TOKEN', 'GRAFANA_URL', 'SM_API_URL', 'SM_PROBE_IDS']));
  });

  it.each([true, false])('a GRAFANA_* / SM_* value left at its .env.example placeholder refuses (exit 1) before any docker call, naming only the keys (dry run: %s)', (dry) => {
    for (const env of ['prod', 'loadtest']) {
      const r = dryRun({ dry, running: true, env: [...ENV_OK.map((l) => l.replace('HEXLANDS_ENV=prod', `HEXLANDS_ENV=${env}`)), ...TEMPLATE_PLACEHOLDERS] });
      expect(r.code, env).toBe(1);
      expect(r.out).toContain(`deploy/.env still holds the .env.example placeholder for: ${[...TEMPLATE_PLACEHOLDERS.map(keyOf)].sort().join(' ')} (blank each one, or fill it in)`);
      for (const line of TEMPLATE_PLACEHOLDERS) expect(r.out).not.toContain(line.slice(line.indexOf('=') + 1));
      expect(r.calls).toEqual([]);
    }
  });

  it('one placeholder among filled and blank values is still refused, and only that key is named', () => {
    const r = dryRun({ env: [...ENV_OK, 'GRAFANA_URL=https://stack.grafana.net', 'GRAFANA_SA_TOKEN=', 'SM_PROBE_IDS=<e.g. 1,2>'] });
    expect(r.code).toBe(1);
    expect(r.out).toContain('placeholder for: SM_PROBE_IDS (blank each one');
    expect(r.out).not.toContain('GRAFANA_URL');
  });

  it('blank GRAFANA_* / SM_* values (no-observability mode) pass the preflight', () => {
    const blank = TEMPLATE_PLACEHOLDERS.map((l) => `${keyOf(l)}=`);
    const r = dryRun({ env: [...ENV_OK, ...blank] });
    expect(r.code).toBe(0);
    expect(r.out).toContain('dry-run complete: nothing changed');
  });

  // Telemetry is on or off as a whole (design D32b): COMPOSE_PROFILES=telemetry starts Alloy, HEXLANDS_TELEMETRY=otlp
  // makes the server export to it.
  const GRAFANA = [
    'GRAFANA_MIMIR_URL=https://prometheus.example/api/prom/push',
    'GRAFANA_MIMIR_USER=1',
    'GRAFANA_LOKI_URL=https://logs.example/loki/api/v1/push',
    'GRAFANA_LOKI_USER=2',
    'GRAFANA_TEMPO_ENDPOINT=tempo.example:443',
    'GRAFANA_TEMPO_USER=3',
    'GRAFANA_CLOUD_TOKEN=glc_example',
  ];
  const ON = ['COMPOSE_PROFILES=telemetry', 'HEXLANDS_TELEMETRY=otlp'];

  it('without Grafana and without the profile, telemetry is off and the dry run passes', () => {
    const r = dryRun({});
    expect(r.code).toBe(0);
    expect(r.out).toContain('telemetry: off (no alloy; the server writes JSON log lines to stdout only)');
  });

  it.each([
    ['the profile without otlp', ['COMPOSE_PROFILES=telemetry'], 'COMPOSE_PROFILES includes telemetry (starts Alloy) but HEXLANDS_TELEMETRY is off'],
    ['otlp without the profile', ['HEXLANDS_TELEMETRY=otlp'], 'HEXLANDS_TELEMETRY=otlp exports to Alloy, which runs only with COMPOSE_PROFILES=telemetry'],
    ['Grafana configured but telemetry off', GRAFANA, 'Grafana Cloud is configured in deploy/.env but telemetry is off'],
  ])('%s refuses (exit 1) before any docker call', (_label, extra, message) => {
    const r = dryRun({ running: true, env: [...ENV_OK, ...extra] });
    expect(r.code).toBe(1);
    expect(r.out).toContain(message);
    expect(r.calls).toEqual([]);
  });

  it.each([
    ['Grafana configured', [...GRAFANA, ...ON], {}],
    ['no Grafana (Alloy idles, as in the local rehearsal)', ON, {}],
    ['the profile exported in the shell', ['HEXLANDS_TELEMETRY=otlp'], { COMPOSE_PROFILES: 'telemetry' }],
  ])('telemetry on with %s passes', (_label, extra, shellEnv) => {
    const r = dryRun({ env: [...ENV_OK, ...extra], shellEnv });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('telemetry: on (alloy runs; the server exports OTLP to it)');
  });

  // deploy.sh reads .env values as docker compose does: one matching pair of quotes (double or single) is removed.
  it.each([
    ['a double-quoted profile alone', ['COMPOSE_PROFILES="telemetry"'], 1, 'COMPOSE_PROFILES includes telemetry (starts Alloy) but HEXLANDS_TELEMETRY is off'],
    ['a single-quoted profile alone', ["COMPOSE_PROFILES='telemetry'"], 1, 'COMPOSE_PROFILES includes telemetry (starts Alloy) but HEXLANDS_TELEMETRY is off'],
    ['a quoted profile and a quoted otlp', ['COMPOSE_PROFILES="telemetry"', "HEXLANDS_TELEMETRY='otlp'"], 0, 'telemetry: on (alloy runs; the server exports OTLP to it)'],
    ['a quoted otlp alone', ['HEXLANDS_TELEMETRY="otlp"'], 1, 'HEXLANDS_TELEMETRY=otlp exports to Alloy, which runs only with COMPOSE_PROFILES=telemetry'],
  ])('quoted values are read as compose reads them: %s', (_label, extra, code, message) => {
    const r = dryRun({ env: [...ENV_OK, ...extra] });
    expect(r.code, r.out).toBe(code);
    expect(r.out).toContain(message);
  });

  it('a HEXLANDS_TELEMETRY other than off or otlp refuses', () => {
    const r = dryRun({ running: true, env: [...ENV_OK, 'HEXLANDS_TELEMETRY=memory'] });
    expect(r.code).toBe(1);
    expect(r.out).toContain('HEXLANDS_TELEMETRY must be off or otlp, not memory');
    expect(r.calls).toEqual([]);
  });

  it.each([
    ['double-quoted', 'GRAFANA_URL="<https://<stack>.grafana.net>"'],
    ['single-quoted', "SM_API_URL='<https://synthetic-monitoring-api-….grafana.net>'"],
    ['followed by spaces', 'GRAFANA_LOKI_URL=<https://logs-…grafana.net/loki/api/v1/push>   '],
  ])('a %s placeholder is refused too', (_label, line) => {
    const r = dryRun({ env: [...ENV_OK, line] });
    expect(r.code).toBe(1);
    expect(r.out).toContain(`placeholder for: ${line.slice(0, line.indexOf('='))} (blank each one`);
  });

  it('never prints a secret from .env', () => {
    const r = dryRun({ env: [...ENV_OK, 'HEXLANDS_ROOMS_CREATE_PASSPHRASE=sesame-SECRET-pass', 'GRAFANA_SA_TOKEN=glsa_SECRET_token'] });
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('SECRET');
  });
});
