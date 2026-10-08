// V37 seeded violation: a class-level type parameter cast in Box<T>.get() (HARD-1, bug 546967f1).
import type { PlayerView, PlayerViewData } from '@hexlands/engine';

class Box<T> {
  constructor(private readonly x: unknown) {}
  get(): T {
    return this.x as T;
  }
}

export function f(d: PlayerViewData): PlayerView {
  return new Box<PlayerView>(d).get();
}
