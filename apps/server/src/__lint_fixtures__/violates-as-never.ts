// V37 seeded violation: `as never` into a PlayerView slot (HARD-1, bug 546967f1).
import type { PlayerView, PlayerViewData } from '@hexlands/engine';

export function f(d: PlayerViewData): PlayerView {
  const v: PlayerView = d as never;
  return v;
}
