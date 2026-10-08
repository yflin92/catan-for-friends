// V37 seeded violation: an any-typed value into an object type holding a PlayerView (HARD-1, bug 546967f1).
import type { PlayerView } from '@hexlands/engine';

export function f(raw: string): PlayerView {
  const box: { v: PlayerView } = JSON.parse(raw);
  return box.v;
}
