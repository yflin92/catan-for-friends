// Allowed in the web client: parsed wire views are PlayerViewWire / ViewLike, never the PlayerView brand (HARD-1).
import type { PlayerViewWire } from '../wire';

export function parseView(raw: string): PlayerViewWire {
  const v = JSON.parse(raw) as PlayerViewWire;
  return v;
}

export function seatOf(v: { readonly you: number }): number {
  return v.you;
}
