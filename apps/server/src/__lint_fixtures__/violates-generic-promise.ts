// V37 seeded violation: a generic helper returning Promise<T>, instantiated as PlayerView (HARD-1, bug 546967f1).
import type { PlayerView, PlayerViewData } from '@hexlands/engine';

async function brand<T>(x: unknown): Promise<T> {
  return x as T;
}

export async function f(d: PlayerViewData): Promise<PlayerView> {
  return await brand<PlayerView>(d);
}
