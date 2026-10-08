// What the lobby screens can ask for: create a room, enter one, and send lobby ops. The real implementation sits on
// the WsClient and POST /api/rooms; tests substitute a mock.
import type { ControlOp, LobbyOp, OutcomeRecord } from '@hexlands/protocol';
import { readCredentials, writeCredentials } from '../fragment';
import type { WsClient } from '../ws-client';
import { createRoomRequest, type CreateRoomResult, type FetchFn } from './api';

export interface LobbyActions {
  /** Creates a room; on success stores the host credentials and enters the room. */
  createRoom(displayName: string, passphrase?: string): Promise<CreateRoomResult>;
  /** Enters a room by code (canonical form), keeping any seat token already stored for it. */
  enterRoom(roomCode: string): void;
  lobby(op: LobbyOp): Promise<OutcomeRecord>;
  control(op: ControlOp): Promise<OutcomeRecord>;
}

export function createLobbyActions(deps: {
  readonly client: Pick<WsClient, 'start' | 'sendLobby' | 'sendControl'>;
  readonly storage: Pick<Storage, 'getItem' | 'setItem'>;
  readonly fetchFn: FetchFn;
}): LobbyActions {
  const enterRoom = (roomCode: string) => {
    if (readCredentials(deps.storage, roomCode) === null) writeCredentials(deps.storage, { roomCode });
    deps.client.start(roomCode);
  };
  return {
    async createRoom(displayName, passphrase) {
      const res = await createRoomRequest(deps.fetchFn, passphrase !== undefined ? { displayName, passphrase } : { displayName });
      if (res.ok) {
        writeCredentials(deps.storage, { roomCode: res.roomCode, seatToken: res.seatToken });
        deps.client.start(res.roomCode);
      }
      return res;
    },
    enterRoom,
    lobby: (op) => deps.client.sendLobby(op),
    control: (op) => deps.client.sendControl(op),
  };
}

/** Actions for a page without a server behind it: every request fails with error/internal_error. */
export const OFFLINE_LOBBY_ACTIONS: LobbyActions = {
  createRoom: () => Promise.resolve({ ok: false, status: 0, reasonCode: 'internal_error' }),
  enterRoom: () => undefined,
  lobby: () => Promise.resolve({ actionId: null, result: 'error', reasonCode: 'internal_error' }),
  control: () => Promise.resolve({ actionId: null, result: 'error', reasonCode: 'internal_error' }),
};
