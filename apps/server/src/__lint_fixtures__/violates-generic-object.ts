// V37 seeded violation: a generic helper returning { value: T }, instantiated as PlayerView (HARD-1, bug 546967f1).
import type { PlayerView, PlayerViewData } from '@hexlands/engine';

function brand<T>(x: unknown): { value: T } {
  return { value: x as T };
}

export function f(d: PlayerViewData): PlayerView {
  return brand<PlayerView>(d).value;
}
