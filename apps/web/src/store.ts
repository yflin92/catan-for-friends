// The single client store (design §2.4): {room, view, seq, pending}. Every change produces a new immutable snapshot,
// so a render reads the view and the TH15 attributes derived from it from the same object.
import { useSyncExternalStore } from 'react';
import type { Seat } from '@hexlands/engine';
import type { ActionId, PlayerViewWire, RoomView } from './wire';

/** An action sent to the server that has no outcome yet. */
export interface Pending {
  readonly actionId: ActionId;
  /** The client message exactly as first sent; resends reuse it unchanged. */
  readonly msg: unknown;
  readonly sentAt: number;
}

export interface StoreSnapshot {
  readonly room: RoomView | null;
  /** Exactly the last adopted view as received from the server; null until one arrives. */
  readonly view: PlayerViewWire | null;
  /** Seq of `view`; null until a view has been adopted. */
  readonly seq: number | null;
  /** The bound seat, from welcome; null when unseated. */
  readonly seat: Seat | null;
  readonly pending: ReadonlyMap<ActionId, Pending>;
}

export const EMPTY_SNAPSHOT: StoreSnapshot = Object.freeze({
  room: null,
  view: null,
  seq: null,
  seat: null,
  pending: new Map<ActionId, Pending>(),
});

type Listener = () => void;

export class Store {
  private snapshot: StoreSnapshot;
  private readonly listeners = new Set<Listener>();

  constructor(initial: StoreSnapshot = EMPTY_SNAPSHOT) {
    this.snapshot = initial;
  }

  getSnapshot = (): StoreSnapshot => this.snapshot;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Replaces the snapshot with `patch` applied and notifies subscribers once. */
  update(patch: Partial<StoreSnapshot>): void {
    this.snapshot = Object.freeze({ ...this.snapshot, ...patch });
    for (const l of this.listeners) l();
  }
}

export function useStoreSnapshot(store: Store): StoreSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
