import { spawnSync } from 'node:child_process';
import { canonicalJson, serializeState, stateHash } from '../packages/engine/src/index';
import { describe, expect, it } from 'vitest';
import { fixtureState } from '../packages/engine/src/__fixtures__/state';

// stateHash must be reproducible by an independent process and SHA-256 implementation (TH3).
describe('stateHash across processes', () => {
  it('equals node:crypto SHA-256 of the serialized state computed in a child process', () => {
    const state = fixtureState();
    const child = spawnSync(
      process.execPath,
      ['-e', "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(require('node:crypto').createHash('sha256').update(s,'utf8').digest('hex')))"],
      { input: serializeState(state), encoding: 'utf8' },
    );
    expect(child.status).toBe(0);
    expect(child.stdout).toBe(stateHash(state));
  });

  it('serializes the same state identically after it crosses a process boundary', () => {
    const state = fixtureState();
    const child = spawnSync(
      process.execPath,
      ['-e', "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.stringify(JSON.parse(s))))"],
      { input: JSON.stringify(state), encoding: 'utf8' },
    );
    expect(child.status).toBe(0);
    expect(canonicalJson(JSON.parse(child.stdout))).toBe(serializeState(state));
  });
});
