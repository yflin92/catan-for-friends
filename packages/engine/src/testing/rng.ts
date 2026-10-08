// Scripted RNG streams for tests (design §3.5, TH2). Only this module constructs `scripted` stream states.
import type { RngStream, RngStreamState } from '../rng';
import type { GameState } from '../state';

/** A scripted stream that yields `values` first, then continues as sfc32 from where `st` would have continued. */
export function scriptedStream(st: RngStreamState, values: readonly number[]): RngStreamState {
  const pending = st.algo === 'scripted' ? st.values : [];
  const then = st.algo === 'scripted' ? st.then : st.s;
  const all = [...pending, ...values];
  return all.length === 0 ? { algo: 'sfc32', s: then } : { algo: 'scripted', values: all, then };
}

/**
 * Queues `values` on one stream: they are drawn next, after any values already scripted, and the stream then continues
 * as it would have. Values are raw draws (dice: faces 1–6; steal/absence/board/devDeck: indices).
 */
export function scriptRng(state: GameState, stream: RngStream, values: readonly number[]): GameState {
  return { ...state, rng: { ...state.rng, [stream]: scriptedStream(state.rng[stream], values) } };
}

/** Queues dice rolls: each pair is the two faces (1–6) of one roll, in order. */
export function forceDice(state: GameState, rolls: readonly (readonly [number, number])[]): GameState {
  for (const [a, b] of rolls) {
    for (const face of [a, b]) {
      if (!Number.isInteger(face) || face < 1 || face > 6) throw new RangeError(`forceDice: die face ${face} is outside 1..6`);
    }
  }
  return scriptRng(state, 'dice', rolls.flat());
}
