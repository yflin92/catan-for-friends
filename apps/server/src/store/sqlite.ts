// SQLite GameStore (design §4, ADR-0005): better-sqlite3, synchronous, WAL, synchronous=FULL, foreign_keys=ON.
// A commit is the events INSERT plus the games head/timestamp UPDATE in one transaction; `ok` is acked only after it.
import { timingSafeEqual } from 'node:crypto';
import Database from 'better-sqlite3';
import type { Command, GameConfig, Seat } from '@hexlands/engine';
import {
  IMMUTABLE_META_KEYS,
  type GameMetaRow,
  type GameStore,
  type Lifecycle,
  type LoadedGame,
  type NewEvent,
  type NewRoomRow,
  type SeatRow,
  type SnapshotRow,
  type StoredEvent,
} from './game-store';

export const SCHEMA_VERSION = 1;
/** Snapshots kept per game (design §4). */
export const SNAPSHOTS_KEPT = 2;

/** Ordered migrations; migration i brings the schema from version i to i + 1. */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE games (
    id                     TEXT PRIMARY KEY,
    room_code              TEXT UNIQUE,
    lifecycle              TEXT NOT NULL CHECK (lifecycle IN ('lobby','active','abandoned','finished','expired')),
    end_reason             TEXT CHECK (end_reason IN ('won','abandoned_expired','lobby_expired','lost')),
    config_json            TEXT NOT NULL,
    seed                   TEXT,
    engine_version         TEXT,
    host_seat              INTEGER NOT NULL DEFAULT 0,
    head_seq               INTEGER NOT NULL DEFAULT 0,
    room_rev               INTEGER NOT NULL DEFAULT 0,
    created_at             INTEGER NOT NULL,
    started_at             INTEGER,
    last_lobby_activity_at INTEGER NOT NULL,
    last_action_at         INTEGER,
    all_disconnected_since INTEGER,
    abandoned_at           INTEGER,
    abandon_reason         TEXT CHECK (abandon_reason IN ('inactivity','all_disconnected')),
    ended_at               INTEGER,
    active_play_ms         INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX games_lifecycle ON games(lifecycle);

  CREATE TABLE seats (
    game_id      TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    seat         INTEGER NOT NULL CHECK (seat BETWEEN 0 AND 3),
    display_name TEXT NOT NULL,
    token_hash   BLOB NOT NULL UNIQUE,
    claimed_at   INTEGER NOT NULL,
    PRIMARY KEY (game_id, seat)
  );
  CREATE TABLE revoked_tokens (
    token_hash BLOB PRIMARY KEY, game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE, revoked_at INTEGER NOT NULL
  );

  CREATE TABLE events (
    game_id      TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    seq          INTEGER NOT NULL,
    action_id    TEXT,
    payload_hash TEXT,
    actor        TEXT NOT NULL,
    command_json TEXT NOT NULL,
    hash_after   TEXT NOT NULL,
    committed_at INTEGER NOT NULL,
    PRIMARY KEY (game_id, seq),
    UNIQUE (game_id, action_id)
  );
  CREATE TABLE snapshots (
    game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE, seq INTEGER NOT NULL,
    state_json TEXT NOT NULL, state_hash TEXT NOT NULL, engine_version TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY (game_id, seq)
  );
  CREATE TABLE server_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
];

const META_COLUMNS = {
  id: 'id',
  roomCode: 'room_code',
  lifecycle: 'lifecycle',
  endReason: 'end_reason',
  config: 'config_json',
  seed: 'seed',
  engineVersion: 'engine_version',
  hostSeat: 'host_seat',
  headSeq: 'head_seq',
  roomRev: 'room_rev',
  createdAt: 'created_at',
  startedAt: 'started_at',
  lastLobbyActivityAt: 'last_lobby_activity_at',
  lastActionAt: 'last_action_at',
  allDisconnectedSince: 'all_disconnected_since',
  abandonedAt: 'abandoned_at',
  abandonReason: 'abandon_reason',
  endedAt: 'ended_at',
  activePlayMs: 'active_play_ms',
} as const satisfies Record<keyof GameMetaRow, string>;

interface GameRowDb {
  id: string;
  room_code: string | null;
  lifecycle: GameMetaRow['lifecycle'];
  end_reason: GameMetaRow['endReason'];
  config_json: string;
  seed: string | null;
  engine_version: string | null;
  host_seat: number;
  head_seq: number;
  room_rev: number;
  created_at: number;
  started_at: number | null;
  last_lobby_activity_at: number;
  last_action_at: number | null;
  all_disconnected_since: number | null;
  abandoned_at: number | null;
  abandon_reason: GameMetaRow['abandonReason'];
  ended_at: number | null;
  active_play_ms: number;
}

interface EventRowDb {
  seq: number;
  action_id: string | null;
  payload_hash: string | null;
  actor: string;
  command_json: string;
  hash_after: string;
  committed_at: number;
}

const SHUTDOWN_MARKER_KEY = 'clean_shutdown_at';
const SCHEMA_VERSION_KEY = 'schema_version';

export class SqliteGameStore implements GameStore {
  private readonly db: Database.Database;
  private readonly stmt;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('foreign_keys = ON');
    migrate(this.db);
    this.stmt = {
      insertGame: this.db.prepare(
        `INSERT INTO games (id, room_code, lifecycle, config_json, host_seat, created_at, last_lobby_activity_at)
         VALUES (?, ?, 'lobby', ?, ?, ?, ?)`,
      ),
      upsertSeat: this.db.prepare(
        `INSERT INTO seats (game_id, seat, display_name, token_hash, claimed_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (game_id, seat) DO UPDATE SET display_name = excluded.display_name,
           token_hash = excluded.token_hash, claimed_at = excluded.claimed_at`,
      ),
      deleteSeatByToken: this.db.prepare(`DELETE FROM seats WHERE game_id = ? AND token_hash = ?`),
      insertRevoked: this.db.prepare(
        `INSERT INTO revoked_tokens (token_hash, game_id, revoked_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
      ),
      seatByToken: this.db.prepare(`SELECT game_id, seat, token_hash FROM seats WHERE token_hash = ?`),
      revokedByToken: this.db.prepare(`SELECT game_id, token_hash FROM revoked_tokens WHERE token_hash = ?`),
      insertEvent: this.db.prepare(
        `INSERT INTO events (game_id, seq, action_id, payload_hash, actor, command_json, hash_after, committed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      advanceHead: this.db.prepare(
        `UPDATE games SET head_seq = ?, last_action_at = ? WHERE id = ? AND head_seq = ?`,
      ),
      findCommitted: this.db.prepare(
        `SELECT seq, payload_hash FROM events WHERE game_id = ? AND action_id = ?`,
      ),
      upsertSnapshot: this.db.prepare(
        `INSERT OR REPLACE INTO snapshots (game_id, seq, state_json, state_hash, engine_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ),
      pruneSnapshots: this.db.prepare(
        `DELETE FROM snapshots WHERE game_id = ? AND seq NOT IN
           (SELECT seq FROM snapshots WHERE game_id = ? ORDER BY seq DESC LIMIT ${SNAPSHOTS_KEPT})`,
      ),
      gameById: this.db.prepare(`SELECT * FROM games WHERE id = ?`),
      gameByRoomCode: this.db.prepare(`SELECT * FROM games WHERE room_code = ?`),
      seatsOf: this.db.prepare(`SELECT seat, display_name, claimed_at FROM seats WHERE game_id = ? ORDER BY seat`),
      latestSnapshot: this.db.prepare(
        `SELECT seq, state_json, state_hash, engine_version, created_at FROM snapshots
         WHERE game_id = ? ORDER BY seq DESC LIMIT 1`,
      ),
      eventsAfter: this.db.prepare(
        `SELECT seq, action_id, payload_hash, actor, command_json, hash_after, committed_at FROM events
         WHERE game_id = ? AND seq > ? ORDER BY seq`,
      ),
      getMeta: this.db.prepare(`SELECT value FROM server_meta WHERE key = ?`),
      setMeta: this.db.prepare(
        `INSERT INTO server_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      ),
      deleteMeta: this.db.prepare(`DELETE FROM server_meta WHERE key = ?`),
      purgeEvents: this.db.prepare(`DELETE FROM events WHERE game_id = ?`),
      purgeSnapshots: this.db.prepare(`DELETE FROM snapshots WHERE game_id = ?`),
      purgeSeats: this.db.prepare(`DELETE FROM seats WHERE game_id = ?`),
      purgeRoomCode: this.db.prepare(`UPDATE games SET room_code = NULL WHERE id = ?`),
    };
  }

  createRoom(row: NewRoomRow): void {
    this.stmt.insertGame.run(row.id, row.roomCode, JSON.stringify(row.config), row.hostSeat, row.createdAt, row.createdAt);
  }

  upsertSeat(gameId: string, seat: Seat, name: string, tokenHash: Buffer, at: number): void {
    this.stmt.upsertSeat.run(gameId, seat, name, tokenHash, at);
  }

  renameSeat(gameId: string, seat: Seat, name: string): void {
    this.db.prepare(`UPDATE seats SET display_name = ? WHERE game_id = ? AND seat = ?`).run(name, gameId, seat);
  }

  renumberSeats(gameId: string, order: readonly Seat[]): void {
    if (order.length !== 4 || new Set(order).size !== 4 || order.some((s) => !Number.isInteger(s) || s < 0 || s > 3)) {
      throw new Error('renumberSeats: order must be a permutation of 0..3');
    }
    this.db.transaction(() => {
      const rows = this.db
        .prepare(`SELECT seat, display_name, token_hash, claimed_at FROM seats WHERE game_id = ?`)
        .all(gameId) as { seat: number; display_name: string; token_hash: Buffer; claimed_at: number }[];
      const host = (this.stmt.gameById.get(gameId) as GameRowDb | undefined)?.host_seat;
      this.db.prepare(`DELETE FROM seats WHERE game_id = ?`).run(gameId);
      for (const r of rows) {
        this.stmt.upsertSeat.run(gameId, order.indexOf(r.seat as Seat), r.display_name, r.token_hash, r.claimed_at);
      }
      if (host !== undefined) {
        this.db.prepare(`UPDATE games SET host_seat = ? WHERE id = ?`).run(order.indexOf(host as Seat), gameId);
      }
    })();
  }

  seatTokenHash(gameId: string, seat: Seat): Buffer | null {
    const row = this.db.prepare(`SELECT token_hash FROM seats WHERE game_id = ? AND seat = ?`).get(gameId, seat) as
      | { token_hash: Buffer }
      | undefined;
    return row?.token_hash ?? null;
  }

  revokeToken(gameId: string, tokenHash: Buffer, at: number): void {
    this.db.transaction(() => {
      this.stmt.deleteSeatByToken.run(gameId, tokenHash);
      this.stmt.insertRevoked.run(tokenHash, gameId, at);
    })();
  }

  findSeatByTokenHash(tokenHash: Buffer): { gameId: string; seat: Seat } | { revokedIn: string } | null {
    const seat = this.stmt.seatByToken.get(tokenHash) as { game_id: string; seat: number; token_hash: Buffer } | undefined;
    if (seat && hashesEqual(seat.token_hash, tokenHash)) return { gameId: seat.game_id, seat: seat.seat as Seat };
    const revoked = this.stmt.revokedByToken.get(tokenHash) as { game_id: string; token_hash: Buffer } | undefined;
    if (revoked && hashesEqual(revoked.token_hash, tokenHash)) return { revokedIn: revoked.game_id };
    return null;
  }

  appendEvent(e: NewEvent): void {
    this.db.transaction(() => {
      this.stmt.insertEvent.run(
        e.gameId,
        e.seq,
        e.actionId,
        e.payloadHash,
        e.by === 'system' ? 'system' : String(e.by),
        JSON.stringify(e.command),
        e.hashAfter,
        e.at,
      );
      const advanced = this.stmt.advanceHead.run(e.seq, e.at, e.gameId, e.seq - 1);
      if (advanced.changes !== 1) throw new SeqGapError(e.gameId, e.seq);
    })();
  }

  findCommitted(gameId: string, actionId: string): { seq: number; payloadHash: string } | null {
    const row = this.stmt.findCommitted.get(gameId, actionId) as { seq: number; payload_hash: string | null } | undefined;
    return row ? { seq: row.seq, payloadHash: row.payload_hash ?? '' } : null;
  }

  writeSnapshot(gameId: string, seq: number, stateJson: string, hash: string, engineVersion: string, at: number): void {
    this.db.transaction(() => {
      this.stmt.upsertSnapshot.run(gameId, seq, stateJson, hash, engineVersion, at);
      this.stmt.pruneSnapshots.run(gameId, gameId);
    })();
  }

  loadGame(gameId: string): LoadedGame | null {
    return this.db.transaction((): LoadedGame | null => {
      const game = this.stmt.gameById.get(gameId) as GameRowDb | undefined;
      if (!game) return null;
      const seats = (this.stmt.seatsOf.all(gameId) as { seat: number; display_name: string; claimed_at: number }[]).map(
        (s): SeatRow => ({ seat: s.seat as Seat, displayName: s.display_name, claimedAt: s.claimed_at }),
      );
      const snap = this.stmt.latestSnapshot.get(gameId) as
        | { seq: number; state_json: string; state_hash: string; engine_version: string; created_at: number }
        | undefined;
      const snapshot: SnapshotRow | null = snap
        ? {
            seq: snap.seq,
            stateJson: snap.state_json,
            stateHash: snap.state_hash,
            engineVersion: snap.engine_version,
            createdAt: snap.created_at,
          }
        : null;
      const events = (this.stmt.eventsAfter.all(gameId, snapshot?.seq ?? 0) as EventRowDb[]).map(toStoredEvent);
      return { meta: toMeta(game), seats, snapshot, events };
    })();
  }

  updateMeta(gameId: string, patch: Partial<GameMetaRow>): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if ((IMMUTABLE_META_KEYS as readonly string[]).includes(key)) throw new Error(`updateMeta cannot change ${key}`);
      const column = (META_COLUMNS as Record<string, string>)[key];
      if (column === undefined) throw new Error(`updateMeta: unknown column ${key}`);
      sets.push(`${column} = ?`);
      values.push(key === 'config' ? JSON.stringify(value) : value);
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE games SET ${sets.join(', ')} WHERE id = ?`).run(...values, gameId);
  }

  listGames(lifecycles: readonly Lifecycle[]): readonly GameMetaRow[] {
    if (lifecycles.length === 0) return [];
    const rows = this.db
      .prepare(`SELECT * FROM games WHERE lifecycle IN (${lifecycles.map(() => '?').join(', ')}) ORDER BY created_at, id`)
      .all(...lifecycles) as GameRowDb[];
    return rows.map(toMeta);
  }

  findByRoomCode(code: string): GameMetaRow | null {
    const row = this.stmt.gameByRoomCode.get(code) as GameRowDb | undefined;
    return row ? toMeta(row) : null;
  }

  writeShutdownMarker(at: number): void {
    this.stmt.setMeta.run(SHUTDOWN_MARKER_KEY, String(at));
  }

  takeShutdownMarker(): number | null {
    return this.db.transaction((): number | null => {
      const row = this.stmt.getMeta.get(SHUTDOWN_MARKER_KEY) as { value: string } | undefined;
      if (!row) return null;
      this.stmt.deleteMeta.run(SHUTDOWN_MARKER_KEY);
      return Number(row.value);
    })();
  }

  /**
   * Retention purge (design §4): deletes the game's events, snapshots and seats and nulls its room code. The games
   * row stays for metrics. Used for finished games after finishedRetentionDays and for expired games immediately.
   */
  purgeGame(gameId: string): void {
    this.db.transaction(() => {
      this.stmt.purgeEvents.run(gameId);
      this.stmt.purgeSnapshots.run(gameId);
      this.stmt.purgeSeats.run(gameId);
      this.stmt.purgeRoomCode.run(gameId);
    })();
  }

  /** Runs `fn` in one transaction: every store write inside it commits together or not at all. */
  atomically<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /** Folds the WAL into the main database file (drain step 6). */
  checkpoint(): void {
    this.db.pragma('wal_checkpoint(TRUNCATE)');
  }

  close(): void {
    if (this.db.open) this.db.close();
  }
}

/** Thrown by appendEvent when e.seq is not head_seq + 1 (the commit is rolled back). */
export class SeqGapError extends Error {
  constructor(
    readonly gameId: string,
    readonly seq: number,
  ) {
    super(`appendEvent: seq ${seq} is not head_seq + 1`);
    this.name = 'SeqGapError';
  }
}

export function openGameStore(path: string): SqliteGameStore {
  return new SqliteGameStore(path);
}

function migrate(db: Database.Database): void {
  const hasMeta = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'server_meta'`).get();
  const row = hasMeta
    ? (db.prepare(`SELECT value FROM server_meta WHERE key = ?`).get(SCHEMA_VERSION_KEY) as { value: string } | undefined)
    : undefined;
  let version = row ? Number(row.value) : 0;
  if (version > MIGRATIONS.length) throw new Error(`database schema_version ${version} is newer than this build`);
  for (; version < MIGRATIONS.length; version++) {
    const sql = MIGRATIONS[version] ?? '';
    const next = version + 1;
    db.transaction(() => {
      db.exec(sql);
      db.prepare(`INSERT OR REPLACE INTO server_meta (key, value) VALUES (?, ?)`).run(SCHEMA_VERSION_KEY, String(next));
    })();
  }
}

function hashesEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

function toMeta(r: GameRowDb): GameMetaRow {
  return {
    id: r.id,
    roomCode: r.room_code,
    lifecycle: r.lifecycle,
    endReason: r.end_reason,
    config: JSON.parse(r.config_json) as GameConfig,
    seed: r.seed,
    engineVersion: r.engine_version,
    hostSeat: r.host_seat as Seat,
    headSeq: r.head_seq,
    roomRev: r.room_rev,
    createdAt: r.created_at,
    startedAt: r.started_at,
    lastLobbyActivityAt: r.last_lobby_activity_at,
    lastActionAt: r.last_action_at,
    allDisconnectedSince: r.all_disconnected_since,
    abandonedAt: r.abandoned_at,
    abandonReason: r.abandon_reason,
    endedAt: r.ended_at,
    activePlayMs: r.active_play_ms,
  };
}

function toStoredEvent(r: EventRowDb): StoredEvent {
  return {
    seq: r.seq,
    actionId: r.action_id,
    payloadHash: r.payload_hash,
    by: r.actor === 'system' ? 'system' : (Number(r.actor) as Seat),
    command: JSON.parse(r.command_json) as Command,
    hashAfter: r.hash_after,
    committedAt: r.committed_at,
  };
}
