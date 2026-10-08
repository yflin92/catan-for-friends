// Wire-level types the client holds (design §3.11). Views arrive as unbranded JSON (PlayerViewWire); the client never
// mints the PlayerView brand.
import type { AbsencePolicy, GameRules, PlayerViewData, Seat } from '@hexlands/engine';

export type PlayerViewWire = PlayerViewData;

export type ActionId = string;

export type Lifecycle = 'lobby' | 'active' | 'abandoned' | 'finished' | 'expired';

export interface RoomView {
  readonly lifecycle: Lifecycle;
  readonly hostSeat: Seat;
  readonly seats: readonly { readonly seat: Seat; readonly name: string | null; readonly connected: boolean }[];
  readonly config: { readonly rules: GameRules; readonly absencePolicy: AbsencePolicy };
  readonly waitingOn: readonly { readonly seat: Seat; readonly disconnectedForSec: number | null }[];
  readonly skippable: readonly Seat[];
  readonly buildVersion: string;
}
