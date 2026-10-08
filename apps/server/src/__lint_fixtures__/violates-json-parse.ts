// V37 seeded violation: an any-typed JSON.parse result assigned to a PlayerView (HARD-1).
import type { PlayerView } from '@hexlands/engine';

export function parse(raw: string): PlayerView {
  const v: PlayerView = JSON.parse(raw);
  return v;
}
