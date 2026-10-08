// RoomManager (design §2.3, §5.1(1)): room code → game lookup, the rooms.maxActiveGames cap, lobby creation, and the
// live GameRooms of started games, loaded lazily from the store on first use.
import { randomUUID } from 'node:crypto';
import { DEFAULT_GAME_CONFIG, type GameConfig, type GameState } from '@hexlands/engine';
import { hashSeatToken, mintRoomCode, mintSeatToken } from './codes';
import { GameRoom, ReportedFault, RestoreError } from './game-room';
import { serverMetrics } from './metrics';
import type { ServerContext } from './server';
import type { GameMetaRow, Lifecycle, LoadedGame } from './store/game-store';
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

/** Result of boot recovery (design §5.9). */
export interface RecoveryResult {
  /** Active games restored eagerly. */
  readonly restored: number;
  /** Active games that could not be restored. */
  readonly lost: number;
}

export class RoomManager {
  /** Set when the server drains; the commit path then answers error/server_draining (design §5.8). */
  draining = false;
  private readonly live = new Map<string, GameRoom>();
  /** Games that were abandoned at boot and have not been loaded since; they are restored lazily (design §5.9). */
  private readonly restoreOnLoad = new Set<string>();

  constructor(
    private readonly ctx: ServerContext,
    private readonly gateway: () => WsGateway,
  ) {}

  /**
   * The live room of a started game, loading it from the store if needed; otherwise why there is none. An active or
   * abandoned game that cannot be restored goes through the lost path and reads as 'expired' from then on. Any other
   * restore failure is counted as catan.errors{component=persist}, logged, and thrown as a ReportedFault.
   */
  room(gameId: string): GameRoom | NoRoom {
    const loaded = this.live.get(gameId);
    if (loaded) return loaded;
    const game = this.ctx.store.loadGame(gameId);
    if (!game) return 'unknown';
    if (game.meta.lifecycle === 'expired') return 'expired';
    if (!STARTED.has(game.meta.lifecycle)) return 'not_started';
    let room: GameRoom;
    try {
      room = GameRoom.restore({ ctx: this.ctx, gateway: this.gateway }, game);
    } catch (err) {
      if (err instanceof RestoreError && game.meta.lifecycle !== 'finished') {
        this.restoreOnLoad.delete(gameId);
        this.lose(game, err);
        return 'expired';
      }
      // A stored log that cannot be restored: counted and logged here, where the game is known.
      serverMetrics(this.ctx.telemetry).errors.add(1, { component: 'persist' });
      this.ctx.telemetry.log('ERROR', 'action.error', {
        component: 'persist',
        game_id: gameId,
        seq: game.events.at(-1)?.seq ?? game.snapshot?.seq ?? game.meta.headSeq,
        error: err instanceof Error ? err.name : 'unknown',
      });
      throw new ReportedFault();
    }
    this.live.set(gameId, room);
    if (this.restoreOnLoad.delete(gameId)) this.restoredCounter().add(1);
    return room;
  }

  /**
   * Boot recovery (design §5.9 step 2), run before the server listens. Every active game is restored now; abandoned
   * games are restored on first load. A restored active game starts with every seat disconnected:
   * all_disconnected_since keeps its persisted value, or becomes `bootAt` when it was NULL.
   */
  recover(bootAt: number): RecoveryResult {
    for (const meta of this.ctx.store.listGames(['abandoned'])) this.restoreOnLoad.add(meta.id);
    let restored = 0;
    let lost = 0;
    for (const meta of this.ctx.store.listGames(['active'])) {
      if (this.room(meta.id) === 'expired') {
        lost += 1;
        continue;
      }
      restored += 1;
      this.restoredCounter().add(1);
      if (meta.allDisconnectedSince === null) this.ctx.store.updateMeta(meta.id, { allDisconnectedSince: bootAt });
    }
    return { restored, lost };
  }

  /** Every room in memory. */
  loadedRooms(): readonly GameRoom[] {
    return [...this.live.values()];
  }

  /** Drops the game's room from memory (abandoned or terminal games); the store keeps everything. */
  unload(gameId: string): void {
    this.live.delete(gameId);
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

  /**
   * The lost path (design §5.9, F7): lifecycle expired with end_reason 'lost', catan.games.lost_on_restart +1, ERROR
   * game.lost and game.ended{outcome: lost, from_state}. catan.games.transitions is NOT incremented (G3).
   */
  private lose(game: LoadedGame, err: RestoreError): void {
    const { ctx } = this;
    const { meta } = game;
    const now = ctx.clock.now();
    ctx.store.updateMeta(meta.id, { lifecycle: 'expired', endReason: 'lost', endedAt: now });
    serverMetrics(ctx.telemetry).gamesLostOnRestart.add(1);
    ctx.telemetry.log('ERROR', 'game.lost', { game_id: meta.id, seq: err.seq, expected: err.expected, actual: err.actual });
    ctx.telemetry.log('INFO', 'game.ended', {
      game_id: meta.id,
      outcome: 'lost',
      from_state: meta.lifecycle,
      winner_seat: null,
      turns: null,
      active_play_s: Math.round(meta.activePlayMs / 1000),
      wall_s: meta.startedAt === null ? null : Math.max(0, Math.round((now - meta.startedAt) / 1000)),
      vp_by_seat: null,
      seed: meta.seed,
    });
  }

  private restoredCounter() {
    return serverMetrics(this.ctx.telemetry).gamesRestoredOnStart;
  }

  private freshRoomCode(): string {
    for (let i = 0; i < ROOM_CODE_ATTEMPTS; i++) {
      const code = mintRoomCode(this.ctx.config.rooms.roomCodeLength);
      if (!this.ctx.store.findByRoomCode(code)) return code;
    }
    throw new Error('no free room code');
  }
}
