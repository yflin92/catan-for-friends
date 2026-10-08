// Hello and authentication (design §5.1(2), ADR-0006; AC26). On any auth failure the socket gets only its outcome and
// a close code: no room or view data. Room codes and seat tokens are never logged.
import type { Seat } from '@hexlands/engine';
import { CloseCode, type HelloMsg } from '@hexlands/protocol';
import { hashRoomCode, hashSeatToken } from './codes';
import type { LifecycleService } from './lifecycle';
import { serverMetrics } from './metrics';
import type { RoomManager } from './room-manager';
import { roomView } from './room-view';
import type { ServerContext } from './server';
import type { GameMetaRow } from './store/game-store';
import type { CommandResult, Connection, DisconnectInfo, WsGateway } from './ws-gateway';

/** Room codes are shown as ABC-DEF; separators, spaces and case are ignored. */
export function normalizeRoomCode(raw: string): string {
  return raw.replace(/[\s-]/g, '').toUpperCase();
}

export interface HelloDeps {
  readonly ctx: ServerContext;
  readonly rooms: RoomManager;
  readonly gateway: () => WsGateway;
  readonly lifecycle: LifecycleService;
  /** When each `${gameId}:${seat}` last lost its socket; feeds player.reconnected gap_s. */
  readonly seatDrops?: Map<string, number>;
}

/**
 * A reconnect attempt for catan.ws.reconnects (design §5.5, §9.2): any hello carrying a seat token. lastSeq plays no
 * part (absent is handled like any other value). Visitor hellos are never reconnects.
 */
export function isReconnect(msg: HelloMsg): boolean {
  return msg.seatToken !== undefined;
}

/**
 * Hello precedence (design §5.1(2), D21):
 * 1. schema → rule/malformed_action, socket left open (the gateway);
 * 2. client key over rooms.failedCodeAttemptsPerIpPerMin → auth/rate_limited_auth (the gateway);
 * 3. room code unknown, or purged with no open tombstone → auth/unknown_room + close 4401, counted toward that limit.
 *    A code matching an open tombstone (D26) passes this step and is not counted;
 * 4. seat token, when present: token_room_mismatch → seat_token_revoked → bad_seat_token, each + close 4401 with no
 *    room or view data (AC26). For a tombstone the seat-token hashes kept in tombstone_tokens are consulted;
 * 5. lifecycle: expired, a tombstone, or a started game that cannot be restored (lost) → rule/game_expired + close 4410;
 * 6. bind → welcome.
 * Each reconnect attempt counts at most one catan.ws.reconnects outcome: failed_auth (3, 4), failed_gone (5), resumed
 * (6, only when the seat had been bound to a socket before: a first bind counts nothing), failed_error when the handler
 * throws.
 */
export function handleHello(deps: HelloDeps, conn: Connection, msg: HelloMsg): CommandResult {
  const { ctx, rooms } = deps;
  const reconnect = isReconnect(msg);
  const authFail = (reasonCode: 'unknown_room' | 'bad_seat_token' | 'token_room_mismatch' | 'seat_token_revoked'): CommandResult => {
    if (reconnect) countReconnect(ctx, 'failed_auth');
    return { result: 'auth', reasonCode, close: CloseCode.AUTH_FAILED };
  };
  const gone = (gameId: string, seat: Seat | null): CommandResult => {
    if (reconnect) {
      countReconnect(ctx, 'failed_gone');
      ctx.telemetry.log('INFO', 'player.reconnected', { game_id: gameId, seat, outcome: 'failed_gone' });
    }
    return { result: 'rule', reasonCode: 'game_expired', close: CloseCode.GAME_GONE };
  };

  const code = normalizeRoomCode(msg.roomCode);
  const row = rooms.findByRoomCode(code);
  if (!row) {
    const tombstone = ctx.store.findTombstone(hashRoomCode(code), ctx.clock.now());
    if (tombstone === null) {
      conn.recordFailedRoomCode();
      return authFail('unknown_room');
    }
    if (msg.seatToken !== undefined) {
      const tokenHash = hashSeatToken(msg.seatToken);
      const found = ctx.store.findSeatByTokenHash(tokenHash);
      if (found !== null) {
        return authFail('revokedIn' in found && found.revokedIn === tombstone.gameId ? 'seat_token_revoked' : 'token_room_mismatch');
      }
      const owner = ctx.store.tombstoneOfToken(tokenHash);
      if (owner === null) return authFail('bad_seat_token');
      if (owner !== tombstone.gameId) return authFail('token_room_mismatch');
    }
    return gone(tombstone.gameId, null);
  }

  let seat: Seat | null = null;
  if (msg.seatToken !== undefined) {
    const found = ctx.store.findSeatByTokenHash(hashSeatToken(msg.seatToken));
    if (found === null) return authFail('bad_seat_token');
    if ('revokedIn' in found) return authFail(found.revokedIn === row.id ? 'seat_token_revoked' : 'token_room_mismatch');
    if (found.gameId !== row.id) return authFail('token_room_mismatch');
    seat = found.seat;
  }

  // Due lifecycle transitions apply before the lifecycle is read (design §5.7).
  let meta = deps.lifecycle.refresh(row);
  // A started game is loaded now; one that cannot be restored has just gone down the lost path (design §5.9).
  const live = meta.lifecycle === 'lobby' || meta.lifecycle === 'expired' ? null : rooms.room(meta.id);
  if (meta.lifecycle === 'expired' || live === 'expired') return gone(meta.id, seat);
  // A seated hello on an abandoned game that restored resumes it (reason rejoin).
  if (seat !== null && meta.lifecycle === 'abandoned') meta = deps.lifecycle.contact(meta.id, 'rejoin') ?? meta;
  const room = typeof live === 'object' ? live : null;

  const gateway = deps.gateway();
  const previous = gateway.bind(conn, { gameId: meta.id, seat });
  // P6: the older socket on this seat is told, then closed 4001; game state is untouched.
  if (previous) {
    previous.send({ t: 'superseded' });
    previous.close(CloseCode.SUPERSEDED, 'superseded');
  }
  if (seat !== null) seatReconnected(deps, meta, seat, previous !== null, msg.lastSeq);
  if (seat !== null) deps.lifecycle.presenceChanged(meta.id);
  // A seated socket in a started game gets its view; the seq then comes from the live room.
  conn.send({
    t: 'welcome',
    v: 1,
    seat,
    isHost: seat !== null && seat === meta.hostSeat,
    room: currentRoomView(deps, meta),
    seq: room?.seq ?? meta.headSeq,
    view: room && seat !== null ? room.viewFor(seat) : null,
  });
  // D21: the first bind of a seat is not a reconnect; first_bound_at is persisted, so this holds across restarts.
  const firstBind = seat !== null && ctx.store.markSeatBound(meta.id, seat, ctx.clock.now());
  if (reconnect && !firstBind) countReconnect(ctx, 'resumed');
  return { result: 'ok' };
}

/** player.reconnected for a seat that dropped earlier or is switching devices (design §9.5). */
function seatReconnected(deps: HelloDeps, meta: GameMetaRow, seat: Seat, superseding: boolean, lastSeq: number | undefined): void {
  const key = `${meta.id}:${seat}`;
  const droppedAt = deps.seatDrops?.get(key);
  if (droppedAt === undefined && !superseding) return;
  deps.seatDrops?.delete(key);
  const now = deps.ctx.clock.now();
  deps.ctx.telemetry.log('INFO', 'player.reconnected', {
    game_id: meta.id,
    seat,
    outcome: 'resumed',
    gap_s: droppedAt === undefined ? 0 : Math.max(0, Math.round((now - droppedAt) / 1000)),
    seq_behind: Math.max(0, meta.headSeq - (lastSeq ?? meta.headSeq)),
  });
}

/** player.disconnected for a seated socket (design §9.4, §9.5); remembers the drop for player.reconnected. */
export function seatDisconnected(deps: HelloDeps, info: DisconnectInfo): void {
  const b = info.binding;
  if (b === null || b.seat === null) return;
  // A drop counts only when no socket holds the seat any more: a superseded socket's seat already has its successor.
  if (deps.gateway().connectionOf(b.gameId, b.seat) === null) deps.seatDrops?.set(`${b.gameId}:${b.seat}`, deps.ctx.clock.now());
  deps.ctx.telemetry.log('INFO', 'player.disconnected', {
    game_id: b.gameId,
    seat: b.seat,
    reason: info.reason,
    ...(info.cause !== undefined ? { cause: info.cause } : {}),
    connected_s: Math.round(info.connectedMs / 1000),
  });
}

/** The room view with live presence from the gateway's binding registry. */
export function currentRoomView(deps: Pick<HelloDeps, 'ctx' | 'gateway'>, meta: GameMetaRow) {
  const game = deps.ctx.store.loadGame(meta.id);
  const gateway = deps.gateway();
  return roomView(meta, game?.seats ?? [], { connected: (s) => gateway.connectionOf(meta.id, s) !== null }, deps.ctx.buildVersion);
}

/** Host-only guard shared by lobby ops and controls: null when allowed, else the auth/not_host result. */
export function requireHost(conn: Connection, meta: GameMetaRow): CommandResult | null {
  const b = conn.binding;
  if (b !== null && b.gameId === meta.id && b.seat !== null && b.seat === meta.hostSeat) return null;
  return { result: 'auth', reasonCode: 'not_host' };
}

/** catan.ws.reconnects{outcome} (design §5.5, §9.2). */
export function countReconnect(ctx: ServerContext, outcome: 'resumed' | 'failed_auth' | 'failed_gone' | 'failed_error'): void {
  serverMetrics(ctx.telemetry).wsReconnects.add(1, { outcome });
}

/**
 * resync (design §5.5): sends state{seq: head, view} to this socket only. Only a seated socket of a started game gets
 * one; anything else is ignored. Server state never changes.
 */
export function handleResync(deps: HelloDeps, conn: Connection): void {
  const b = conn.binding;
  if (b === null || b.seat === null) return;
  const room = deps.rooms.room(b.gameId);
  if (typeof room === 'object') room.sendState(conn, b.seat);
}
