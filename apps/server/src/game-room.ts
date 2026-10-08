// GameRoom (design §2.3, §5.2; ADR-0004, ADR-0005, ADR-0008): one started game in memory and its synchronous,
// single-writer commit path. GameRoom is the only caller of reduce and GameStore.appendEvent.
//
// Commit path for one command (player or system):
//   reduce → faults.hit(beforePersist) → appendEvent(seq+1) [one transaction] → faults.hit(afterPersistBeforeAck)
//   → swap state, seq++ → snapshot every SNAPSHOT_EVERY commits → broadcast state{seq, view} to every connected seat.
// A rejection changes nothing and is answered to the sender only. view() output shares objects with the state, so a view
// is serialised for its seat immediately and never edited or reused (Conn.send stringifies on the spot).
import { createHash } from 'node:crypto';
import {
  ENGINE_VERSION,
  canonicalJson,
  deserializeState,
  reasonCategory,
  reduce,
  replayFrom,
  serializeState,
  stateHash,
  view,
  type Action,
  type Command,
  type EngineReasonCode,
  type GameState,
  type PlayerView,
  type ReduceResult,
  type Seat,
} from '@hexlands/engine';
import type { ServerContext } from './server';
import type { LoadedGame } from './store/game-store';
import type { CommandResult, Connection, WsGateway } from './ws-gateway';

/** Outcomes remembered per game for actionId replay (design §5.2, DR1). */
export const ACTION_ID_CACHE_SIZE = 512;
/** A snapshot is written after every SNAPSHOT_EVERY-th seq. */
export const SNAPSHOT_EVERY = 25;

export interface RoomDeps {
  readonly ctx: ServerContext;
  readonly gateway: () => WsGateway;
}

/** Timings of one commit, for the catan.action span (milliseconds). */
export interface CommitTimings {
  reduceMs: number;
  persistMs: number;
  broadcastMs: number;
}

interface CachedOutcome {
  /** The seat that sent the actionId; a replay needs the same actor and the same payload hash (D19). */
  readonly actor: Seat;
  readonly payloadHash: string;
  readonly result: CommandResult;
}

/**
 * events.payload_hash (D19): SHA-256 hex of canonicalJson({by, action}), the whole Command, so the actor is bound and the
 * same actionId from another seat never matches. Throws a TypeError when the action holds a non-integer number (D7/D14).
 */
export function payloadHashOf(cmd: { readonly by: Seat; readonly action: Action }): string {
  return createHash('sha256').update(canonicalJson({ by: cmd.by, action: cmd.action }), 'utf8').digest('hex');
}

export class GameRoom {
  private current: GameState;
  private headSeq: number;
  /**
   * actionId → outcome, oldest first; the oldest entry is evicted beyond ACTION_ID_CACHE_SIZE. Only seated actions reach
   * it, so the actor is always a seat. Hello and lobby frames keep no actionId cache; one added for unseated frames must
   * key its actor on the connection (D19).
   */
  private readonly outcomes = new Map<string, CachedOutcome>();

  constructor(
    private readonly deps: RoomDeps,
    readonly gameId: string,
    state: GameState,
    seq: number,
  ) {
    this.current = state;
    this.headSeq = seq;
  }

  /**
   * Rebuilds a room from its latest snapshot plus the events after it. Each replayed event must reproduce its stored
   * hash_after; any mismatch or rejected command throws, since the log no longer matches this engine.
   */
  static restore(deps: RoomDeps, game: LoadedGame): GameRoom {
    if (game.snapshot === null) throw new Error(`game ${game.meta.id} has no snapshot`);
    const parsed = deserializeState(game.snapshot.stateJson);
    if (!parsed.ok) throw new Error(`game ${game.meta.id}: unreadable snapshot (${parsed.error})`);
    const replayed = replayFrom(parsed.state, game.events.map((e) => e.command));
    game.events.forEach((e, i) => {
      if (!replayed.results[i]?.ok || replayed.hashes[i] !== e.hashAfter) {
        throw new Error(`game ${game.meta.id}: event seq ${e.seq} does not replay to its stored hash`);
      }
    });
    const seq = game.events.at(-1)?.seq ?? game.snapshot.seq;
    return new GameRoom(deps, game.meta.id, replayed.state, seq);
  }

  get seq(): number {
    return this.headSeq;
  }

  get state(): GameState {
    return this.current;
  }

  /** {seq, stateHash} of the live state. */
  head(): { readonly seq: number; readonly stateHash: string } {
    return { seq: this.headSeq, stateHash: stateHash(this.current) };
  }

  /** The view of the current state for `seat`. */
  viewFor(seat: Seat): PlayerView {
    return view(this.current, seat);
  }

  /** Sends state{seq, view} to one connection. */
  sendState(conn: Connection, seat: Seat): void {
    conn.send({ t: 'state', seq: this.headSeq, view: this.viewFor(seat) });
  }

  /**
   * Sends state{seq, view(state, p)} to the connection bound to each seat p of this game. A seat whose send throws does
   * not stop the others; the first error is rethrown once every seat has been tried, so the caller reports it once.
   */
  broadcast(): void {
    const gateway = this.deps.gateway();
    let failure: { readonly err: unknown } | null = null;
    for (let seat = 0; seat < this.current.playerCount; seat++) {
      const conn = gateway.connectionOf(this.gameId, seat as Seat);
      try {
        if (conn) this.sendState(conn, seat as Seat);
      } catch (err) {
        failure ??= { err };
      }
    }
    if (failure) throw failure.err;
  }

  /**
   * A seat's action, idempotent per actionId within the game (design §5.2, DR1, D19):
   * - an actionId already answered for the same seat with the same payload gets the ORIGINAL outcome again (seq
   *   unchanged); committed actions are found in the store forever, rejections only while in the in-memory cache;
   * - the same actionId from another seat, or with a different payload → rule/action_id_reused; another seat's outcome
   *   or seq is never returned (the stored payload hash covers `by`);
   * - otherwise the action is validated against the current state and committed if legal.
   */
  submit(seat: Seat, actionId: string, action: Action, payloadHash: string, timings: CommitTimings): CommandResult {
    const cached = this.outcomes.get(actionId) ?? this.committedOutcome(actionId, seat);
    if (cached) {
      const same = cached.actor === seat && cached.payloadHash === payloadHash;
      return same ? cached.result : { result: 'rule', reasonCode: 'action_id_reused' };
    }
    const result = this.commit({ by: seat, action }, actionId, payloadHash, timings);
    // Persist and broadcast faults are not cached: a resend re-checks the store and the current state.
    if (result.reasonCode !== 'internal_error') this.remember(actionId, { actor: seat, payloadHash, result });
    return result;
  }

  /**
   * Validates and commits one command. Returns the outcome for its sender:
   * - rejected by the engine → {rule|turn, code}; nothing is persisted or broadcast;
   * - engine internal_error, or reduce or the next state's hash throwing → error/internal_error with the state NOT
   *   swapped, catan.errors{component=engine} and an action.error log line;
   * - a fault or appendEvent failure before the commit → error/internal_error with the state NOT swapped;
   * - a fault after the commit → the command stays committed (state swapped and broadcast) but the sender gets
   *   error/internal_error, as if the ack were lost; a resend with the same actionId then gets ok and the original seq;
   * - the broadcast throwing → the same, counted as catan.errors{component=engine} with an action.error log line;
   * - committed → {ok, seq}.
   */
  commit(cmd: Command, actionId: string | null, payloadHash: string | null, timings: CommitTimings): CommandResult {
    const { ctx } = this.deps;
    const t0 = performance.now();
    let res: ReduceResult;
    let hashAfter: string;
    try {
      res = reduce(this.current, cmd);
      // A next state that cannot be hashed (canonicalJson refuses it) is an engine fault, caught here before the commit.
      hashAfter = res.ok ? stateHash(res.state) : '';
    } catch {
      timings.reduceMs = performance.now() - t0;
      this.fault('engine', this.headSeq);
      return { result: 'error', reasonCode: 'internal_error' };
    }
    timings.reduceMs = performance.now() - t0;
    if (!res.ok) {
      if (res.reason === 'internal_error') this.fault('engine', this.headSeq);
      return rejection(res.reason);
    }

    const seq = this.headSeq + 1;
    const t1 = performance.now();
    try {
      ctx.faults.hit('beforePersist', { gameId: this.gameId, seq });
      ctx.store.appendEvent({
        gameId: this.gameId,
        seq,
        actionId,
        payloadHash,
        by: cmd.by,
        command: cmd,
        hashAfter,
        at: ctx.clock.now(),
      });
    } catch {
      timings.persistMs = performance.now() - t1;
      this.fault('persist', seq);
      return { result: 'error', reasonCode: 'internal_error' };
    }

    let ackLost = false;
    try {
      ctx.faults.hit('afterPersistBeforeAck', { gameId: this.gameId, seq });
    } catch {
      ackLost = true;
    }
    timings.persistMs = performance.now() - t1;

    this.current = res.state;
    this.headSeq = seq;
    if (actionId !== null && payloadHash !== null && cmd.by !== 'system') {
      this.remember(actionId, { actor: cmd.by, payloadHash, result: { result: 'ok', seq } });
    }
    if (seq % SNAPSHOT_EVERY === 0) this.snapshot(seq, hashAfter);

    const t2 = performance.now();
    let broadcastFailed = false;
    try {
      this.broadcast();
    } catch {
      broadcastFailed = true;
    }
    timings.broadcastMs = performance.now() - t2;

    if (ackLost) {
      this.fault('persist', seq);
      return { result: 'error', reasonCode: 'internal_error' };
    }
    if (broadcastFailed) {
      this.fault('engine', seq);
      return { result: 'error', reasonCode: 'internal_error' };
    }
    return { result: 'ok', seq };
  }

  /** Writes the snapshot at seq. A failure is logged and counted; the commit itself already stands. */
  private snapshot(seq: number, hash: string): void {
    const { ctx } = this.deps;
    try {
      ctx.faults.hit('beforeSnapshot', { gameId: this.gameId, seq });
      ctx.store.writeSnapshot(this.gameId, seq, serializeState(this.current), hash, ENGINE_VERSION, ctx.clock.now());
    } catch {
      this.fault('persist', seq);
    }
  }

  /** A committed actionId from the store. Its hash covers `by`, so a match with `seat`'s hash means the same actor. */
  private committedOutcome(actionId: string, seat: Seat): CachedOutcome | null {
    const found = this.deps.ctx.store.findCommitted(this.gameId, actionId);
    return found ? { actor: seat, payloadHash: found.payloadHash, result: { result: 'ok', seq: found.seq } } : null;
  }

  private remember(actionId: string, outcome: CachedOutcome): void {
    this.outcomes.delete(actionId);
    this.outcomes.set(actionId, outcome);
    if (this.outcomes.size > ACTION_ID_CACHE_SIZE) this.outcomes.delete(this.outcomes.keys().next().value!);
  }

  /** catan.errors{component} plus an action.error log line with the identifiers needed to reproduce it. */
  private fault(component: 'engine' | 'persist', seq: number): void {
    const { telemetry } = this.deps.ctx;
    errorsCounter(this.deps.ctx).add(1, { component });
    telemetry.log('ERROR', 'action.error', { game_id: this.gameId, seq, component, state_hash: stateHash(this.current) });
  }
}

function rejection(reason: EngineReasonCode): CommandResult {
  return { result: reasonCategory(reason), reasonCode: reason };
}

/** An error that has already been counted in catan.errors and logged; the gateway's handlerError does not count it again. */
export class ReportedFault extends Error {
  constructor() {
    super('fault already reported');
    this.name = 'ReportedFault';
  }
}

export function errorsCounter(ctx: ServerContext) {
  return ctx.telemetry.counter('catan.errors', {
    description: 'unhandled exceptions and faults by component',
    labels: { component: ['ws', 'engine', 'persist', 'http', 'job', 'telemetry'] },
  });
}
