// Test-observability attributes on the app root (design §2.4 TH15; AC22, AC23, AC31). They are hashes and ids of data
// the seat already holds, so they are present in every build.
import type { StoreSnapshot } from './store';

export interface RootAttributes {
  readonly 'data-seq': string;
  readonly 'data-view-hash': string;
  readonly 'data-public-hash': string;
  readonly 'data-lifecycle': string;
  readonly 'data-seat': string;
}

/**
 * Derives the TH15 attributes from one store snapshot. Seq and hash attributes are empty strings until a view exists;
 * data-lifecycle is empty until a room is known; data-seat is the wire seat (0–3) and empty while unseated.
 */
export function rootAttributes(s: StoreSnapshot): RootAttributes {
  const hasView = s.view !== null && s.seq !== null;
  return {
    'data-seq': hasView ? String(s.seq) : '',
    'data-view-hash': hasView ? s.viewHash : '',
    'data-public-hash': hasView ? s.publicHash : '',
    'data-lifecycle': s.room?.lifecycle ?? '',
    'data-seat': s.seat !== null ? String(s.seat) : '',
  };
}
