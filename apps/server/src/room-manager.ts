// RoomManager (design §2.3, §5.1(1)): room code → game lookup, the rooms.maxActiveGames cap and lobby creation.
// TODO(S-3/L-2): lazy load and unload of GameRooms once GameRoom exists.
import { randomUUID } from 'node:crypto';
import { DEFAULT_GAME_CONFIG, type GameConfig } from '@hexlands/engine';
import { hashSeatToken, mintRoomCode, mintSeatToken } from './codes';
import type { ServerContext } from './server';
import type { GameMetaRow } from './store/game-store';

/** Attempts at a fresh room code before giving up (each collision is ~2^-30 × active games). */
const ROOM_CODE_ATTEMPTS = 16;

export type CreateRoomResult =
  | {
      readonly ok: true;
      readonly gameId: string;
      readonly roomCode: string;
      readonly seatToken: string;
      readonly seat: 0;
      readonly config: GameConfig;
    }
  | { readonly ok: false; readonly reasonCode: 'capacity_reached' };

export class RoomManager {
  constructor(private readonly ctx: ServerContext) {}

  /** Games counted against rooms.maxActiveGames: lobby + active (abandoned games never count, AC1). */
  countCapacityGames(): number {
    return this.ctx.store.listGames(['lobby', 'active']).length;
  }

  /** Number of games per gauged lifecycle state (catan.games). */
  countByState(): { lobby: number; active: number; abandoned: number } {
    const rows = this.ctx.store.listGames(['lobby', 'active', 'abandoned']);
    const out = { lobby: 0, active: 0, abandoned: 0 };
    for (const r of rows) out[r.lifecycle as keyof typeof out] += 1;
    return out;
  }

  findByRoomCode(code: string): GameMetaRow | null {
    return this.ctx.store.findByRoomCode(code);
  }

  /** Creates a lobby with the host in seat 0. `displayName` must already be normalised. */
  createRoom(displayName: string): CreateRoomResult {
    const { config, store, clock, secrets } = this.ctx;
    if (this.countCapacityGames() >= config.rooms.maxActiveGames) return { ok: false, reasonCode: 'capacity_reached' };
    const roomCode = this.freshRoomCode();
    const seatToken = mintSeatToken();
    const gameId = randomUUID();
    const now = clock.now();
    const gameConfig: GameConfig = { ...DEFAULT_GAME_CONFIG, lifecycle: config.lifecycle };
    store.createRoom({ id: gameId, roomCode, config: gameConfig, hostSeat: 0, createdAt: now });
    store.upsertSeat(gameId, 0, displayName, hashSeatToken(seatToken), now);
    secrets.record('roomCode', roomCode);
    secrets.record('seatToken', seatToken);
    return { ok: true, gameId, roomCode, seatToken, seat: 0, config: gameConfig };
  }

  private freshRoomCode(): string {
    for (let i = 0; i < ROOM_CODE_ATTEMPTS; i++) {
      const code = mintRoomCode(this.ctx.config.rooms.roomCodeLength);
      if (!this.ctx.store.findByRoomCode(code)) return code;
    }
    throw new Error('no free room code');
  }
}
