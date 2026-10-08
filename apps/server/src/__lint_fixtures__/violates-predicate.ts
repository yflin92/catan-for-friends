// V37 seeded violation: a type predicate narrowing to PlayerView (HARD-1, bug 546967f1).
import type { PlayerView, PlayerViewData } from '@hexlands/engine';

function isView(x: unknown): x is PlayerView {
  return x !== null;
}

export function f(d: PlayerViewData): PlayerView {
  const u: unknown = d;
  if (isView(u)) return u;
  throw new Error();
}
