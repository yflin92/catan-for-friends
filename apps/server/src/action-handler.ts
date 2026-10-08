// The `action` message handler (design §5.2, §9.3): routes a seat's action to its game's commit path. The gateway opens
// the single catan.action span (kind SERVER, no child spans) around this handler; this adds the action's attributes and
// the reduce/persist/broadcast timings to it.
import { trace, type Span } from '@opentelemetry/api';
import { actionGroup, type Seat } from '@hexlands/engine';
import type { ActionMsg } from '@hexlands/protocol';
import { payloadHashOf, type CommitTimings, type GameRoom } from './game-room';
import type { LifecycleService } from './lifecycle';
import type { RoomManager } from './room-manager';
import type { ServerContext } from './server';
import type { CommandResult, Connection } from './ws-gateway';

export interface ActionDeps {
  readonly ctx: ServerContext;
  readonly rooms: RoomManager;
  readonly lifecycle: LifecycleService;
}

/**
 * Checks, in order: draining → error/server_draining; no room binding → auth/unknown_room; no seat → turn/not_your_turn.
 * Then the lifecycle applies due transitions (design §5.7). The game expired, or lost on restore → rule/game_expired;
 * not started → turn/wrong_phase. A seated action on an abandoned game that restored resumes it (implicit resume) and
 * is then processed normally;
 * an action holding a non-integer number → rule/malformed_action (D14: the canonical payload hash refuses it). Then the
 * room's commit path decides, and a commit that reaches gameOver finishes the game.
 */
export function handleAction(deps: ActionDeps, conn: Connection, msg: ActionMsg): CommandResult {
  const span = trace.getActiveSpan();
  const timings: CommitTimings = { reduceMs: 0, persistMs: 0, broadcastMs: 0 };
  const routed = route(deps, conn, msg, timings, (seqBefore) => {
    if (Number.isInteger(msg.baseSeq)) span?.setAttribute('catan.base_seq_lag', seqBefore - msg.baseSeq);
  });
  if (span !== undefined) annotate(span, msg, routed.seat, routed.room, timings);
  return routed.res;
}

function route(
  deps: ActionDeps,
  conn: Connection,
  msg: ActionMsg,
  timings: CommitTimings,
  onSeq: (seqBefore: number) => void,
): { res: CommandResult; room: GameRoom | null; seat: Seat | null } {
  const none = (res: CommandResult, seat: Seat | null = null) => ({ res, room: null, seat });
  if (deps.rooms.draining) return none({ result: 'error', reasonCode: 'server_draining' });
  const binding = conn.binding;
  if (binding === null) return none({ result: 'auth', reasonCode: 'unknown_room' });
  if (binding.seat === null) return none({ result: 'turn', reasonCode: 'not_your_turn' });
  const meta = deps.lifecycle.current(binding.gameId);
  if (meta?.lifecycle === 'expired') return none({ result: 'rule', reasonCode: 'game_expired' }, binding.seat);
  const found = deps.rooms.room(binding.gameId);
  if (found === 'expired') return none({ result: 'rule', reasonCode: 'game_expired' }, binding.seat);
  if (found === 'unknown') return none({ result: 'auth', reasonCode: 'unknown_room' }, binding.seat);
  if (found === 'not_started') return none({ result: 'turn', reasonCode: 'wrong_phase' }, binding.seat);
  // An abandoned game that restored resumes before the action is processed (implicit resume).
  if (meta?.lifecycle === 'abandoned') deps.lifecycle.contact(binding.gameId, 'action');
  onSeq(found.seq);
  let payloadHash: string;
  try {
    payloadHash = payloadHashOf({ by: binding.seat, action: msg.action });
  } catch {
    return { res: { result: 'rule', reasonCode: 'malformed_action' }, room: found, seat: binding.seat };
  }
  const res = found.submit(binding.seat, msg.actionId, msg.action, payloadHash, timings);
  if (res.result === 'ok') deps.lifecycle.finish(binding.gameId, found);
  return { res, room: found, seat: binding.seat };
}

function annotate(span: Span, msg: ActionMsg, seat: Seat | null, room: GameRoom | null, timings: CommitTimings): void {
  const state = room?.state;
  span.setAttributes({
    'catan.action.type': msg.action.type,
    'catan.action.group': actionGroup(msg.action.type, state?.phase.name ?? null),
    'catan.reduce_ms': timings.reduceMs,
    'catan.persist_ms': timings.persistMs,
    'catan.broadcast_ms': timings.broadcastMs,
  });
  if (seat !== null) span.setAttribute('catan.seat', seat);
  if (room && state) {
    const head = room.head();
    span.setAttributes({
      'catan.seq': head.seq,
      'catan.turn': state.turn.number,
      'catan.phase': state.phase.name,
      'catan.state_hash': head.stateHash,
    });
  }
}
