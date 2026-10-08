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

  it('never prints a secret from .env', () => {
    const r = dryRun({ env: [...ENV_OK, 'HEXLANDS_ROOMS_CREATE_PASSPHRASE=sesame-SECRET-pass', 'GRAFANA_SA_TOKEN=glsa_SECRET_token'] });
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('SECRET');
  });
});
