// V37 seeded violation: an any returned as a PlayerView (HARD-1).
import type { PlayerView } from '@hexlands/engine';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the seeded any is the point of this fixture
export function fromAnything(x: any): PlayerView {
  return x;
}
