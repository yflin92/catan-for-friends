// V37 seeded violation: an any-typed parameter default as a PlayerView (HARD-1, bug 546967f1).
import type { PlayerView } from '@hexlands/engine';

export function f(raw: string, v: PlayerView = JSON.parse(raw)): PlayerView {
  return v;
}
