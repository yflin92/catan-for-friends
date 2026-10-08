// Absent players (design §5.10, ADR-0014; AC28): who the game is waiting on, who can be skipped, the skipAbsent control
// and the turn_timer policy. The engine resolves a skip (skipSeat); this module decides when one may happen.
//
// Presence: a seat is disconnected from the moment no socket holds it (or since the server started, when it has not
// been bound since), and connected while one does. Every change of presence or of the waited-on seats re-sends the room
// view, so waitingOn / skippable stay current; a timer re-sends it again when a waited seat crosses skipAfterSec.
// Timers run on the injectable Scheduler and all stop at drain step 3 (onDrainStop).
import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { eligibleSeats, type GameEvent, type GameState, type Seat } from '@hexlands/engine';
import type { RoomView } from '@hexlands/protocol';
import type { TimerHandle } from './clock';
import type { GameRoom } from './game-room';
import { logEvent, type SkipStep } from './log-events';
import type { RoomManager } from './room-manager';
import type { ServerContext } from './server';
import type { GameMetaRow } from './store/game-store';
import type { CommandResult, Connection, WsGateway } from './ws-gateway';

export interface AbsenceDeps {
  readonly ctx: ServerContext;
  readonly rooms: RoomManager;
  readonly gateway: () => WsGateway;
  /** Re-sends the room view to every socket of the game. */
  readonly broadcastRoom: (gameId: string) => void;
}

/** Phases in which no skip resolves anything: the game stays paused (§5.10). */
const UNSKIPPABLE_PHASES: ReadonlySet<string> = new Set(['setupSettlement', 'setupRoad', 'gameOver']);

export class AbsenceService {
  /** `${gameId}:${seat}` → when the seat last lost its socket. */
  private readonly droppedAt = new Map<string, number>();
  /** gameId → the timer that re-sends the room when the next waited seat crosses skipAfterSec. */
  private readonly thresholdTimers = new Map<string, TimerHandle>();
  /** gameId → the turn_timer and the eligible-seat key it was armed for. */
  private readonly turnTimers = new Map<string, { handle: TimerHandle; key: string }>();
  /** gameId → the eligible-seat key last broadcast, so the room is re-sent only when it changes. */
  private readonly lastWaitKey = new Map<string, string>();
  private stopped = false;
  private readonly startedAt: number;

  constructor(private readonly deps: AbsenceDeps) {
    this.startedAt = deps.ctx.clock.now();
  }

  /** Clears every timer; nothing is armed afterwards (drain step 3). */
  stop(): void {
    this.stopped = true;
    const { clock } = this.deps.ctx;
    for (const h of this.thresholdTimers.values()) clock.clear(h);
    for (const t of this.turnTimers.values()) clock.clear(t.handle);
    this.thresholdTimers.clear();
    this.turnTimers.clear();
  }

  /** A socket was bound to the seat: the seat is connected; the game is re-evaluated. */
  seatBound(gameId: string, seat: Seat): void {
    this.droppedAt.delete(`${gameId}:${seat}`);
    this.refresh(gameId, true);
  }

  /**
   * A seated socket closed. It changes presence only when it held a player's seat of a started game and no socket holds
   * that seat any more (a superseded or removed seat's socket changes nothing).
   */
  seatLeft(gameId: string, seat: Seat): void {
    const room = this.deps.rooms.loaded(gameId);
    if (room === null || seat >= room.state.playerCount) return;
    if (this.deps.gateway().connectionOf(gameId, seat) !== null) return;
    this.droppedAt.set(`${gameId}:${seat}`, this.deps.ctx.clock.now());
    this.refresh(gameId, true);
  }

  /** After a commit: re-sends the room when the waited-on seats changed, and re-arms the timers. */
  committed(gameId: string): void {
    this.refresh(gameId, false);
  }

  /** Seconds since the seat lost its socket; null while it is connected. */
  disconnectedForSec(gameId: string, seat: Seat): number | null {
    if (this.deps.gateway().connectionOf(gameId, seat) !== null) return null;
    const since = this.droppedAt.get(`${gameId}:${seat}`) ?? this.startedAt;
    return Math.max(0, Math.floor((this.deps.ctx.clock.now() - since) / 1000));
  }

  /** RoomView.waitingOn and skippable for a game: empty unless it has a live started room. */
  presence(meta: GameMetaRow): Pick<RoomView, 'waitingOn' | 'skippable'> {
    const room = this.deps.rooms.loaded(meta.id);
    if (room === null || meta.lifecycle === 'lobby') return { waitingOn: [], skippable: [] };
    const waitingOn = eligibleSeats(room.state).map((seat) => ({ seat, disconnectedForSec: this.disconnectedForSec(meta.id, seat) }));
    const policy = meta.config.absencePolicy;
    const skippable =
      policy.mode === 'pause_host_skip' && !UNSKIPPABLE_PHASES.has(room.state.phase.name)
        ? waitingOn.filter((w) => w.disconnectedForSec !== null && w.disconnectedForSec >= policy.skipAfterSec).map((w) => w.seat)
        : [];
    return { waitingOn, skippable };
  }

  /**
   * control skipAbsent{seat} (§5.10), after handleControl's checks (draining, room binding, seated, not expired).
   * Rejections, in order:
   * - the policy is not pause_host_skip, or the game has no started room → rule/skip_not_allowed;
   * - the sender is not the host, and the host is connected or skipBy is host_only → auth/not_host;
   * - the seat is not skippable now (not waited on, connected, or under skipAfterSec) → rule/skip_not_allowed.
   * Otherwise {by:'system', action:{type:'skipSeat', seat, reason:'host'}} is committed through the room's normal path
   * (the engine may still answer skip_not_allowed), seat.skipped is logged, and the committed seq is put on the
   * control message's span.
   */
  skipAbsent(conn: Connection, meta: GameMetaRow, seat: Seat): CommandResult {
    const policy = meta.config.absencePolicy;
    const room = this.deps.rooms.room(meta.id);
    if (policy.mode !== 'pause_host_skip' || typeof room !== 'object') return { result: 'rule', reasonCode: 'skip_not_allowed' };
    const sender = conn.binding?.seat ?? null;
    if (sender !== meta.hostSeat) {
      const hostConnected = this.deps.gateway().connectionOf(meta.id, meta.hostSeat) !== null;
      if (policy.skipBy === 'host_only' || hostConnected) return { result: 'auth', reasonCode: 'not_host' };
    }
    if (!this.presence(meta).skippable.includes(seat)) return { result: 'rule', reasonCode: 'skip_not_allowed' };
    const res = this.commitSkip(room, meta.id, seat, 'host');
    if (res.seq !== undefined) trace.getActiveSpan()?.setAttribute('catan.seq', res.seq);
    return res;
  }

  /** Re-sends the room when needed and re-arms the threshold and turn timers of one game. */
  private refresh(gameId: string, presenceChanged: boolean): void {
    // A closed store (a timer that outlived its server) re-evaluates nothing.
    if (this.stopped || this.deps.rooms.draining || !this.deps.ctx.store.isOpen) return;
    const meta = this.deps.ctx.store.findGame(gameId);
    const room = this.deps.rooms.loaded(gameId);
    if (meta === null || room === null || meta.lifecycle !== 'active') {
      this.clearTimers(gameId);
      return;
    }
    const key = waitKey(room.state);
    if (presenceChanged || this.lastWaitKey.get(gameId) !== key) {
      this.lastWaitKey.set(gameId, key);
      this.deps.broadcastRoom(gameId);
    }
    this.armThreshold(meta, room);
    this.armTurnTimer(meta, room, key);
  }

  /** Under pause_host_skip, wakes when the next disconnected waited seat crosses skipAfterSec and re-sends the room. */
  private armThreshold(meta: GameMetaRow, room: GameRoom): void {
    const { clock } = this.deps.ctx;
    const old = this.thresholdTimers.get(meta.id);
    if (old !== undefined) clock.clear(old);
    this.thresholdTimers.delete(meta.id);
    const policy = meta.config.absencePolicy;
    if (policy.mode !== 'pause_host_skip' || UNSKIPPABLE_PHASES.has(room.state.phase.name)) return;
    const waits = eligibleSeats(room.state)
      .map((seat) => this.disconnectedMs(meta.id, seat))
      .filter((ms): ms is number => ms !== null && ms < policy.skipAfterSec * 1000);
    if (waits.length === 0) return;
    const delay = policy.skipAfterSec * 1000 - Math.max(...waits);
    this.thresholdTimers.set(
      meta.id,
      clock.setTimeout(() => {
        this.thresholdTimers.delete(meta.id);
        this.refresh(meta.id, true);
      }, delay),
    );
  }

  /**
   * Under turn_timer, skips every seat the game is waiting on once turnTimerSec has passed with no change of the
   * waited-on seats (reason 'timer'). Any commit that changes them re-arms the timer.
   */
  private armTurnTimer(meta: GameMetaRow, room: GameRoom, key: string): void {
    const { clock } = this.deps.ctx;
    const policy = meta.config.absencePolicy;
    const current = this.turnTimers.get(meta.id);
    if (policy.mode !== 'turn_timer' || policy.turnTimerSec === null || UNSKIPPABLE_PHASES.has(room.state.phase.name)) {
      if (current) clock.clear(current.handle);
      this.turnTimers.delete(meta.id);
      return;
    }
    if (current?.key === key) return;
    if (current) clock.clear(current.handle);
    const handle = clock.setTimeout(() => this.turnTimerFired(meta.id, key), policy.turnTimerSec * 1000);
    this.turnTimers.set(meta.id, { handle, key });
  }

  private turnTimerFired(gameId: string, key: string): void {
    this.turnTimers.delete(gameId);
    if (this.stopped || this.deps.rooms.draining) return;
    const room = this.deps.rooms.loaded(gameId);
    if (room === null || waitKey(room.state) !== key) return;
    for (const seat of eligibleSeats(room.state)) {
      if (!eligibleSeats(room.state).includes(seat)) continue;
      this.deps.ctx.telemetry.tracer.startActiveSpan('catan.action', { kind: SpanKind.INTERNAL }, (span) => {
        span.setAttributes({ 'catan.action.type': 'skipSeat', 'catan.action.group': 'system', 'catan.game.id': gameId, 'catan.seat': seat });
        let res: CommandResult = { result: 'error', reasonCode: 'internal_error' };
        try {
          res = this.commitSkip(room, gameId, seat, 'timer');
        } finally {
          span.setAttribute('catan.result', res.result);
          if (res.reasonCode !== undefined) span.setAttribute('catan.reason_code', res.reasonCode);
          if (res.seq !== undefined) span.setAttribute('catan.seq', res.seq);
          if (res.reasonCode === 'internal_error') span.setStatus({ code: SpanStatusCode.ERROR });
          span.end();
        }
      });
    }
  }

  /** Commits one skip through the room and logs seat.skipped (its single emit site) when it lands. */
  private commitSkip(room: GameRoom, gameId: string, seat: Seat, reason: 'host' | 'timer'): CommandResult {
    const before = room.state;
    const logBefore = before.logCounter;
    const res = room.commit({ by: 'system', action: { type: 'skipSeat', seat, reason } }, null, null, {
      reduceMs: 0,
      persistMs: 0,
      broadcastMs: 0,
    });
    if (res.result === 'ok') {
      const events = room.state.log.filter((e) => e.n > logBefore).map((e) => e.event);
      logEvent(this.deps.ctx.telemetry, 'seat.skipped', {
        game_id: gameId,
        seat,
        reason,
        was_active: before.turn.active === seat,
        resolved: resolvedSteps(before, seat, events),
      });
    }
    return res;
  }

  private disconnectedMs(gameId: string, seat: Seat): number | null {
    if (this.deps.gateway().connectionOf(gameId, seat) !== null) return null;
    return Math.max(0, this.deps.ctx.clock.now() - (this.droppedAt.get(`${gameId}:${seat}`) ?? this.startedAt));
  }

  private clearTimers(gameId: string): void {
    const { clock } = this.deps.ctx;
    const t = this.thresholdTimers.get(gameId);
    if (t !== undefined) clock.clear(t);
    const u = this.turnTimers.get(gameId);
    if (u) clock.clear(u.handle);
    this.thresholdTimers.delete(gameId);
    this.turnTimers.delete(gameId);
  }
}

/** Identifies "who the game is waiting on, in which turn and phase": a change re-sends the room and re-arms the timer. */
function waitKey(state: GameState): string {
  return `${state.turn.number}:${state.phase.name}:${eligibleSeats(state).join(',')}`;
}

/** seat.skipped.resolved: what the skip did, in order (design §9.5). */
function resolvedSteps(before: GameState, seat: Seat, events: readonly GameEvent[]): SkipStep[] {
  const out: SkipStep[] = [];
  const add = (s: SkipStep) => {
    if (!out.includes(s)) out.push(s);
  };
  if (before.phase.name === 'roadBuilding' && before.turn.active === seat) add('road_building_forfeit');
  for (const e of events) {
    if (e.kind === 'discarded' && e.auto) add('discard');
    else if (e.kind === 'diceRolled' && e.auto) add('roll');
    else if (e.kind === 'robberMoved' && e.auto) add('robber');
    else if (e.kind === 'turnEnded' && e.reason === 'skipped') add('turn_end');
  }
  return out;
}
