// Named RNG stream types (design §3.5, ADR-0003). All engine randomness flows through these five streams, whose state
// lives in GameState.rng. Streams are independent: drawing from one never shifts another.
//
//   board   → createGame only: terrain Fisher–Yates, then token placement, then the harbor-kind Fisher–Yates.
//   dice    → two d6 per roll, including auto-rolls from a skip.
//   devDeck → one Fisher–Yates shuffle of the 25 cards at createGame.
//   steal   → card index into the victim's hand, expanded in canonical resource order.
//   absence → random cards for auto-discards under a skip.

export type RngStream = 'board' | 'dice' | 'devDeck' | 'steal' | 'absence';
export const RNG_STREAMS: readonly RngStream[] = Object.freeze(['board', 'dice', 'devDeck', 'steal', 'absence']);

/** sfc32 state: four uint32 words. */
export type Sfc32 = readonly [number, number, number, number];

/** A `scripted` stream yields `values` first (dice: faces 1–6; steal/absence: raw indices), then continues as sfc32
 *  from `then`. Only @hexlands/engine/testing constructs scripted streams. */
export type RngStreamState =
  | { readonly algo: 'sfc32'; readonly s: Sfc32 }
  | { readonly algo: 'scripted'; readonly values: readonly number[]; readonly then: Sfc32 };
