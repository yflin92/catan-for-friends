// The `control` message handler (design §3.11, §5.7). `resume` is handled here; skipAbsent and relinkSeat are not handled yet.
import type { ControlMsg } from '@hexlands/protocol';
import type { LifecycleService } from './lifecycle';
import type { RoomManager } from './room-manager';
import type { CommandResult, Connection } from './ws-gateway';

export interface ControlDeps {
  readonly rooms: RoomManager;
  readonly lifecycle: LifecycleService;
}

/**
 * Checks, in order: draining → error/server_draining; no room binding → auth/unknown_room; no seat → turn/not_your_turn.
 * Due lifecycle transitions then apply (design §5.7), and an expired game answers rule/game_expired.
 * - `resume` from a seated player restores an abandoned game and resumes it (game.resumed{reason: resume}), answering
 *   ok, or rule/game_expired when the restore fails (lost path); on a game that is not abandoned it changes nothing
 *   and answers ok.
 * - skipAbsent and relinkSeat answer auth/unknown_room.
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
    if (meta.lifecycle !== 'abandoned') return { result: 'ok' };
    // The game is restored first; one that cannot be restored has gone down the lost path (design §5.9).
    if (deps.rooms.room(binding.gameId) === 'expired') return { result: 'rule', reasonCode: 'game_expired' };
    deps.lifecycle.contact(binding.gameId, 'resume');
    return { result: 'ok' };
  }
  // TODO(X-skip): skipAbsent and relinkSeat.
  return { result: 'auth', reasonCode: 'unknown_room' };
}
