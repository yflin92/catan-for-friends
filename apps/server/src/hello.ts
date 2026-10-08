// Hello and authentication (design §5.1(2), ADR-0006; AC26). On any auth failure the socket gets only its outcome and
// a close code: no room or view data. Room codes and seat tokens are never logged.
import type { Seat } from '@hexlands/engine';
import { CloseCode, type HelloMsg } from '@hexlands/protocol';
import { hashSeatToken } from './codes';
import type { RoomManager } from './room-manager';
import { roomView } from './room-view';
import type { ServerContext } from './server';
import type { GameMetaRow } from './store/game-store';
import type { CommandResult, Connection, WsGateway } from './ws-gateway';

/** Room codes are shown as ABC-DEF; separators, spaces and case are ignored. */
export function normalizeRoomCode(raw: string): string {
  return raw.replace(/[\s-]/g, '').toUpperCase();
}

export interface HelloDeps {
  readonly ctx: ServerContext;
  readonly rooms: RoomManager;
  readonly gateway: () => WsGateway;
}

/**
 * A reconnect attempt for catan.ws.reconnects (design §5.5, §9.2): any hello carrying a seat token. lastSeq plays no
 * part (absent is handled like any other value). Visitor hellos are never reconnects.
 */
export function isReconnect(msg: HelloMsg): boolean {
  return msg.seatToken !== undefined;
}

/**
 * Order (design §5.5 step 2): room code → seat token → lifecycle. Each reconnect attempt counts exactly one
 * catan.ws.reconnects outcome: failed_auth, failed_gone or resumed here; failed_error when the handler throws.
 */
export function handleHello(deps: HelloDeps, conn: Connection, msg: HelloMsg): CommandResult {
  const { ctx, rooms } = deps;
  const reconnect = isReconnect(msg);
  const authFail = (reasonCode: 'unknown_room' | 'bad_seat_token' | 'token_room_mismatch' | 'seat_token_revoked'): CommandResult => {
    if (reconnect) countReconnect(ctx, 'failed_auth');
    return { result: 'auth', reasonCode, close: CloseCode.AUTH_FAILED };
  };

  const meta = rooms.findByRoomCode(normalizeRoomCode(msg.roomCode));
  if (!meta) {
    conn.recordFailedRoomCode();
    return authFail('unknown_room');
  }

  let seat: Seat | null = null;
  if (msg.seatToken !== undefined) {
    const found = ctx.store.findSeatByTokenHash(hashSeatToken(msg.seatToken));
    if (found === null) return authFail('bad_seat_token');
    if ('revokedIn' in found) return authFail(found.revokedIn === meta.id ? 'seat_token_revoked' : 'token_room_mismatch');
    if (found.gameId !== meta.id) return authFail('token_room_mismatch');
    seat = found.seat;
  }

  // TODO(S-8): lifecycle.evaluate(meta, now) runs here before the lifecycle is read.
  if (meta.lifecycle === 'expired') {
    if (reconnect) {
      countReconnect(ctx, 'failed_gone');
      ctx.telemetry.log('INFO', 'player.reconnected', { game_id: meta.id, seat, outcome: 'failed_gone' });
    }
    return { result: 'rule', reasonCode: 'game_expired', close: CloseCode.GAME_GONE };
  }

  const gateway = deps.gateway();
  // TODO(S-5): a previous socket on this seat is superseded (message + close 4001).
  gateway.bind(conn, { gameId: meta.id, seat });
  // A seated socket in a started game gets its view; the seq then comes from the live room.
  const live = meta.lifecycle === 'lobby' ? null : rooms.room(meta.id);
  const room = typeof live === 'object' ? live : null;
  conn.send({
    t: 'welcome',
    v: 1,
    seat,
    isHost: seat !== null && seat === meta.hostSeat,
    room: currentRoomView(deps, meta),
    seq: room?.seq ?? meta.headSeq,
    view: room && seat !== null ? room.viewFor(seat) : null,
  });
  if (reconnect) countReconnect(ctx, 'resumed');
  return { result: 'ok' };
}

/** The room view with live presence from the gateway's binding registry. */
export function currentRoomView(deps: HelloDeps, meta: GameMetaRow) {
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
  ctx.telemetry
    .counter('catan.ws.reconnects', {
      description: 'reconnect attempts by outcome',
      labels: { outcome: ['resumed', 'failed_auth', 'failed_gone', 'failed_error'] },
    })
    .add(1, { outcome });
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
