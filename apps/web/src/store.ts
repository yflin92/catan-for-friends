// The single client store (design §2.4): {room, view, seq, pending} plus connection state. Every change produces a new
// immutable snapshot, so a render reads the view and the TH15 attributes derived from it from the same object.
import { useSyncExternalStore } from 'react';
import type { Seat } from '@hexlands/engine';
import type { ActionId, PlayerViewWire, RoomView } from './wire';

/** An action, lobby op or control op sent to the server that has no outcome yet. */
export interface Pending {
  readonly actionId: ActionId;
  /** The client message exactly as first sent; resends reuse it unchanged. */
  readonly msg: unknown;
  readonly sentAt: number;
}

/** Why the client stopped reconnecting on its own. */
export type TerminalReason = 'superseded' | 'auth_failed' | 'game_gone';

export interface ConnectionState {
  readonly status: 'idle' | 'connecting' | 'open' | 'reconnecting' | 'stopped';
  /** Set when status is 'stopped' because of a terminal close code (4001, 4401, 4410). */
  readonly terminal: TerminalReason | null;
}

export interface StoreSnapshot {
  /** The room this tab is in (canonical form, e.g. "ABCDEF"); null on the home screen. */
  readonly roomCode: string | null;
  readonly room: RoomView | null;
  /** Exactly the last adopted view as received from the server; null until one arrives. */
  readonly view: PlayerViewWire | null;
  /** Seq of `view`; null until a view has been adopted. */
  readonly seq: number | null;
  /** viewHash(view) of the adopted view; '' without a view. */
  readonly viewHash: string;
  /** publicProjectionHash(view) of the adopted view; '' without a view or while the engine lacks the function. */
  readonly publicHash: string;
  /** The bound seat; null when unseated. */
  readonly seat: Seat | null;
  readonly pending: ReadonlyMap<ActionId, Pending>;
  readonly connection: ConnectionState;
  /** True when the server's buildVersion differs from this bundle's. */
  readonly staleBundle: boolean;
}

export const EMPTY_SNAPSHOT: StoreSnapshot = Object.freeze<StoreSnapshot>({
  roomCode: null,
  room: null,
  view: null,
  seq: null,
  viewHash: '',
  publicHash: '',
  seat: null,
  pending: new Map<ActionId, Pending>(),
  connection: { status: 'idle', terminal: null },
  staleBundle: false,
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
