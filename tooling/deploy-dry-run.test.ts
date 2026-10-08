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

/**
 * Fake docker: logs its arguments; `compose ps -q` prints an id when FAKE_RUNNING=1; the healthz read prints FAKE_ACTIVE.
 * `compose config --services` prints FAKE_SERVICES and `compose config --format json` gives catan-server's
 * HEXLANDS_TELEMETRY as FAKE_TELEMETRY: what docker compose would resolve from the env file.
 */
const FAKE_DOCKER = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_LOG"
case "$*" in
  *" ps -q "*) [ "$FAKE_RUNNING" = 1 ] && echo 0123456789ab ;;
  *"games.active"*) echo "$FAKE_ACTIVE" ;;
  *" config --services"*) printf '%s\\n' $FAKE_SERVICES ;;
  *" config --format json"*) printf '{\\n  "services": {\\n    "catan-server": {\\n      "environment": {\\n        "HEXLANDS_TELEMETRY": "%s"\\n      }\\n    }\\n  }\\n}\\n' "$FAKE_TELEMETRY" ;;
esac
exit 0
`;

interface DryRunOptions {
  args?: string[];
  env?: string[];
  running?: boolean;
  active?: number;
  dry?: boolean;
  shellEnv?: Record<string, string>;
  /** Services the fake `compose config --services` lists (default: no alloy, telemetry off). */
  services?: string[];
  /** catan-server's HEXLANDS_TELEMETRY in the fake `compose config` (default off). */
  telemetry?: string;
  /** Use the real docker CLI (and a copy of docker-compose.yml) instead of the fake. */
  realDocker?: boolean;
}

function dryRun(opts: DryRunOptions) {
  const dir = mkdtempSync(path.join(tmpdir(), 'hexlands-dry-run-'));
  dirs.push(dir);
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  copyFileSync(DEPLOY_SH, path.join(dir, 'deploy.sh'));
  writeFileSync(path.join(dir, '.env'), `${(opts.env ?? ENV_OK).join('\n')}\n`);
  if (opts.realDocker) copyFileSync(path.join(path.dirname(DEPLOY_SH), 'docker-compose.yml'), path.join(dir, 'docker-compose.yml'));
  else writeFileSync(path.join(bin, 'docker'), FAKE_DOCKER);
  writeFileSync(path.join(bin, 'git'), '#!/usr/bin/env bash\necho abc123def456\n');
  writeFileSync(path.join(bin, 'curl'), '#!/usr/bin/env bash\necho "curl $*" >> "$FAKE_LOG"\n');
  for (const f of opts.realDocker ? ['git', 'curl'] : ['docker', 'git', 'curl']) chmodSync(path.join(bin, f), 0o755);
  const log = path.join(dir, 'calls.log');
  writeFileSync(log, '');
  const r = spawnSync('bash', [path.join(dir, 'deploy.sh'), ...(opts.dry === false ? [] : ['--dry-run']), ...(opts.args ?? [])], {
    encoding: 'utf8',
    env: {
      ...(opts.realDocker ? { HOME: process.env['HOME'] ?? '' } : {}),
      ...opts.shellEnv,
      PATH: `${bin}:${process.env['PATH'] ?? ''}`,
      FAKE_LOG: log,
      FAKE_RUNNING: opts.running ? '1' : '0',
      FAKE_ACTIVE: String(opts.active ?? 0),
      FAKE_SERVICES: (opts.services ?? ['caddy', 'catan-server']).join(' '),
      FAKE_TELEMETRY: opts.telemetry ?? 'off',
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
    expect(r.calls.every((c) => / ps -q | config /.test(` ${c} `))).toBe(true);
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

  // Telemetry is on or off as a whole (design D32b): the `telemetry` profile starts Alloy, HEXLANDS_TELEMETRY=otlp makes
  // the server export to it.
  const GRAFANA = [
    'GRAFANA_MIMIR_URL=https://prometheus.example/api/prom/push',
    'GRAFANA_MIMIR_USER=1',
    'GRAFANA_LOKI_URL=https://logs.example/loki/api/v1/push',
    'GRAFANA_LOKI_USER=2',
    'GRAFANA_TEMPO_ENDPOINT=tempo.example:443',
    'GRAFANA_TEMPO_USER=3',
    'GRAFANA_CLOUD_TOKEN=glc_example',
  ];
  // The mode comes from docker compose itself (`config --services` and catan-server's resolved environment); the fake
  // docker answers with `services` and `telemetry`, which is what compose would resolve from the env file.
  const OFF = { services: ['caddy', 'catan-server'], telemetry: 'off' };
  const ON = { services: ['alloy', 'caddy', 'catan-server'], telemetry: 'otlp' };

  it('without Grafana and without the profile, telemetry is off and the dry run passes', () => {
    const r = dryRun({ ...OFF });
    expect(r.code).toBe(0);
    expect(r.out).toContain('telemetry: off (no alloy; the server writes JSON log lines to stdout only)');
    expect(r.calls.filter((c) => / config /.test(` ${c} `))).toEqual([
      'compose --env-file .env -f docker-compose.yml config --services',
      'compose --env-file .env -f docker-compose.yml config --format json',
    ]);
  });

  it.each([
    ['the profile without otlp', {}, { services: ON.services, telemetry: 'off' }, 'the telemetry profile is active (Alloy starts) but HEXLANDS_TELEMETRY is off'],
    ['otlp without the profile', {}, { services: OFF.services, telemetry: 'otlp' }, 'HEXLANDS_TELEMETRY=otlp exports to Alloy, which runs only with COMPOSE_PROFILES=telemetry'],
    ['Grafana configured but telemetry off', { env: [...ENV_OK, ...GRAFANA] }, OFF, 'Grafana Cloud is configured in deploy/.env but telemetry is off'],
    ['a HEXLANDS_TELEMETRY other than off or otlp', {}, { services: OFF.services, telemetry: 'memory' }, "catan-server's HEXLANDS_TELEMETRY must be off or otlp, not memory"],
  ])('%s refuses (exit 1) with nothing changed', (_label, base, resolved, message) => {
    const r = dryRun({ running: true, ...base, ...resolved });
    expect(r.code).toBe(1);
    expect(r.out).toContain(message);
    expect(mutating(r.calls)).toEqual([]);
  });

  it.each([
    ['Grafana configured', { env: [...ENV_OK, ...GRAFANA] }],
    ['no Grafana (Alloy idles, as in the local rehearsal)', {}],
  ])('telemetry on with %s passes', (_label, base) => {
    const r = dryRun({ ...base, ...ON });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('telemetry: on (alloy runs; the server exports OTLP to it)');
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

const hasCompose = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0;

// deploy.sh's verdict against what docker compose itself resolves from the env file, for every .env spelling compose
// accepts (bug cb2adb7b): quotes, inline comments, a space after `=`, an `export` prefix.
describe.skipIf(!hasCompose)('deploy.sh --dry-run with the real docker compose: the telemetry mode matches compose', () => {
  const PROFILE = (s: string) => s.replace('KEY', 'COMPOSE_PROFILES').replace('VALUE', 'telemetry');
  const OTLP = (s: string) => s.replace('KEY', 'HEXLANDS_TELEMETRY').replace('VALUE', 'otlp');
  const FORMS = ['KEY=VALUE', 'KEY="VALUE"', "KEY='VALUE'", 'KEY=VALUE # note', 'KEY= VALUE', 'export KEY=VALUE', 'KEY="VALUE" # c'];

  /** What compose resolves for these env lines: is alloy a service, and catan-server's HEXLANDS_TELEMETRY. */
  function resolved(lines: string[]) {
    const dir = mkdtempSync(path.join(tmpdir(), 'hexlands-compose-mode-'));
    dirs.push(dir);
    writeFileSync(path.join(dir, '.env'), `${[...ENV_OK, ...lines].join('\n')}\n`);
    const env: NodeJS.ProcessEnv = { ...process.env, HEXLANDS_BUILD_VERSION: 'abc123def456' };
    delete env['COMPOSE_PROFILES'];
    delete env['HEXLANDS_TELEMETRY'];
    const args = ['compose', '--env-file', path.join(dir, '.env'), '-f', path.join(path.dirname(DEPLOY_SH), 'docker-compose.yml'), 'config'];
    const services = spawnSync('docker', [...args, '--services'], { encoding: 'utf8', env }).stdout.split('\n');
    const config = JSON.parse(spawnSync('docker', [...args, '--format', 'json'], { encoding: 'utf8', env }).stdout) as {
      services: Record<string, { environment: Record<string, string> }>;
    };
    return { alloy: services.includes('alloy'), telemetry: config.services['catan-server']!.environment['HEXLANDS_TELEMETRY'] };
  }

  it.each(FORMS)('the profile alone, written %s: compose starts Alloy with the server off, and deploy.sh refuses', (form) => {
    expect(resolved([PROFILE(form)])).toEqual({ alloy: true, telemetry: 'off' });
    const r = dryRun({ realDocker: true, env: [...ENV_OK, PROFILE(form)] });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain('the telemetry profile is active (Alloy starts) but HEXLANDS_TELEMETRY is off');
  });

  it.each(FORMS)('otlp alone, written %s: compose gives the server otlp without Alloy, and deploy.sh refuses', (form) => {
    expect(resolved([OTLP(form)])).toEqual({ alloy: false, telemetry: 'otlp' });
    const r = dryRun({ realDocker: true, env: [...ENV_OK, OTLP(form)] });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain('HEXLANDS_TELEMETRY=otlp exports to Alloy, which runs only with COMPOSE_PROFILES=telemetry');
  });

  it.each(FORMS)('both, written %s: telemetry on', (form) => {
    expect(resolved([PROFILE(form), OTLP(form)])).toEqual({ alloy: true, telemetry: 'otlp' });
    const r = dryRun({ realDocker: true, env: [...ENV_OK, PROFILE(form), OTLP(form)] });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('telemetry: on (alloy runs; the server exports OTLP to it)');
  });

  it('neither: telemetry off', () => {
    expect(resolved([])).toEqual({ alloy: false, telemetry: 'off' });
    const r = dryRun({ realDocker: true });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('telemetry: off (no alloy; the server writes JSON log lines to stdout only)');
  });

  it('the profile exported in the shell counts, as it does for compose', () => {
    const r = dryRun({ realDocker: true, env: [...ENV_OK, 'HEXLANDS_TELEMETRY=otlp'], shellEnv: { COMPOSE_PROFILES: 'telemetry' } });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('telemetry: on (alloy runs; the server exports OTLP to it)');
  });
});
