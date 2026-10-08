// V37 seeded violation: a generic helper handing a cast T to a callback, instantiated as PlayerView (HARD-1, bug 546967f1).
import type { PlayerView, PlayerViewData } from '@hexlands/engine';

function withAs<T>(x: unknown, k: (v: T) => void): void {
  k(x as T);
}

export function f(d: PlayerViewData, send: (v: PlayerView) => void): void {
  withAs<PlayerView>(d, send);
}
