import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { DEFAULT_GAME_CONFIG, replay, type Command, type GameInit } from '../packages/engine/src/index';

// replay(init, commands) must give the same hashes[i] in an independent process (design §3.4, AC19, V10/V15). The child
// runs the engine sources directly under Node's type stripping, outside vitest.
const INIT: GameInit = { config: DEFAULT_GAME_CONFIG.rules, playerCount: 4, seed: 'golden-board-1' };
const COMMANDS: readonly Command[] = [
  { by: 0, action: { type: 'placeSettlement', vertex: 'v:0,0,N' } },
  { by: 0, action: { type: 'placeRoad', edge: 'e:0,0,NE' } },
  { by: 1, action: { type: 'rollDice' } },
  { by: 'system', action: { type: 'skipSeat', seat: 0, reason: 'host' } },
];

const CHILD = `
import { replay } from './packages/engine/src/replay.ts';
let input = '';
process.stdin.on('data', (d) => (input += d)).on('end', () => {
  const { init, commands } = JSON.parse(input);
  process.stdout.write(JSON.stringify(replay(init, commands).hashes));
});`;

describe('replay across processes', () => {
  it('a fresh Node process computes identical hashes[i]', () => {
    const child = spawnSync(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', '--import', './tooling/ts-resolve-hook.mjs', '--input-type=module', '-e', CHILD],
      { input: JSON.stringify({ init: INIT, commands: COMMANDS }), encoding: 'utf8' },
    );
    expect(child.stderr).toBe('');
    expect(child.status).toBe(0);
    const hashes = replay(INIT, COMMANDS).hashes;
    expect(hashes).toHaveLength(COMMANDS.length);
    expect(JSON.parse(child.stdout)).toEqual(hashes);
  });
});
