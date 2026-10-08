// RoomView construction (design §3.11). buildVersion is the server's build id, the same value /healthz reports (D6).
import type { Seat } from '@hexlands/engine';
import type { RoomView } from '@hexlands/protocol';
import type { GameMetaRow, SeatRow } from './store/game-store';

const ALL_SEATS: readonly Seat[] = [0, 1, 2, 3];

export interface RoomPresence {
  connected(seat: Seat): boolean;
  readonly waitingOn?: RoomView['waitingOn'];
  readonly skippable?: RoomView['skippable'];
}

/** The room view of a game: all four seat slots in order, named when claimed. */
export function roomView(meta: GameMetaRow, seats: readonly SeatRow[], presence: RoomPresence, buildVersion: string): RoomView {
  const byIndex = new Map(seats.map((s) => [s.seat, s]));
  return {
    lifecycle: meta.lifecycle,
    hostSeat: meta.hostSeat,
    seats: ALL_SEATS.map((seat) => {
      const row = byIndex.get(seat);
      return { seat, name: row?.displayName ?? null, connected: row ? presence.connected(seat) : false };
    }),
    config: { rules: meta.config.rules, absencePolicy: meta.config.absencePolicy },
    waitingOn: presence.waitingOn ?? [],
    skippable: presence.skippable ?? [],
    buildVersion,
  };
}
