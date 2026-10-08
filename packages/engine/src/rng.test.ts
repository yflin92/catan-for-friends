import { describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import {
  RNG_STREAMS,
  drawDie,
  drawInt,
  initRng,
  seedStream,
  sfc32Next,
  shuffle,
  type RngStream,
  type RngStreamState,
  type Sfc32,
} from './rng';

/** An independent textbook sfc32 (closure form) used as the reference implementation. */
function referenceSfc32(a: number, b: number, c: number, d: number): () => number {
  return () => {
    a |= 0; b |= 0; c |= 0; d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return t >>> 0;
  };
}

function drawMany(st: RngStreamState, n: number, count: number): { values: number[]; state: RngStreamState } {
  const values: number[] = [];
  let state = st;
  for (let i = 0; i < count; i++) {
    const [v, next] = drawInt(state, n);
    values.push(v);
    state = next;
  }
  return { values, state };
}

/** Pearson chi-square statistic against a uniform distribution over `buckets`. */
function chiSquare(values: readonly number[], buckets: number): number {
  const counts = new Array<number>(buckets).fill(0);
  for (const v of values) counts[v] = (counts[v] ?? 0) + 1;
  const expected = values.length / buckets;
  return counts.reduce((acc, c) => acc + (c - expected) ** 2 / expected, 0);
}

const then: Sfc32 = [11, 22, 33, 44];

const sfc32 = (st: RngStreamState): Sfc32 => {
  if (st.algo !== 'sfc32') throw new Error('expected an sfc32 stream');
  return st.s;
};

describe('seeding (design §3.5)', () => {
  it('uses the first 16 bytes of SHA-256(`${seed}/${stream}`) as four little-endian uint32 words', () => {
    const d = sha256(utf8ToBytes('abc/dice'));
    const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
    const expected = [0, 4, 8, 12].map((o) => view.getUint32(o, true));
    expect(seedStream('abc', 'dice')).toEqual({ algo: 'sfc32', s: expected });
  });

  it('matches the golden state for a fixed seed', () => {
    expect(seedStream('seed-1', 'board')).toMatchInlineSnapshot(`
      {
        "algo": "sfc32",
        "s": [
          1302304411,
          3709020174,
          3859694483,
          1223386414,
        ],
      }
    `);
  });

  it('gives every stream its own state, and a per-stream override replaces only that stream', () => {
    const base = initRng('seed-1');
    const states = RNG_STREAMS.map((s) => JSON.stringify(base[s]));
    expect(new Set(states).size).toBe(5);

    const overridden = initRng('seed-1', { steal: 'other' });
    for (const s of RNG_STREAMS) {
      if (s === 'steal') expect(overridden[s]).toEqual(seedStream('other', 'steal'));
      else expect(overridden[s]).toEqual(base[s]);
    }
  });

  it('stores only uint32 integers in the state', () => {
    for (const s of RNG_STREAMS) {
      for (const w of sfc32(initRng('x')[s])) {
        expect(Number.isInteger(w) && w >= 0 && w < 2 ** 32).toBe(true);
      }
    }
  });
});

describe('sfc32', () => {
  it('produces the same sequence as the reference implementation', () => {
    const start: Sfc32 = [0x9e3779b9, 0x243f6a88, 0xb7e15162, 1];
    const ref = referenceSfc32(...start);
    let s = start;
    for (let i = 0; i < 1000; i++) {
      const [v, next] = sfc32Next(s);
      expect(v).toBe(ref());
      s = next;
    }
  });

  it('is pure: the input state is not mutated', () => {
    const start = Object.freeze([1, 2, 3, 4] as const);
    const [, next] = sfc32Next(start);
    expect(start).toEqual([1, 2, 3, 4]);
    expect(next).not.toBe(start);
  });
});

describe('drawInt', () => {
  it('is reproducible from the seed', () => {
    const a = drawMany(seedStream('repro', 'dice'), 1000, 200);
    const b = drawMany(seedStream('repro', 'dice'), 1000, 200);
    expect(a.values).toEqual(b.values);
    expect(a.state).toEqual(b.state);
  });

  it.each([1, 2, 6, 19, 25, 1000, 2 ** 31 + 1, 2 ** 32])('stays within [0, %d)', (n) => {
    const { values } = drawMany(seedStream('range', 'steal'), n, 500);
    for (const v of values) expect(v >= 0 && v < n && Number.isInteger(v)).toBe(true);
  });

  it('is uniform for small bounds (chi-square, 60 000 draws over 6 buckets)', () => {
    const { values } = drawMany(seedStream('uniform', 'dice'), 6, 60_000);
    // Critical value for 5 degrees of freedom at p = 0.001 is 20.52.
    expect(chiSquare(values, 6)).toBeLessThan(20.52);
  });

  it('rejects the biased tail for large bounds', () => {
    // n = 3·2^30: plain modulo would land in the first third twice as often as in each other third.
    const n = 3 * 2 ** 30;
    const { values } = drawMany(seedStream('bias', 'absence'), n, 30_000);
    const thirds = values.map((v) => Math.floor(v / 2 ** 30));
    expect(chiSquare(thirds, 3)).toBeLessThan(13.82); // 2 degrees of freedom, p = 0.001
  });

  it.each([0, -1, 1.5, 2 ** 32 + 1, Number.NaN])('throws on an invalid bound %s', (n) => {
    expect(() => drawInt(seedStream('x', 'dice'), n)).toThrow(RangeError);
  });

  it('does not mutate the input state', () => {
    const st = seedStream('pure', 'dice');
    const copy = JSON.parse(JSON.stringify(st)) as RngStreamState;
    drawInt(Object.freeze(st), 6);
    expect(st).toEqual(copy);
  });
});

describe('stream independence', () => {
  it('drawing from one stream never shifts another', () => {
    const rng = initRng('independent');
    const diceAlone = drawMany(rng.dice, 6, 50).values;

    let steal = rng.steal;
    for (let i = 0; i < 100; i++) [, steal] = drawInt(steal, 7);
    const after: Record<RngStream, RngStreamState> = { ...rng, steal };

    expect(after.dice).toBe(rng.dice);
    expect(drawMany(after.dice, 6, 50).values).toEqual(diceAlone);
  });
});

describe('scripted streams (TH2)', () => {
  it('yields the scripted values verbatim, then continues as sfc32 from `then`', () => {
    const scripted: RngStreamState = { algo: 'scripted', values: [4, 0, 2], then };
    const { values, state } = drawMany(scripted, 5, 6);
    const fresh = drawMany({ algo: 'sfc32', s: then }, 5, 3);
    expect(values).toEqual([4, 0, 2, ...fresh.values]);
    expect(state).toEqual(fresh.state);
  });

  it('becomes a plain sfc32 stream as soon as the last value is consumed', () => {
    const [, next] = drawInt({ algo: 'scripted', values: [1], then }, 3);
    expect(next).toEqual({ algo: 'sfc32', s: then });
  });

  it('treats an empty script as sfc32 from `then`', () => {
    const [v, next] = drawInt({ algo: 'scripted', values: [], then }, 10);
    const [expected, expectedNext] = drawInt({ algo: 'sfc32', s: then }, 10);
    expect([v, next]).toEqual([expected, expectedNext]);
  });

  it.each([5, -1, 1.5])('throws when a scripted value %s is outside [0, n)', (bad) => {
    expect(() => drawInt({ algo: 'scripted', values: [bad], then }, 5)).toThrow(RangeError);
  });
});

describe('drawDie', () => {
  it('rolls faces 1..6 uniformly', () => {
    let st: RngStreamState = seedStream('dice', 'dice');
    const faces: number[] = [];
    for (let i = 0; i < 60_000; i++) {
      const [f, next] = drawDie(st);
      faces.push(f - 1);
      st = next;
    }
    expect(Math.min(...faces)).toBe(0);
    expect(Math.max(...faces)).toBe(5);
    expect(chiSquare(faces, 6)).toBeLessThan(20.52);
  });

  it('equals drawInt(6) + 1 on an sfc32 stream', () => {
    const st = seedStream('same', 'dice');
    const [face, a] = drawDie(st);
    const [idx, b] = drawInt(st, 6);
    expect(face).toBe(idx + 1);
    expect(a).toEqual(b);
  });

  it('yields scripted values as faces, then continues as sfc32', () => {
    let st: RngStreamState = { algo: 'scripted', values: [6, 1], then: [5, 6, 7, 8] };
    const out: number[] = [];
    for (let i = 0; i < 3; i++) {
      const [f, next] = drawDie(st);
      out.push(f);
      st = next;
    }
    expect(out.slice(0, 2)).toEqual([6, 1]);
    expect(out[2]).toBe(drawDie({ algo: 'sfc32', s: [5, 6, 7, 8] })[0]);
  });

  it.each([0, 7, 2.5])('throws on a scripted face %s', (bad) => {
    expect(() => drawDie({ algo: 'scripted', values: [bad], then })).toThrow(RangeError);
  });
});

describe('shuffle (Fisher–Yates)', () => {
  it('returns a permutation, is reproducible and leaves the input untouched', () => {
    const items = Object.freeze(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']);
    const [a, sa] = shuffle(seedStream('s', 'board'), items);
    const [b, sb] = shuffle(seedStream('s', 'board'), items);
    expect(a).toEqual(b);
    expect(sa).toEqual(sb);
    expect([...a].sort()).toEqual([...items]);
    expect(items).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']);
  });

  it('swaps i with j = drawInt(i + 1) for i from length−1 down to 1', () => {
    // j values for i = 3, 2, 1: swap(3,0) → d b c a; swap(2,2) → d b c a; swap(1,0) → b d c a.
    const [out] = shuffle({ algo: 'scripted', values: [0, 2, 0], then }, ['a', 'b', 'c', 'd']);
    expect(out).toEqual(['b', 'd', 'c', 'a']);
  });

  it('draws nothing for 0 or 1 items', () => {
    const st = seedStream('s', 'board');
    expect(shuffle(st, [])).toEqual([[], st]);
    expect(shuffle(st, ['x'])).toEqual([['x'], st]);
  });
});
