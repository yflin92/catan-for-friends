// Named RNG streams (design §3.5, ADR-0003). All engine randomness flows through these five streams, whose state lives
// in GameState.rng. Streams are independent: drawing from one never shifts another. Every function here is pure and
// returns the advanced stream state alongside the drawn value.
//
//   board   → createGame only: terrain Fisher–Yates, then token placement, then the harbor-kind Fisher–Yates.
//   dice    → two d6 per roll, including auto-rolls from a skip.
//   devDeck → one Fisher–Yates shuffle of the 25 cards at createGame.
//   steal   → card index into the victim's hand, expanded in canonical resource order.
//   absence → random cards for auto-discards under a skip.

import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

export type RngStream = 'board' | 'dice' | 'devDeck' | 'steal' | 'absence';
export const RNG_STREAMS: readonly RngStream[] = Object.freeze(['board', 'dice', 'devDeck', 'steal', 'absence']);

/** sfc32 state: four uint32 words. */
export type Sfc32 = readonly [number, number, number, number];

/** A `scripted` stream yields `values` first (dice: faces 1–6; steal/absence: raw indices), then continues as sfc32
 *  from `then`. Only @hexlands/engine/testing constructs scripted streams. */
export type RngStreamState =
  | { readonly algo: 'sfc32'; readonly s: Sfc32 }
  | { readonly algo: 'scripted'; readonly values: readonly number[]; readonly then: Sfc32 };

const UINT32 = 0x1_0000_0000;

/** Seeds one stream: the first 16 bytes of SHA-256(utf8(`${seed}/${stream}`)) as four little-endian uint32 words. No
 *  warm-up rounds are run; the SHA-256 output is used directly as the sfc32 state. */
export function seedStream(seed: string, stream: RngStream): RngStreamState {
  const d = sha256(utf8ToBytes(`${seed}/${stream}`));
  const word = (i: number): number =>
    ((d[i] ?? 0) | ((d[i + 1] ?? 0) << 8) | ((d[i + 2] ?? 0) << 16) | ((d[i + 3] ?? 0) << 24)) >>> 0;
  return { algo: 'sfc32', s: [word(0), word(4), word(8), word(12)] };
}

/** Initial state of all five streams. A per-stream override replaces `seed` in that stream's seeding string. */
export function initRng(
  seed: string,
  streamSeeds?: Partial<Record<RngStream, string>>,
): Readonly<Record<RngStream, RngStreamState>> {
  const out = {} as Record<RngStream, RngStreamState>;
  for (const stream of RNG_STREAMS) out[stream] = seedStream(streamSeeds?.[stream] ?? seed, stream);
  return out;
}

/** One sfc32 step: the next uint32 and the advanced state. */
export function sfc32Next(s: Sfc32): readonly [number, Sfc32] {
  let [a, b, c, d] = s;
  const t = (((a + b) | 0) + d) | 0;
  d = (d + 1) | 0;
  a = b ^ (b >>> 9);
  b = (c + (c << 3)) | 0;
  c = (c << 21) | (c >>> 11);
  c = (c + t) | 0;
  return [t >>> 0, [a >>> 0, b >>> 0, c >>> 0, d >>> 0]];
}

/** An unbiased integer in [0, n) from sfc32 by rejection sampling. */
function sfc32Int(s: Sfc32, n: number): readonly [number, Sfc32] {
  const limit = UINT32 - (UINT32 % n);
  let state = s;
  for (;;) {
    const [u, next] = sfc32Next(state);
    state = next;
    if (u < limit) return [u % n, state];
  }
}

function checkBound(n: number): void {
  if (!Number.isInteger(n) || n < 1 || n > UINT32) throw new RangeError(`rng: bound must be an integer in [1, 2^32], got ${n}`);
}

/** Takes the next scripted value, or null when the stream is (or becomes) a plain sfc32 stream. */
function takeScripted(st: RngStreamState): { value: number; next: RngStreamState } | null {
  if (st.algo !== 'scripted') return null;
  const [value, ...rest] = st.values;
  if (value === undefined) return null;
  const next: RngStreamState = rest.length > 0 ? { algo: 'scripted', values: rest, then: st.then } : { algo: 'sfc32', s: st.then };
  return { value, next };
}

function sfc32Of(st: RngStreamState): Sfc32 {
  return st.algo === 'sfc32' ? st.s : st.then;
}

/**
 * An unbiased integer in [0, n). A scripted stream yields its next value verbatim (it must lie in [0, n)); once its
 * values are exhausted the stream becomes sfc32 from `then`.
 */
export function drawInt(st: RngStreamState, n: number): readonly [number, RngStreamState] {
  checkBound(n);
  const scripted = takeScripted(st);
  if (scripted) {
    if (!Number.isInteger(scripted.value) || scripted.value < 0 || scripted.value >= n) {
      throw new RangeError(`rng: scripted value ${scripted.value} is outside [0, ${n})`);
    }
    return [scripted.value, scripted.next];
  }
  const [v, s] = sfc32Int(sfc32Of(st), n);
  return [v, { algo: 'sfc32', s }];
}

/** One six-sided die face in 1..6. Scripted values on this path are faces (1–6), not indices. */
export function drawDie(st: RngStreamState): readonly [number, RngStreamState] {
  const scripted = takeScripted(st);
  if (scripted) {
    if (!Number.isInteger(scripted.value) || scripted.value < 1 || scripted.value > 6) {
      throw new RangeError(`rng: scripted die face ${scripted.value} is outside 1..6`);
    }
    return [scripted.value, scripted.next];
  }
  const [v, s] = sfc32Int(sfc32Of(st), 6);
  return [v + 1, { algo: 'sfc32', s }];
}

/** Fisher–Yates: for i from length−1 down to 1, swap i with j = drawInt(i + 1). Returns a new array. */
export function shuffle<T>(st: RngStreamState, items: readonly T[]): readonly [readonly T[], RngStreamState] {
  const out = [...items];
  let state = st;
  for (let i = out.length - 1; i >= 1; i--) {
    const [j, next] = drawInt(state, i + 1);
    state = next;
    // eslint-disable-next-line hexlands/no-playerview-mint -- 0 ≤ j ≤ i < out.length, so out[i] is a T (noUncheckedIndexedAccess widens it to T | undefined).
    const tmp = out[i] as T;
    // eslint-disable-next-line hexlands/no-playerview-mint -- 0 ≤ j ≤ i < out.length, so out[j] is a T.
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return [out, state];
}
