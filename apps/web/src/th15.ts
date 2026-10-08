// Test-observability attributes on the app root (design §2.4 TH15; AC22, AC23, AC31). They are hashes and ids of data
// the seat already holds, so they are present in every build.
import type { StoreSnapshot } from './store';
import type { PlayerViewWire } from './wire';

export interface ViewHashers {
  viewHash(view: PlayerViewWire): string;
  publicProjectionHash(view: PlayerViewWire): string;
}

export interface RootAttributes {
  readonly 'data-seq': string;
  readonly 'data-view-hash': string;
  readonly 'data-public-hash': string;
  readonly 'data-lifecycle': string;
  readonly 'data-seat': string;
}

/**
 * Derives the TH15 attributes from one store snapshot. Hash and seq attributes are empty strings until a view exists
 * (or when no hashers are supplied); data-lifecycle is empty until a room is known; data-seat is the wire seat (0–3)
 * and empty while unseated.
 */
export function rootAttributes(s: StoreSnapshot, hashers: ViewHashers | null): RootAttributes {
  const view = s.view;
  return {
    'data-seq': view !== null && s.seq !== null ? String(s.seq) : '',
    'data-view-hash': view !== null && hashers !== null ? hashers.viewHash(view) : '',
    'data-public-hash': view !== null && hashers !== null ? hashers.publicProjectionHash(view) : '',
    'data-lifecycle': s.room?.lifecycle ?? '',
    'data-seat': s.seat !== null ? String(s.seat) : '',
  };
}
