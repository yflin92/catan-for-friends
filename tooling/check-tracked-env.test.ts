import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(import.meta.dirname, 'check-tracked-env.sh');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A throwaway git repository with `files` tracked (force-added, as a stray `git add -f` would). */
function repo(files: readonly string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'hexlands-env-guard-'));
  dirs.push(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  for (const f of files) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), 'GRAFANA_CLOUD_TOKEN=dummy\n');
  }
  if (files.length > 0) execFileSync('git', ['add', '-f', ...files], { cwd: dir });
  return dir;
}

const run = (dir: string) => spawnSync('bash', [SCRIPT, dir], { encoding: 'utf8' });

describe('tracked env file guard (bug 02babd04)', () => {
  it.each([['deploy/.env'], ['.env'], ['apps/server/prod.env'], ['deploy/.env.local']])('fails when %s is tracked (seeded failure)', (file) => {
    const r = run(repo(['README.md', file]));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(file);
  });

  it('passes with only *.env.example templates tracked', () => {
    const r = run(repo(['deploy/.env.example', 'README.md']));
    expect(r.status).toBe(0);
  });

  it('passes on this repository', () => {
    expect(run(path.resolve(import.meta.dirname, '..')).status).toBe(0);
  });
});
