// deploy/docker-compose.yml with and without the `telemetry` profile (design D32/D32a/D32b): without it the stack is
// catan-server + caddy with HEXLANDS_TELEMETRY=off; with COMPOSE_PROFILES=telemetry and HEXLANDS_TELEMETRY=otlp in the env
// file, Alloy joins and the server exports to it. The file checks always run; `docker compose config` runs when a
// Docker CLI with Compose is installed (as on the CI runners) and is skipped otherwise.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const DEPLOY = path.join(path.dirname(fileURLToPath(import.meta.url)), '../deploy');
const COMPOSE = readFileSync(path.join(DEPLOY, 'docker-compose.yml'), 'utf8');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The text of one top-level service block of the compose file. */
function service(name: string): string {
  const start = COMPOSE.indexOf(`\n  ${name}:\n`);
  expect(start, name).toBeGreaterThan(-1);
  const rest = COMPOSE.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n|\n[a-z]/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe('compose file: the telemetry profile and memory limits', () => {
  it('alloy is in the telemetry profile, capped at 256m, with usage reporting disabled', () => {
    const alloy = service('alloy');
    expect(alloy).toMatch(/\n {4}profiles: \[telemetry\]\n/);
    expect(alloy).toMatch(/\n {4}mem_limit: 256m\n/);
    expect(alloy).toContain('--disable-reporting');
  });

  it('caddy is capped at 128m and catan-server has no memory limit', () => {
    expect(service('caddy')).toMatch(/\n {4}mem_limit: 128m\n/);
    expect(service('catan-server')).not.toMatch(/mem_limit|mem_reservation|memory:/);
  });

  it("catan-server's dependency on alloy is not required, and its telemetry defaults to off", () => {
    const server = service('catan-server');
    expect(server).toMatch(/\n {6}alloy: \{ condition: service_started, required: false \}\n/);
    expect(server).toContain('HEXLANDS_TELEMETRY: ${HEXLANDS_TELEMETRY:-off}');
  });
});

const hasCompose = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0;

describe.skipIf(!hasCompose)('docker compose config in both modes', () => {
  function config(envLines: string[]) {
    const dir = mkdtempSync(path.join(tmpdir(), 'hexlands-compose-'));
    dirs.push(dir);
    const envFile = path.join(dir, '.env');
    writeFileSync(envFile, `${['HEXLANDS_SITE_ADDRESS=play.example.org', ...envLines].join('\n')}\n`);
    const env: NodeJS.ProcessEnv = { ...process.env, HEXLANDS_BUILD_VERSION: 'abc123def456' };
    delete env['COMPOSE_PROFILES'];
    delete env['HEXLANDS_TELEMETRY'];
    const r = spawnSync('docker', ['compose', '--env-file', envFile, '-f', path.join(DEPLOY, 'docker-compose.yml'), 'config', '--format', 'json'], {
      encoding: 'utf8',
      env,
    });
    expect(r.status, r.stderr).toBe(0);
    return JSON.parse(r.stdout) as { services: Record<string, { environment?: Record<string, string>; mem_limit?: string }> };
  }

  it('without the profile: catan-server and caddy only, telemetry off', () => {
    const c = config([]);
    expect(Object.keys(c.services).sort()).toEqual(['caddy', 'catan-server']);
    expect(c.services['catan-server']!.environment!['HEXLANDS_TELEMETRY']).toBe('off');
  });

  it('with COMPOSE_PROFILES=telemetry and HEXLANDS_TELEMETRY=otlp: alloy joins and the server exports', () => {
    const c = config(['COMPOSE_PROFILES=telemetry', 'HEXLANDS_TELEMETRY=otlp']);
    expect(Object.keys(c.services).sort()).toEqual(['alloy', 'caddy', 'catan-server']);
    expect(c.services['catan-server']!.environment!['HEXLANDS_TELEMETRY']).toBe('otlp');
    expect(c.services['alloy']!.mem_limit).toBe(String(256 * 1024 * 1024));
  });
});
