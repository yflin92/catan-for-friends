// V37 seeded violation: an assertion signature narrowing to PlayerView (HARD-1, bug 546967f1).
import type { PlayerView, PlayerViewData } from '@hexlands/engine';

function assertView(x: unknown): asserts x is PlayerView {
  if (x === null) throw new Error();
}

export function f(d: PlayerViewData): PlayerView {
  const u: unknown = d;
  assertView(u);
  return u;
}
