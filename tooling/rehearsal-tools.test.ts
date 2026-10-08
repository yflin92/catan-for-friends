// Bug d99ce60b: the rehearsal helpers on a host with a Q9 passphrase.
// - deploy/validate/rehearse-games.ts creates rooms the way the load runner does, sending
//   HEXLANDS_ROOMS_CREATE_PASSPHRASE when set, and never prints it. Run as a child process against a real in-process
//   server (execFile, not spawnSync, so the server keeps serving).
// - deploy/restore.sh resolves its backup path before changing into deploy/, so a repo-relative, deploy/-relative or
//   absolute path all work. Hermetic: a copy of the script runs with a fake `docker` that logs its calls.
import { execFile, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { startServer } from '../apps/server/src/server';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
const tempDir = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

describe('rehearse-games.ts and the Q9 create passphrase (bug d99ce60b)', () => {
  const SENTINEL = `SENTINEL-${Math.random().toString(36).slice(2)}-pass`;

  async function server(createPassphrase: string | null) {
    const dir = tempDir('hexlands-rehearse-games-');
    const logs: string[] = [];
    const s = await startServer({
      port: 0,
      dbPath: path.join(dir, 'db'),
      telemetry: 'memory',
      buildVersion: 'v-rehearse',
      config: { rooms: { createPassphrase } },
      logLine: (line) => logs.push(line),
    });
    cleanups.push(() => s.close());
    return { url: `http://127.0.0.1:${s.port}`, logs, dir };
  }

  /** One game set up and left active (`--finished 0`), so the run ends as soon as the room is created and started. */
  function rehearse(url: string, dir: string, passphrase: string | undefined) {
    const env = { ...process.env };
    delete env['HEXLANDS_ROOMS_CREATE_PASSPHRASE'];
    if (passphrase !== undefined) env['HEXLANDS_ROOMS_CREATE_PASSPHRASE'] = passphrase;
    const out = path.join(dir, 'games.json');
    const secrets = path.join(dir, 'secrets.json');
    return new Promise<{ code: number | null; output: string; out: string; secrets: string }>((resolve) => {
      const child = execFile(
        process.execPath,
        [
          '--experimental-strip-types',
          '--no-warnings',
          '--import',
          path.join(ROOT, 'tooling/ts-resolve-hook.mjs'),
          path.join(ROOT, 'deploy/validate/rehearse-games.ts'),
          ...['--url', url, '--games', '1', '--finished', '0', '--max-minutes', '0', '--out', out, '--secrets', secrets],
        ],
        { encoding: 'utf8', cwd: ROOT, env },
        (_error, stdout, stderr) => {
          const read = (f: string) => {
            try {
              return readFileSync(f, 'utf8');
            } catch {
              return '';
            }
          };
          resolve({ code: child.exitCode, output: `${stdout}${stderr}`, out: read(out), secrets: read(secrets) });
        },
      );
    });
  }

  const created = (logs: string[]) => logs.filter((l) => l.includes('"event":"game.created"')).length;
  const rejected = (logs: string[]) => logs.filter((l) => l.includes('"event":"room.create_rejected"'));

  it('with a passphrase on the server and in the environment: the room is created and started, and the passphrase is never printed', async () => {
    const s = await server(SENTINEL);
    const r = await rehearse(s.url, s.dir, SENTINEL);
    expect(r.code, r.output).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ games: 1, active: 1 });
    expect(created(s.logs)).toBe(1);
    expect(rejected(s.logs)).toEqual([]);
    // stdout, stderr, the summary and the 0600 secrets file (room codes and seat tokens only) never hold the passphrase.
    for (const text of [r.output, r.out, r.secrets]) expect(text).not.toContain(SENTINEL);
    expect(JSON.parse(r.secrets)).toMatchObject({ roomCodes: [expect.any(String)] });
  }, 60_000);

  it('without a passphrase on either side: creation works as before (open creation)', async () => {
    const s = await server(null);
    const r = await rehearse(s.url, s.dir, undefined);
    expect(r.code, r.output).toBe(0);
    expect(created(s.logs)).toBe(1);
  }, 60_000);

  it('a create without the passphrase (the bug) is refused with 403 bad_passphrase and fails the run', async () => {
    const s = await server(SENTINEL);
    const r = await rehearse(s.url, s.dir, undefined);
    expect(r.code).toBe(1);
    expect(r.output).toContain('POST /api/rooms → 403');
    expect(r.output).toContain('bad_passphrase');
    expect(created(s.logs)).toBe(0);
    expect(r.output).not.toContain(SENTINEL);
  }, 60_000);

  it('a wrong passphrase is refused and never printed', async () => {
    const s = await server(SENTINEL);
    const wrong = `${SENTINEL}-wrong`;
    const r = await rehearse(s.url, s.dir, wrong);
    expect(r.code).toBe(1);
    expect(r.output).toContain('POST /api/rooms → 403');
    expect(r.output).not.toContain(SENTINEL);
    expect(created(s.logs)).toBe(0);
  }, 60_000);
});

describe('restore.sh resolves the backup path before changing into deploy/ (bug d99ce60b)', () => {
  /** Fake docker: logs its arguments; `docker exec … printenv` prints a SHA. */
  const FAKE_DOCKER = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_LOG"
case "$*" in *printenv*) echo abc123def456 ;; esac
exit 0
`;

  /** A repo-shaped temp tree: <repo>/deploy/{restore.sh,.env,backups/<name>}, with fake docker on PATH. */
  function layout() {
    const repo = tempDir('hexlands-restore-');
    const deploy = path.join(repo, 'deploy');
    mkdirSync(path.join(deploy, 'backups'), { recursive: true });
    copyFileSync(path.join(ROOT, 'deploy/restore.sh'), path.join(deploy, 'restore.sh'));
    writeFileSync(path.join(deploy, '.env'), 'HEXLANDS_SITE_ADDRESS=http://localhost\n');
    const name = 'hexlands-20261008T120000Z.db';
    writeFileSync(path.join(deploy, 'backups', name), 'db');
    const bin = path.join(repo, 'bin');
    mkdirSync(bin);
    writeFileSync(path.join(bin, 'docker'), FAKE_DOCKER);
    chmodSync(path.join(bin, 'docker'), 0o755);
    const log = path.join(repo, 'calls.log');
    writeFileSync(log, '');
    const restore = (cwd: string, arg: string) => {
      const r = spawnSync('bash', [path.relative(cwd, path.join(deploy, 'restore.sh')) || 'restore.sh', arg], {
        cwd,
        encoding: 'utf8',
        env: { PATH: `${bin}:${process.env['PATH'] ?? ''}`, FAKE_LOG: log },
      });
      const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
      writeFileSync(log, '');
      return { code: r.status, out: `${r.stdout}${r.stderr}`, calls };
    };
    return { repo, deploy, name, restore };
  }

  /** The copy step mounts the backup's directory at /restore and copies the file by name. */
  const mountsBackup = (calls: string[], dir: string, name: string) =>
    calls.some((c) => c.includes(` -v ${dir}:/restore:ro `) && c.includes(`cp '/restore/${name}' /data/hexlands.db`));

  it.each([
    ['repo-relative from the repository root (the documented form)', (l: ReturnType<typeof layout>) => ({ cwd: l.repo, arg: `deploy/backups/${l.name}` })],
    ['deploy/-relative from the repository root', (l: ReturnType<typeof layout>) => ({ cwd: l.repo, arg: `backups/${l.name}` })],
    ['relative from inside deploy/', (l: ReturnType<typeof layout>) => ({ cwd: l.deploy, arg: `backups/${l.name}` })],
    ['absolute from anywhere', (l: ReturnType<typeof layout>) => ({ cwd: tmpdir(), arg: path.join(l.deploy, 'backups', l.name) })],
  ])('%s: stops, copies that file, starts', (_label, pick) => {
    const l = layout();
    const { cwd, arg } = pick(l);
    const r = l.restore(cwd, arg);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`[restore] restored ${l.name}`);
    expect(mountsBackup(r.calls, path.join(l.deploy, 'backups'), l.name), r.calls.join('\n')).toBe(true);
    expect(r.calls.some((c) => /compose .* stop catan-server$/.test(c))).toBe(true);
    expect(r.calls.some((c) => /compose .* start catan-server$/.test(c))).toBe(true);
  });

  it('a file that exists nowhere is refused before any docker call', () => {
    const l = layout();
    const r = l.restore(l.repo, 'deploy/backups/missing.db');
    expect(r.code).toBe(1);
    expect(r.out).toContain('[restore] no such file');
    expect(r.calls).toEqual([]);
  });
});
