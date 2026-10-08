// The `action` message handler (design §5.2, §9.3): routes a seat's action to its game's commit path inside exactly
// one catan.action span (kind SERVER, no child spans) that carries the reduce/persist/broadcast timings.
import { SpanKind, type Span } from '@opentelemetry/api';
import { actionGroup, type Seat } from '@hexlands/engine';
import type { ActionMsg } from '@hexlands/protocol';
import { payloadHashOf, type CommitTimings, type GameRoom } from './game-room';
import type { RoomManager } from './room-manager';
import type { ServerContext } from './server';
import type { CommandResult, Connection } from './ws-gateway';

export interface ActionDeps {
  readonly ctx: ServerContext;
  readonly rooms: RoomManager;
}

/**
 * Checks, in order: draining → error/server_draining; no room binding → auth/unknown_room; no seat → turn/not_your_turn;
 * the game expired → rule/game_expired; not started → turn/wrong_phase; an action holding a non-integer number →
 * rule/malformed_action (D14: the canonical payload hash refuses it). Then the room's commit path decides.
 */
export function handleAction(deps: ActionDeps, conn: Connection, msg: ActionMsg): CommandResult {
  return deps.ctx.telemetry.tracer.startActiveSpan('catan.action', { kind: SpanKind.SERVER }, (span) => {
    const timings: CommitTimings = { reduceMs: 0, persistMs: 0, broadcastMs: 0 };
    try {
      const routed = route(deps, conn, msg, timings, (seqBefore) => {
        if (Number.isInteger(msg.baseSeq)) span.setAttribute('catan.base_seq_lag', seqBefore - msg.baseSeq);
      });
      annotate(span, msg, conn, routed.seat, routed.room, routed.res, timings);
      return routed.res;
    } finally {
      span.end();
    }
  });
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
  const found = deps.rooms.room(binding.gameId);
  if (found === 'expired') return none({ result: 'rule', reasonCode: 'game_expired' }, binding.seat);
  if (found === 'unknown') return none({ result: 'auth', reasonCode: 'unknown_room' }, binding.seat);
  if (found === 'not_started') return none({ result: 'turn', reasonCode: 'wrong_phase' }, binding.seat);
  // TODO(S-8): lifecycle.evaluate(game, now) runs here (an action on an abandoned game resumes it).
  onSeq(found.seq);
  let payloadHash: string;
  try {
    payloadHash = payloadHashOf(msg.action);
  } catch {
    return { res: { result: 'rule', reasonCode: 'malformed_action' }, room: found, seat: binding.seat };
  }
  return { res: found.submit(binding.seat, msg.actionId, msg.action, payloadHash, timings), room: found, seat: binding.seat };
}

function annotate(
  span: Span,
  msg: ActionMsg,
  conn: Connection,
  seat: Seat | null,
  room: GameRoom | null,
  res: CommandResult,
  timings: CommitTimings,
): void {
  const state = room?.state;
  span.setAttributes({
    'catan.action.type': msg.action.type,
    'catan.action.group': actionGroup(msg.action.type, state?.phase.name ?? null),
    'catan.result': res.result,
    'catan.action_id': msg.actionId,
    'catan.reduce_ms': timings.reduceMs,
    'catan.persist_ms': timings.persistMs,
    'catan.broadcast_ms': timings.broadcastMs,
  });
  if (res.reasonCode !== undefined) span.setAttribute('catan.reason_code', res.reasonCode);
  const gameId = conn.binding?.gameId;
  if (gameId !== undefined) span.setAttribute('catan.game.id', gameId);
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
