// Game lifecycle (design §5.7, §4 retention, §9.2, §9.5; ADR-0007): the pure evaluate() transition function, the
// LifecycleService that applies transitions (the only writer of games.lifecycle after a game starts), and the periodic
// AbandonmentJob. Every threshold comes from the game row's frozen LifecycleConfig; every time from the injected Clock.
import { SpanStatusCode } from '@opentelemetry/api';
import { victoryPoints, type GameState, type LifecycleConfig, type Seat } from '@hexlands/engine';
import type { TimerHandle } from './clock';
import type { GameRoom } from './game-room';
import { broadcastRoom } from './lobby';
import { gameEnded, logEvent, type LogEventFields } from './log-events';
import { CATALOGUE, registerGauge, serverMetrics, type TransitionEdge } from './metrics';
import type { RoomManager } from './room-manager';
import type { ServerContext } from './server';
import type { AbandonReason, GameMetaRow, Lifecycle } from './store/game-store';
import type { WsGateway } from './ws-gateway';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** A due lifecycle transition found by evaluate(). */
export type Transition =
  | { readonly from: 'lobby'; readonly to: 'expired' }
  | { readonly from: 'active'; readonly to: 'abandoned'; readonly reason: AbandonReason }
  | { readonly from: 'abandoned'; readonly to: 'expired' };

/** Why an abandoned game resumed (game.resumed.reason). */
export type ResumeReason = 'rejoin' | 'resume' | 'action';

type EvaluatedFields = Pick<
  GameMetaRow,
  'lifecycle' | 'config' | 'createdAt' | 'startedAt' | 'lastLobbyActivityAt' | 'lastActionAt' | 'allDisconnectedSince' | 'abandonedAt'
>;

/**
 * The transition due for `game` at `now`, or null (design §5.7). Pure; every comparison is ≥, so a threshold of 30 min
 * fires at 30:00 and not at 29:59:
 * - lobby: now − last_lobby_activity_at ≥ lobbyExpiryHours → expired;
 * - active: now − last_action_at ≥ inactivityAbandonMin → abandoned (inactivity), else all_disconnected_since set and
 *   now − all_disconnected_since ≥ allDisconnectedAbandonMin → abandoned (all_disconnected);
 * - abandoned: now − abandoned_at ≥ resumeWindowDays → expired.
 * finished and expired are terminal. Resuming and finishing are driven by events, not by time.
 */
export function evaluate(game: EvaluatedFields, now: number): Transition | null {
  const l = game.config.lifecycle;
  switch (game.lifecycle) {
    case 'lobby':
      return now - game.lastLobbyActivityAt >= l.lobbyExpiryHours * HOUR_MS ? { from: 'lobby', to: 'expired' } : null;
    case 'active': {
      const lastAction = game.lastActionAt ?? game.startedAt ?? game.createdAt;
      if (now - lastAction >= l.inactivityAbandonMin * MINUTE_MS) return { from: 'active', to: 'abandoned', reason: 'inactivity' };
      const since = game.allDisconnectedSince;
      if (since !== null && now - since >= l.allDisconnectedAbandonMin * MINUTE_MS) {
        return { from: 'active', to: 'abandoned', reason: 'all_disconnected' };
      }
      return null;
    }
    case 'abandoned':
      return game.abandonedAt !== null && now - game.abandonedAt >= l.resumeWindowDays * DAY_MS ? { from: 'abandoned', to: 'expired' } : null;
    default:
      return null;
  }
}

export interface LifecycleDeps {
  readonly ctx: ServerContext;
  readonly rooms: RoomManager;
  readonly gateway: () => WsGateway;
}

/** catan.games.transitions; only the 7 valid edges are ever counted (metrics.ts). */
export function transitionsCounter(ctx: ServerContext) {
  const m = serverMetrics(ctx.telemetry);
  return {
    add(_n: 1, edge: { from: TransitionEdge[0]; to: TransitionEdge[1] }): void {
      m.transition(edge.from, edge.to);
    },
  };
}

/**
 * Applies lifecycle transitions and keeps the lifecycle timestamps (design §5.7):
 * - refresh(): every transition evaluate() finds due, persisted with its effects, metrics and events;
 * - contact(): a seated hello, `control resume` or action — refresh, then an abandoned game resumes;
 * - finish(): an engine gameOver ends an active game;
 * - presenceChanged(): all_disconnected_since follows the seated sockets of an active game;
 * - every transition of a game in place (resume, finish; abandon and expire while sockets are still bound) bumps
 *   room_rev once, in the same UPDATE as the lifecycle change, then sends `room` to the bound sockets, so clients see
 *   the new lifecycle without reconnecting and a restart never reuses a broadcast rev. No-op contacts (D24) change
 *   nothing and send nothing;
 * - flushPlay(): active_play_ms accumulates the time spent in `active`.
 */
export class LifecycleService {
  /** gameId → the time up to which active play has been added to active_play_ms. */
  private readonly playedUntil = new Map<string, number>();
  private readonly transitions;
  private readonly activePlaySeconds;
  private readonly activePlayHistogram;

  constructor(private readonly deps: LifecycleDeps) {
    const { telemetry } = deps.ctx;
    this.transitions = transitionsCounter(deps.ctx);
    const m = serverMetrics(telemetry);
    this.activePlaySeconds = m.gamesActivePlaySeconds;
    this.activePlayHistogram = m.gameActivePlay;
  }

  private get now(): number {
    return this.deps.ctx.clock.now();
  }

  /** The game's current row with every due transition applied, or null for an unknown game. */
  current(gameId: string): GameMetaRow | null {
    const meta = this.deps.ctx.store.findGame(gameId);
    return meta ? this.refresh(meta) : null;
  }

  /** Applies every transition due at now (at most lobby→expired, or active→abandoned→expired). */
  refresh(meta: GameMetaRow): GameMetaRow {
    let m = meta;
    for (let t = evaluate(m, this.now); t !== null; t = evaluate(m, this.now)) m = this.apply(m, t);
    return m;
  }

  /**
   * A seated player's hello, `control resume` or action (design §5.7): refresh; an abandoned game then resumes
   * (stateHash unchanged, last_action_at = now, all_disconnected_since recomputed, game.resumed{reason}). Returns the
   * resulting row, or null for an unknown game.
   */
  contact(gameId: string, reason: ResumeReason): GameMetaRow | null {
    const meta = this.current(gameId);
    if (meta === null || meta.lifecycle !== 'abandoned') return meta;
    const now = this.now;
    const patch = {
      lifecycle: 'active',
      lastActionAt: now,
      allDisconnectedSince: this.anySeatConnected(gameId) ? null : now,
      abandonedAt: null,
      abandonReason: null,
      roomRev: meta.roomRev + 1,
    } as const;
    this.deps.ctx.store.updateMeta(gameId, patch);
    this.playedUntil.set(gameId, now);
    this.transitions.add(1, { from: 'abandoned', to: 'active' });
    logEvent(this.deps.ctx.telemetry, 'game.resumed', {
      game_id: gameId,
      reason,
      abandoned_s: Math.round((now - (meta.abandonedAt ?? now)) / 1000),
    });
    broadcastRoom(this.deps, gameId);
    return { ...meta, ...patch };
  }

  /** An active game whose engine state reached gameOver becomes finished (design §5.6): ended_at, game.ended. */
  finish(gameId: string, room: GameRoom): void {
    const state = room.state;
    if (state.phase.name !== 'gameOver') return;
    const meta = this.deps.ctx.store.findGame(gameId);
    if (meta === null || meta.lifecycle !== 'active') return;
    const played = this.flushPlay(meta);
    const now = this.now;
    room.snapshotAtHead();
    this.deps.ctx.store.updateMeta(gameId, { lifecycle: 'finished', endReason: 'won', endedAt: now, roomRev: meta.roomRev + 1 });
    this.playedUntil.delete(gameId);
    this.transitions.add(1, { from: 'active', to: 'finished' });
    const activePlayS = played.activePlayMs / 1000;
    this.activePlayHistogram.record(activePlayS);
    this.ended(meta, now, 'finished', state, state.phase.winner);
    // The final state{seq} went out from the commit path already; room{lifecycle: finished} follows it.
    broadcastRoom(this.deps, gameId);
  }

  /**
   * all_disconnected_since of an active game: null while a seated socket is bound, else the time the last one left.
   * Ignored once the server drains: those disconnects are the restart's, and recovery sets presence at boot (§5.9).
   */
  presenceChanged(gameId: string): void {
    if (this.deps.rooms.draining || !this.deps.ctx.store.isOpen) return;
    const meta = this.deps.ctx.store.findGame(gameId);
    if (meta === null || meta.lifecycle !== 'active') return;
    const connected = this.anySeatConnected(gameId);
    if (connected && meta.allDisconnectedSince !== null) this.deps.ctx.store.updateMeta(gameId, { allDisconnectedSince: null });
    if (!connected && meta.allDisconnectedSince === null) this.deps.ctx.store.updateMeta(gameId, { allDisconnectedSince: this.now });
  }

  /**
   * Adds the active time since the last flush to active_play_ms and catan.games.active_play_seconds. The first flush
   * this process makes for a game counts from started_at when nothing was recorded yet, otherwise from now, so server
   * downtime is never counted as play.
   */
  flushPlay(meta: GameMetaRow): GameMetaRow {
    if (meta.lifecycle !== 'active') return meta;
    const now = this.now;
    const from = this.playedUntil.get(meta.id) ?? (meta.activePlayMs === 0 && meta.startedAt !== null ? meta.startedAt : now);
    this.playedUntil.set(meta.id, now);
    const delta = Math.max(0, now - from);
    if (delta === 0) return meta;
    const activePlayMs = meta.activePlayMs + delta;
    this.deps.ctx.store.updateMeta(meta.id, { activePlayMs });
    this.activePlaySeconds.add(delta / 1000);
    return { ...meta, activePlayMs };
  }

  /** Flushes active play for every active game (job ticks and drain). */
  flushAllPlay(): void {
    for (const meta of this.deps.ctx.store.listGames(['active'])) this.flushPlay(meta);
  }

  private apply(meta: GameMetaRow, t: Transition): GameMetaRow {
    const { store, telemetry } = this.deps.ctx;
    const now = this.now;
    switch (t.to) {
      case 'abandoned': {
        const played = this.flushPlay(meta);
        const live = this.deps.rooms.loaded(meta.id);
        if (live) live.snapshotAtHead();
        this.deps.rooms.unload(meta.id);
        this.playedUntil.delete(meta.id);
        const bound = this.bound(meta.id);
        const patch = { lifecycle: 'abandoned', abandonedAt: now, abandonReason: t.reason, roomRev: meta.roomRev + (bound ? 1 : 0) } as const;
        store.updateMeta(meta.id, patch);
        this.transitions.add(1, { from: 'active', to: 'abandoned' });
        logEvent(telemetry, 'game.abandoned', { game_id: meta.id, reason: t.reason });
        if (bound) broadcastRoom(this.deps, meta.id);
        return { ...played, ...patch };
      }
      case 'expired': {
        this.deps.rooms.unload(meta.id);
        const bound = this.bound(meta.id);
        const endReason = t.from === 'lobby' ? 'lobby_expired' : 'abandoned_expired';
        const patch = { lifecycle: 'expired', endReason, endedAt: now, roomRev: meta.roomRev + (bound ? 1 : 0) } as const;
        store.updateMeta(meta.id, patch);
        this.transitions.add(1, { from: t.from, to: 'expired' });
        this.ended(meta, now, 'expired', null, null);
        if (bound) broadcastRoom(this.deps, meta.id);
        return { ...meta, ...patch };
      }
    }
  }

  /** game.ended (design §9.5); the seed is logged only now that the game is terminal. */
  private ended(meta: GameMetaRow, now: number, outcome: 'finished' | 'expired', state: GameState | null, winner: Seat | null): void {
    const played = this.deps.ctx.store.findGame(meta.id)?.activePlayMs ?? meta.activePlayMs;
    gameEnded(this.deps.ctx.telemetry, {
      game_id: meta.id,
      outcome,
      from_state: meta.lifecycle,
      winner_seat: winner,
      turns: state?.turn.number ?? null,
      active_play_s: Math.round(played / 1000),
      wall_s: meta.startedAt !== null ? Math.round((now - meta.startedAt) / 1000) : null,
      vp_by_seat: state ? state.players.map((_, s) => victoryPoints(state, s as Seat).total) : null,
      seed: meta.seed,
    });
  }

  /** Whether any socket is bound to the game (job-driven transitions announce themselves only then). */
  private bound(gameId: string): boolean {
    return this.deps.gateway().connectionsOf(gameId).length > 0;
  }

  private anySeatConnected(gameId: string): boolean {
    return this.deps.gateway().connectionsOf(gameId).some((c) => c.binding?.seat !== null && c.binding?.seat !== undefined);
  }
}

/** Lifecycles the job evaluates. */
const LIVE: readonly Lifecycle[] = ['lobby', 'active', 'abandoned'];

/**
 * The AbandonmentJob (design §2.3, §5.7, §4, §9.2): every lifecycle.checkIntervalSec it evaluates every non-terminal
 * game, flushes active play, purges retained terminal games (expired at once; finished after finishedRetentionDays)
 * into tombstones, and clears tombstones whose window has ended (D26). Each game is handled in its own try/catch, so one failure never stops the others; any failure
 * makes the run an error. Idempotent: a second run at the same time changes nothing.
 * Metrics: catan.job.abandonment.runs{result}, .duration (s), .last_success (unix s); span catan.job.abandonment.
 */
export class AbandonmentJob {
  private timer: TimerHandle | null = null;
  private lastSuccess: number | null = null;
  private readonly runs;
  private readonly duration;

  constructor(
    private readonly deps: LifecycleDeps,
    private readonly lifecycle: LifecycleService,
  ) {
    const { telemetry } = deps.ctx;
    const m = serverMetrics(telemetry);
    this.runs = m.jobRuns;
    this.duration = m.jobDuration;
    registerGauge(telemetry, CATALOGUE.jobLastSuccess, () =>
      this.lastSuccess === null ? [] : [{ value: Math.floor(this.lastSuccess / 1000) }],
    );
  }

  /** Epoch ms of the last successful run; null before the first one. */
  get lastSuccessAt(): number | null {
    return this.lastSuccess;
  }

  /** Starts the periodic run; idempotent. */
  start(): void {
    if (this.timer !== null) return;
    this.timer = this.deps.ctx.clock.setInterval(() => this.run(), this.deps.ctx.config.lifecycle.checkIntervalSec * 1000);
  }

  stop(): void {
    if (this.timer === null) return;
    this.deps.ctx.clock.clear(this.timer);
    this.timer = null;
  }

  /** One run over every game; never throws. */
  run(): void {
    const { ctx } = this.deps;
    ctx.telemetry.tracer.startActiveSpan('catan.job.abandonment', (span) => {
      const t0 = performance.now();
      let failed = 0;
      // Every job fault: catan.errors{component=job} plus one ERROR job.abandonment.error line.
      const fault = (fields: LogEventFields['job.abandonment.error']) => {
        failed += 1;
        serverMetrics(ctx.telemetry).errors.add(1, { component: 'job' });
        logEvent(ctx.telemetry, 'job.abandonment.error', fields);
      };
      const each = (rows: readonly GameMetaRow[], fn: (m: GameMetaRow) => void) => {
        for (const meta of rows) {
          try {
            fn(meta);
          } catch {
            fault({ stage: 'game', game_id: meta.id });
          }
        }
      };
      let rows: readonly GameMetaRow[] = [];
      try {
        rows = ctx.store.listGames(LIVE);
      } catch {
        fault({ stage: 'list_live' });
      }
      each(rows, (meta) => this.lifecycle.flushPlay(this.lifecycle.refresh(meta)));
      let terminal: readonly GameMetaRow[] = [];
      try {
        terminal = ctx.store.listGames(['finished', 'expired']);
      } catch {
        fault({ stage: 'list_terminal' });
      }
      each(terminal, (meta) => this.purgeIfDue(meta));
      try {
        ctx.store.clearEndedTombstones(ctx.clock.now());
      } catch {
        fault({ stage: 'clear_tombstones' });
      }

      const result = failed === 0 ? 'ok' : 'error';
      this.runs.add(1, { result });
      this.duration.record((performance.now() - t0) / 1000);
      if (result === 'ok') this.lastSuccess = ctx.clock.now();
      span.setAttributes({ 'catan.job.games': rows.length, 'catan.job.failed': failed });
      if (failed > 0) span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
    });
  }

  /**
   * Retention (design §4): an expired game (lobby, abandoned or lost) is purged at once, a finished one
   * finishedRetentionDays after ended_at. The purge leaves a tombstone for tombstoneDays (D26).
   */
  private purgeIfDue(meta: GameMetaRow): void {
    if (meta.roomCode === null) return;
    const now = this.deps.ctx.clock.now();
    const due =
      meta.lifecycle === 'expired' ||
      (meta.endedAt !== null && now - meta.endedAt >= meta.config.lifecycle.finishedRetentionDays * DAY_MS);
    if (!due) return;
    this.deps.rooms.unload(meta.id);
    // Rows created before tombstoneDays existed carry no value for it; they use the server's.
    const days = (meta.config.lifecycle as Partial<LifecycleConfig>).tombstoneDays ?? this.deps.ctx.config.lifecycle.tombstoneDays;
    this.deps.ctx.store.purgeGame(meta.id, now + days * DAY_MS);
  }
}
