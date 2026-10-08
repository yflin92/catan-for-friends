import { describe, expect, it } from 'vitest';
import { drawDie, drawInt } from '../rng';
import { forceDice, scriptRng } from './rng';
import { buildState } from './state';

describe('scriptRng / forceDice (TH2)', () => {
  it('queues raw values on one stream, then continues as the stream would have', () => {
    const s = buildState();
    const scripted = scriptRng(s, 'steal', [4, 0]);
    const [a, st1] = drawInt(scripted.rng.steal, 5);
    const [b, st2] = drawInt(st1, 5);
    expect([a, b]).toEqual([4, 0]);
    expect(st2).toEqual(s.rng.steal);
    expect(scripted.rng.dice).toBe(s.rng.dice);
  });

  it('appends to values already scripted', () => {
    const s = scriptRng(scriptRng(buildState(), 'absence', [1]), 'absence', [2]);
    expect(s.rng.absence).toMatchObject({ algo: 'scripted', values: [1, 2] });
  });

  it('forceDice queues each roll as two faces and never shifts other streams', () => {
    const s = buildState();
    const forced = forceDice(s, [[3, 4], [6, 6]]);
    let st = forced.rng.dice;
    const faces: number[] = [];
    for (let i = 0; i < 4; i++) {
      const [f, next] = drawDie(st);
      faces.push(f);
      st = next;
    }
    expect(faces).toEqual([3, 4, 6, 6]);
    expect(st).toEqual(s.rng.dice);
    for (const k of ['board', 'devDeck', 'steal', 'absence'] as const) expect(forced.rng[k]).toBe(s.rng[k]);
  });

  it('rejects faces outside 1..6', () => {
    expect(() => forceDice(buildState(), [[0, 3]])).toThrow(RangeError);
    expect(() => forceDice(buildState(), [[2, 7]])).toThrow(RangeError);
  });

  it('does not mutate its input', () => {
    const s = buildState();
    scriptRng(s, 'dice', [1]);
    expect(s.rng.dice.algo).toBe('sfc32');
  });
});
