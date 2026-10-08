// V37 seeded violation: a generic cast helper instantiated as PlayerView (HARD-1).
import type { PlayerView, PlayerViewData } from '@hexlands/engine';

function brand<T>(x: unknown): T {
  return x as T;
}

export function mint(data: PlayerViewData): PlayerView {
  return brand<PlayerView>(data);
}
