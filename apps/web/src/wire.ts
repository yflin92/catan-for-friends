// Wire-level types the client holds (design §3.11). Views arrive as unbranded JSON (PlayerViewWire); the client never
// mints the PlayerView brand.
import type { RoomView } from '@hexlands/protocol';

export type { ActionId, LogEntryWire, OutcomeRecord, PlayerViewWire, RoomView, ServerMsgWire } from '@hexlands/protocol';

export type Lifecycle = RoomView['lifecycle'];
