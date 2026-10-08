// E-INT determinism (verification plan V10; AC19): whole games — seeded walker playouts that reach gameOver — replay to
// the same stateHash after every command in a fresh Node process, and ENGINE_VERSION is set. The child runs the engine
// sources directly under Node's type stripping, outside vitest.
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { ENGINE_VERSION, replay } from '../packages/engine/src/index';
import { playout } from '../packages/engine/src/__integration__/walk';

const CHILD = `
import { replay } from './packages/engine/src/replay.ts';
let input = '';
process.stdin.on('data', (d) => (input += d)).on('end', () => {
  const games = JSON.parse(input);
  process.stdout.write(JSON.stringify(games.map(({ init, commands }) => replay(init, commands).hashes)));
});`;

describe('E-INT determinism across processes', () => {
  it('ENGINE_VERSION is a semver string', () => {
    expect(ENGINE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('full walker games (3 and 4 players, to gameOver) replay to identical hashes in a fresh process', () => {
    const games = [2, 3, 6, 7]
      .map((seed) => playout({ seed, playerCount: seed % 2 === 0 ? 4 : 3, maxSteps: 2000, greed: 0.8 }))
      .filter((g) => g.final.phase.name === 'gameOver')
      .slice(0, 2)
      .map((g) => ({ init: g.init, commands: g.commands }));
    expect(games).toHaveLength(2);
    const child = spawnSync(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', '--import', './tooling/ts-resolve-hook.mjs', '--input-type=module', '-e', CHILD],
      { input: JSON.stringify(games), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    expect(child.stderr).toBe('');
    expect(child.status).toBe(0);
    const here = games.map(({ init, commands }) => replay(init, commands));
    for (const r of here) expect(r.results.every((x) => x.ok)).toBe(true);
    expect(JSON.parse(child.stdout)).toEqual(here.map((r) => r.hashes));
  }, 120_000);
});
