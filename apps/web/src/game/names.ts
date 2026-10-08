// Seat display names for game screens: the room's name for the seat, else "Seat N".
import type { Seat } from '@hexlands/engine';
import type { RoomView } from '../wire';

export function seatName(room: RoomView | null, seat: Seat): string {
  return room?.seats.find((s) => s.seat === seat)?.name ?? `Seat ${seat + 1}`;
}
