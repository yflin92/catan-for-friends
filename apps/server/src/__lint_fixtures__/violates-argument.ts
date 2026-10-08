// V37 seeded violation: an any passed where a PlayerView is expected (HARD-1).
import type { PlayerView } from '@hexlands/engine';

declare function send(view: PlayerView): void;

export function relay(raw: string): void {
  send(JSON.parse(raw));
}
