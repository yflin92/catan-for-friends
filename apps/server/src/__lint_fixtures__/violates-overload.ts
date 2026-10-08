// V37 seeded violation: an overload signature returning PlayerView over an unchecked implementation (HARD-1, bug 546967f1).
import type { PlayerView, PlayerViewData } from '@hexlands/engine';

export function mint(x: PlayerViewData): PlayerView;
export function mint(x: PlayerViewData): unknown {
  return x;
}
