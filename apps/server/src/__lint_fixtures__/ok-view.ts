// Allowed: PlayerViews created by view(state, seat), and generic helpers applied to an existing PlayerView (HARD-1).
import { view, type GameState, type PlayerView } from '@hexlands/engine';

function identity<T>(x: T): T {
  return x;
}

export function make(state: GameState): PlayerView {
  const v: PlayerView = view(state, 0);
  const same: PlayerView = identity(v);
  return structuredClone(same);
}
