// Persistence interface (design §3.12, §4; ADR-0005). Synchronous so the commit path never awaits between reduce and
// commit. Row types mirror the §4 columns in camelCase.
import type { Command, GameConfig, Seat } from '@hexlands/engine';

export type Lifecycle = 'lobby' | 'active' | 'abandoned' | 'finished' | 'expired';
export type EndReason = 'won' | 'abandoned_expired' | 'lobby_expired' | 'lost';
export type AbandonReason = 'inactivity' | 'all_disconnected';

/** One `games` row. Times are epoch ms from the injectable Clock. */
export interface GameMetaRow {
  readonly id: string;
  /** Secret; never logged. null once the game is purged. */
  readonly roomCode: string | null;
  readonly lifecycle: Lifecycle;
  readonly endReason: EndReason | null;
  readonly config: GameConfig;
  /** Set at start; secret while the game is live. */
  readonly seed: string | null;
  readonly engineVersion: string | null;
  readonly hostSeat: Seat;
  readonly headSeq: number;
  readonly roomRev: number;
  readonly createdAt: number;
  readonly startedAt: number | null;
  readonly lastLobbyActivityAt: number;
  /** Last committed command, or the resume time. */
  readonly lastActionAt: number | null;
  /** null while ≥ 1 seat is connected. */
  readonly allDisconnectedSince: number | null;
  readonly abandonedAt: number | null;
  readonly abandonReason: AbandonReason | null;
  readonly endedAt: number | null;
  readonly activePlayMs: number;
}

/** A new lobby: lifecycle 'lobby', head_seq 0, room_rev 0, last_lobby_activity_at = createdAt. */
export interface NewRoomRow {
  readonly id: string;
  readonly roomCode: string;
  readonly config: GameConfig;
  readonly hostSeat: Seat;
  readonly createdAt: number;
}

/** Columns updateMeta refuses to change: the identity, the creation time, and head_seq (owned by appendEvent). */
export const IMMUTABLE_META_KEYS = ['id', 'createdAt', 'headSeq'] as const;

export interface SeatRow {
  readonly seat: Seat;
  readonly displayName: string;
  readonly claimedAt: number;
}

export interface NewEvent {
  readonly gameId: string;
  readonly seq: number;
  /** null for system commands. */
  readonly actionId: string | null;
  /** SHA-256 of the canonical action JSON; null for system commands. */
  readonly payloadHash: string | null;
  readonly by: Seat | 'system';
  readonly command: Command;
  readonly hashAfter: string;
  readonly at: number;
}

export interface StoredEvent {
  readonly seq: number;
  readonly actionId: string | null;
  readonly payloadHash: string | null;
  readonly by: Seat | 'system';
  readonly command: Command;
  readonly hashAfter: string;
  readonly committedAt: number;
}

export interface SnapshotRow {
  readonly seq: number;
  readonly stateJson: string;
  readonly stateHash: string;
  readonly engineVersion: string;
  readonly createdAt: number;
}

/** Everything needed to restore a game: the latest snapshot plus the events after it, in seq order. */
export interface LoadedGame {
  readonly meta: GameMetaRow;
  readonly seats: readonly SeatRow[];
  readonly snapshot: SnapshotRow | null;
  readonly events: readonly StoredEvent[];
}

export interface GameStore {
  createRoom(row: NewRoomRow): void;
  /** Inserts or replaces the seat's row (name, token hash, claim time). */
  upsertSeat(gameId: string, seat: Seat, name: string, tokenHash: Buffer, at: number): void;
  /** Changes a seat's display name only. */
  renameSeat(gameId: string, seat: Seat, name: string): void;
  /**
   * Renumbers seats in ONE transaction (design D9): the occupant (name, token hash, claim time) of old index order[i]
   * moves to index i, and host_seat follows the host. Never revokes a token. `order` is a permutation of 0..3.
   */
  renumberSeats(gameId: string, order: readonly Seat[]): void;
  /** The token hash held by a seat, or null when the seat is empty. */
  seatTokenHash(gameId: string, seat: Seat): Buffer | null;
  /** Frees the seat that holds tokenHash (if any) and records the hash as revoked for this game. */
  revokeToken(gameId: string, tokenHash: Buffer, at: number): void;
  /** Seat holding the token, else the game that revoked it, else null. */
  findSeatByTokenHash(tokenHash: Buffer): { gameId: string; seat: Seat } | { revokedIn: string } | null;
  /**
   * Commits one command: the events INSERT plus games.head_seq/last_action_at in ONE transaction. Throws (and commits
   * nothing) unless e.seq = head_seq + 1, or when (gameId, actionId) is already committed.
   */
  appendEvent(e: NewEvent): void;
  findCommitted(gameId: string, actionId: string): { seq: number; payloadHash: string } | null;
  /** Writes (or replaces) the snapshot at seq and keeps only the latest 2 per game. */
  writeSnapshot(gameId: string, seq: number, stateJson: string, hash: string, engineVersion: string, at: number): void;
  loadGame(gameId: string): LoadedGame | null;
  /** Throws if the patch names an IMMUTABLE_META_KEYS column. */
  updateMeta(gameId: string, patch: Partial<GameMetaRow>): void;
  listGames(lifecycles: readonly Lifecycle[]): readonly GameMetaRow[];
  findByRoomCode(code: string): GameMetaRow | null;
  writeShutdownMarker(at: number): void;
  /** Reads and clears the clean-shutdown marker. */
  takeShutdownMarker(): number | null;
  close(): void;
}
