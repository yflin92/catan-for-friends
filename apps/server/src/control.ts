// The `control` message handler (design §3.11, §5.7, §5.1(6), §5.10): `resume`, `relinkSeat` and `skipAbsent`.
import type { ControlMsg } from '@hexlands/protocol';
import type { AbsenceService } from './absence';
import type { LifecycleService } from './lifecycle';
import { relinkSeat } from './relink';
import type { RoomManager } from './room-manager';
import type { ServerContext } from './server';
import type { CommandResult, Connection, WsGateway } from './ws-gateway';

export interface ControlDeps {
  readonly ctx: ServerContext;
  readonly rooms: RoomManager;
  readonly gateway: () => WsGateway;
  readonly lifecycle: LifecycleService;
  readonly absence?: AbsenceService;
}

/**
 * Checks, in order: draining → error/server_draining; no room binding → auth/unknown_room; no seat → turn/not_your_turn.
 * Due lifecycle transitions then apply (design §5.7), and an expired game answers rule/game_expired.
 * - `resume` from a seated player (design D24; never advances seq):
 *   - abandoned → the game is restored and resumed (game.resumed{reason: resume}) → ok, or rule/game_expired when the
 *     restore fails (lost path);
 *   - active or lobby → ok, changing nothing (idempotent);
 *   - finished → rule/game_over; expired → rule/game_expired.
 * - `relinkSeat` (design §5.1(6), Q8): see relinkSeat in relink.ts.
 * - `skipAbsent` (design §5.10): see AbsenceService.skipAbsent.
 */
export function handleControl(deps: ControlDeps, conn: Connection, msg: ControlMsg): CommandResult {
  if (deps.rooms.draining) return { result: 'error', reasonCode: 'server_draining' };
  const binding = conn.binding;
  if (binding === null) return { result: 'auth', reasonCode: 'unknown_room' };
  if (binding.seat === null) return { result: 'turn', reasonCode: 'not_your_turn' };
  const meta = deps.lifecycle.current(binding.gameId);
  if (meta === null) return { result: 'auth', reasonCode: 'unknown_room' };
  if (meta.lifecycle === 'expired') return { result: 'rule', reasonCode: 'game_expired' };
  if (msg.op.kind === 'resume') {
    if (meta.lifecycle === 'finished') return { result: 'rule', reasonCode: 'game_over' };
    if (meta.lifecycle !== 'abandoned') return { result: 'ok' };
    // The game is restored first; one that cannot be restored has gone down the lost path (design §5.9).
    if (deps.rooms.room(binding.gameId) === 'expired') return { result: 'rule', reasonCode: 'game_expired' };
    deps.lifecycle.contact(binding.gameId, 'resume');
    return { result: 'ok' };
  }
  if (msg.op.kind === 'relinkSeat') return relinkSeat(deps, conn, meta, msg.op.seat);
  if (msg.op.kind === 'skipAbsent' && deps.absence) return deps.absence.skipAbsent(conn, meta, msg.op.seat);
  return { result: 'auth', reasonCode: 'unknown_room' };
}
