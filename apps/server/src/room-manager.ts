// RoomManager (design §2.3, §5.1(1)): room code → game lookup, the rooms.maxActiveGames cap, lobby creation, and the
// live GameRooms of started games, loaded lazily from the store on first use.
import { randomUUID } from 'node:crypto';
import { DEFAULT_GAME_CONFIG, type GameConfig, type GameState } from '@hexlands/engine';
import { hashSeatToken, mintRoomCode, mintSeatToken } from './codes';
import { GameRoom, ReportedFault, errorsCounter } from './game-room';
import type { ServerContext } from './server';
import type { GameMetaRow, Lifecycle } from './store/game-store';
import type { WsGateway } from './ws-gateway';

/** Lifecycles whose game has a GameState (started and not expired or purged). */
const STARTED: ReadonlySet<Lifecycle> = new Set(['active', 'abandoned', 'finished']);

/** Why no live room is available for a game. */
export type NoRoom = 'not_started' | 'expired' | 'unknown';

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
  /** Set when the server drains; the commit path then answers error/server_draining (design §5.8). */
  draining = false;
  private readonly live = new Map<string, GameRoom>();

  constructor(
    private readonly ctx: ServerContext,
    private readonly gateway: () => WsGateway,
  ) {}

  /**
   * The live room of a started game, loading it from the store if needed; otherwise why there is none. A log that does
   * not restore is counted as catan.errors{component=persist}, logged, and thrown as a ReportedFault.
   */
  room(gameId: string): GameRoom | NoRoom {
    const loaded = this.live.get(gameId);
    if (loaded) return loaded;
    const game = this.ctx.store.loadGame(gameId);
    if (!game) return 'unknown';
    if (game.meta.lifecycle === 'expired') return 'expired';
    if (!STARTED.has(game.meta.lifecycle) || game.snapshot === null) return 'not_started';
    let room: GameRoom;
    try {
      room = GameRoom.restore({ ctx: this.ctx, gateway: this.gateway }, game);
    } catch (err) {
      // A stored log that cannot be restored: counted and logged here, where the game is known.
      errorsCounter(this.ctx).add(1, { component: 'persist' });
      this.ctx.telemetry.log('ERROR', 'action.error', {
        component: 'persist',
        game_id: gameId,
        seq: game.events.at(-1)?.seq ?? game.snapshot.seq,
        error: err instanceof Error ? err.name : 'unknown',
      });
      throw new ReportedFault();
    }
    this.live.set(gameId, room);
    return room;
  }

  /** The room if it is already in memory; never loads. */
  loaded(gameId: string): GameRoom | null {
    return this.live.get(gameId) ?? null;
  }

  /**
   * Registers the room of a game that has just started (its seq-0 snapshot is already persisted) and returns it; the
   * caller broadcasts the first state with room.broadcast().
   */
  adopt(gameId: string, state: GameState, seq = 0): GameRoom {
    const room = new GameRoom({ ctx: this.ctx, gateway: this.gateway }, gameId, state, seq);
    this.live.set(gameId, room);
    return room;
  }

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
