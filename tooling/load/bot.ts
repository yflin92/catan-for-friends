// X-load protocol-client bot (AC32): one seated player speaking the real WebSocket protocol, as apps/web's WsClient
// does. It answers pings, acks every state, acts at a human pace from its own PlayerView descriptor (one action in
// flight), sends real telemetry batches, goes hidden now and then, and reconnects like the web client.
// - Action RTT is sampled only for an outcome that arrives on the connection its action was sent on, and never for a
//   resent action.
// - A reconnect's resume gap runs from the close to the next welcome; its cause is 'server_restart' iff the lost socket
//   closed with 1012, else 'network'. The pending action is resent with its original actionId after the welcome.
// - Slow-consumer mode (V34/V35): after `afterMs` the bot stops reading its socket. It keeps the heartbeat alive with
//   pongs and requests resyncs, so full views pile up in the server's outbound buffer until the server cuts it off
//   (> 1 MiB buffered: the server closes with 1008 and terminates, S-2; the stalled client may observe 1006, since the
//   close frame sits behind unread data). Then it reconnects and plays on as a normal bot.
// Room codes and seat tokens stay in memory; nothing here prints them.
import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import { WebSocket } from 'ws';
import {
  CloseCode,
  PROTOCOL_VERSION,
  TELEMETRY_MIN_BATCH_INTERVAL_MS,
  type ClientMsg,
  type LobbyOp,
  type OutcomeResult,
  type PlayerViewWire,
  type ResumeGapCause,
  type RoomView,
  type ServerMsgWire,
} from '../../packages/protocol/src/index';
import { hasAction, pickAction } from './picker';
import { TelemetryBuffer } from './telemetry';

/** Close codes after which the web client does not reconnect. */
const TERMINAL_CLOSES = new Set<number>([CloseCode.SUPERSEDED, CloseCode.AUTH_FAILED, CloseCode.GAME_GONE]);
/** The web client's reconnect backoff (ms), each with ±20 % jitter; the last step repeats. */
const BACKOFF_MS = [0, 250, 500, 1000, 2000, 4000];

export interface SlowConsumerOptions {
  /** Delay after the bot's first state before it stops reading. */
  readonly afterMs: number;
  /** Resync requests per second while stalled (each makes the server send this socket a full view). */
  readonly resyncPerSec: number;
  /** Pong interval while stalled; any pong re-arms the server's heartbeat deadline. */
  readonly pongEveryMs: number;
  /** Give up waiting for the cut-off after this long stalled, and resume reading. */
  readonly maxStallMs: number;
}

export interface BotOptions {
  readonly wsUrl: string;
  readonly roomCode: string;
  /** The host's token from POST /api/rooms; joiners receive theirs after lobby join. */
  readonly seatToken?: string;
  readonly displayName: string;
  readonly rand: () => number;
  /** Delay before each action, uniform in [min, max] ms. */
  readonly paceMs: readonly [number, number];
  /** Share of action slots spent on an action the descriptor rules out. */
  readonly illegalRate: number;
  readonly telemetryIntervalMs: number;
  /** Mean time between hidden spells (exponential), or null for never. */
  readonly hiddenEveryMs: number | null;
  readonly hiddenForMs: readonly [number, number];
  readonly slow?: SlowConsumerOptions;
}

export interface SlowConsumerStats {
  /**
   * Time from the stall to the bot observing its socket close. Behind a proxy (Caddy) the server's cut-off is only seen
   * once the bot reads again, so this can exceed `stalledMs`; the server's own record is the player.disconnected
   * {reason: unplanned, cause: backpressure} log line and catan.ws.disconnects{reason="unplanned"}.
   */
  closeObservedAfterMs: number | null;
  /** The close code the bot saw for the stalled connection (1006 when the server's close frame cannot arrive). */
  closeCode: number | null;
  /** How long the bot stopped reading. */
  stalledMs: number | null;
  /** True when the bot resumed reading after maxStallMs instead of seeing its socket close while stalled. */
  resumedReading: boolean;
  resyncsSent: number;
}

export interface BotStats {
  actionsSent: number;
  outcomes: Record<OutcomeResult, number>;
  intendedIllegal: number;
  /** Intended-illegal actions the server rejected (rule/turn). */
  intendedIllegalRejected: number;
  /** Intended-illegal actions the server accepted: the bot's view was stale and the action had become legal. */
  intendedIllegalAccepted: number;
  /** Intended-illegal actions answered error or auth (e.g. server_draining during a restart). */
  intendedIllegalOther: number;
  /** Actions still awaiting their outcome when the bot stopped, and how many of them were intended-illegal. */
  unansweredAtStop: number;
  intendedIllegalUnanswered: number;
  /** Rejections of actions the bot's descriptor offered, by reason code (stale-view races). */
  unexpectedRejects: Record<string, number>;
  rttMs: number[];
  /** Close codes of connections that had opened. */
  closes: Record<string, number>;
  /** Connection attempts that closed before opening (e.g. while the server restarts). */
  failedConnectAttempts: number;
  reconnects: number;
  gaps: { ms: number; cause: ResumeGapCause }[];
  telemetryBatches: number;
  telemetrySamples: number;
  hiddenSpells: number;
  states: number;
  gameOver: boolean;
  slow: SlowConsumerStats | null;
}

interface Pending {
  readonly actionId: string;
  readonly msg: ClientMsg;
  readonly intendedIllegal: boolean;
  sentAt: number;
  conn: number;
  resent: boolean;
}

const uniform = (rand: () => number, [min, max]: readonly [number, number]): number => min + rand() * (max - min);

export class Bot {
  readonly stats: BotStats;
  seat: number | null = null;
  isHost = false;
  room: RoomView | null = null;
  view: PlayerViewWire | null = null;

  private readonly o: BotOptions;
  private seatToken: string | undefined;
  private ws: WebSocket | null = null;
  private conn = 0;
  private seq = -1;
  private pending: Pending | null = null;
  private actTimer: NodeJS.Timeout | null = null;
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly telemetry = new TelemetryBuffer();
  private lastBatchAt: number | null = null;
  private hidden = false;
  private stopped = false;
  private attempt = 0;
  private gap: { since: number; cause: ResumeGapCause } | null = null;
  private stall: { timers: NodeJS.Timeout[]; since: number } | null = null;
  /** Start of the stall whose connection has not been seen closing yet. */
  private stallSince: number | null = null;
  private slowArmed = false;
  private readonly waiters = new Map<string, (o: { result: OutcomeResult; reasonCode?: string }) => void>();

  constructor(options: BotOptions) {
    this.o = options;
    this.seatToken = options.seatToken;
    this.stats = {
      actionsSent: 0,
      outcomes: { ok: 0, rule: 0, turn: 0, auth: 0, error: 0 },
      intendedIllegal: 0,
      intendedIllegalRejected: 0,
      intendedIllegalAccepted: 0,
      intendedIllegalOther: 0,
      unansweredAtStop: 0,
      intendedIllegalUnanswered: 0,
      unexpectedRejects: {},
      rttMs: [],
      closes: {},
      failedConnectAttempts: 0,
      reconnects: 0,
      gaps: [],
      telemetryBatches: 0,
      telemetrySamples: 0,
      hiddenSpells: 0,
      states: 0,
      gameOver: false,
      slow: options.slow ? { closeObservedAfterMs: null, closeCode: null, stalledMs: null, resumedReading: false, resyncsSent: 0 } : null,
    };
  }

  /** Opens the first connection and resolves after its welcome. */
  start(): Promise<void> {
    const welcomed = new Promise<void>((resolve) => this.onceWelcome.push(resolve));
    this.connect();
    this.every(this.o.telemetryIntervalMs, () => this.flushTelemetry());
    if (this.o.hiddenEveryMs !== null) this.scheduleHidden();
    return welcomed;
  }

  /** Takes a seat (lobby join); resolves with the outcome. */
  join(): Promise<{ result: OutcomeResult; reasonCode?: string }> {
    return this.lobby({ kind: 'join', displayName: this.o.displayName });
  }

  lobby(op: LobbyOp): Promise<{ result: OutcomeResult; reasonCode?: string }> {
    const actionId = randomUUID();
    const done = new Promise<{ result: OutcomeResult; reasonCode?: string }>((resolve) => this.waiters.set(actionId, resolve));
    this.send({ t: 'lobby', actionId, op });
    return done;
  }

  stop(): void {
    if (!this.stopped && this.pending) {
      this.stats.unansweredAtStop++;
      if (this.pending.intendedIllegal) this.stats.intendedIllegalUnanswered++;
    }
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.actTimer) clearTimeout(this.actTimer);
    this.endStall();
    this.ws?.close(1000);
  }

  // ── connection ──────────────────────────────────────────────────────────────

  private readonly onceWelcome: (() => void)[] = [];

  private connect(): void {
    const conn = ++this.conn;
    const ws = new WebSocket(this.o.wsUrl);
    this.ws = ws;
    let opened = false;
    ws.on('open', () => {
      opened = true;
      this.send({ t: 'hello', v: PROTOCOL_VERSION, actionId: randomUUID(), roomCode: this.o.roomCode, ...(this.seatToken ? { seatToken: this.seatToken } : {}) });
    });
    ws.on('message', (data) => {
      if (conn === this.conn) this.onMessage(JSON.parse(String(data)) as ServerMsgWire);
    });
    ws.on('error', () => undefined);
    ws.on('close', (code) => {
      if (conn === this.conn) this.onClose(code, opened);
    });
  }

  private onClose(code: number, opened: boolean): void {
    if (opened) this.stats.closes[String(code)] = (this.stats.closes[String(code)] ?? 0) + 1;
    else this.stats.failedConnectAttempts++;
    if (this.stallSince !== null) {
      const slow = this.stats.slow!;
      slow.closeObservedAfterMs = Math.round(performance.now() - this.stallSince);
      slow.closeCode = code;
      slow.stalledMs ??= slow.closeObservedAfterMs;
      this.stallSince = null;
      this.endStall();
    }
    if (this.actTimer) clearTimeout(this.actTimer);
    this.actTimer = null;
    if (this.stopped || TERMINAL_CLOSES.has(code)) return;
    // The first close of an outage decides the cause; failed attempts while reconnecting keep it.
    this.gap ??= { since: performance.now(), cause: code === CloseCode.SERVICE_RESTART ? 'server_restart' : 'network' };
    const base = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!;
    this.attempt++;
    this.after(base * (0.8 + 0.4 * this.o.rand()), () => this.connect());
  }

  private send(msg: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  // ── inbound ─────────────────────────────────────────────────────────────────

  private onMessage(msg: ServerMsgWire): void {
    switch (msg.t) {
      case 'ping':
        this.send({ t: 'pong', id: msg.id });
        return;
      case 'welcome':
        this.onWelcome(msg.seat, msg.isHost, msg.room, msg.seq, msg.view);
        return;
      case 'seatToken':
        this.seatToken = msg.seatToken;
        this.seat = msg.seat;
        return;
      case 'room':
        this.room = msg.room;
        this.seat = msg.yourSeat;
        this.isHost = msg.yourSeat !== null && msg.yourSeat === msg.room.hostSeat;
        return;
      case 'state':
        this.stats.states++;
        this.adopt(msg.seq, msg.view);
        this.send({ t: 'ack', seq: msg.seq });
        return;
      case 'outcome':
        this.onOutcome(msg.actionId, msg.result, msg.reasonCode);
        return;
      case 'superseded':
        return;
    }
  }

  private onWelcome(seat: number | null, isHost: boolean, room: RoomView, seq: number, view: PlayerViewWire | null): void {
    this.attempt = 0;
    this.seat = seat;
    this.isHost = isHost;
    this.room = room;
    if (view) this.adopt(seq, view);
    if (this.gap) {
      this.stats.reconnects++;
      const ms = performance.now() - this.gap.since;
      this.stats.gaps.push({ ms: Math.round(ms), cause: this.gap.cause });
      this.telemetry.addResumeGap(ms, this.gap.cause);
      this.gap = null;
      this.flushTelemetry();
    }
    if (this.pending) {
      // Resent with its original actionId; its RTT is never sampled.
      this.pending.resent = true;
      this.pending.conn = this.conn;
      this.pending.sentAt = performance.now();
      this.send(this.pending.msg);
    }
    for (const resolve of this.onceWelcome.splice(0)) resolve();
    this.maybeAct();
  }

  private adopt(seq: number, view: PlayerViewWire): void {
    if (seq < this.seq) return;
    const first = this.view === null;
    this.seq = seq;
    this.view = view;
    if (view.legal.phase === 'gameOver') this.stats.gameOver = true;
    if (first && this.o.slow && !this.slowArmed) {
      this.slowArmed = true;
      this.after(this.o.slow.afterMs, () => this.beginStall());
    }
    this.maybeAct();
  }

  private onOutcome(actionId: string | null, result: OutcomeResult, reasonCode: string | undefined): void {
    if (actionId === null) return;
    const waiter = this.waiters.get(actionId);
    if (waiter) {
      this.waiters.delete(actionId);
      waiter(reasonCode === undefined ? { result } : { result, reasonCode });
      return;
    }
    const p = this.pending;
    if (p?.actionId !== actionId) return;
    this.pending = null;
    this.stats.outcomes[result]++;
    if (!p.resent && p.conn === this.conn) {
      const rtt = performance.now() - p.sentAt;
      this.stats.rttMs.push(rtt);
      this.telemetry.addActionRtt(rtt);
    }
    if (p.intendedIllegal) {
      if (result === 'rule' || result === 'turn') this.stats.intendedIllegalRejected++;
      else if (result === 'ok') this.stats.intendedIllegalAccepted++;
      else this.stats.intendedIllegalOther++;
    } else if (result !== 'ok') {
      const key = `${result}/${reasonCode ?? '-'}`;
      this.stats.unexpectedRejects[key] = (this.stats.unexpectedRejects[key] ?? 0) + 1;
    }
    this.maybeAct();
  }

  // ── acting ──────────────────────────────────────────────────────────────────

  private maybeAct(): void {
    if (this.stopped || this.hidden || this.stall || this.pending || this.actTimer || !this.view) return;
    if (this.view.legal.seat !== this.seat || !hasAction(this.view.hand, this.view.legal)) return;
    this.actTimer = setTimeout(() => this.act(), uniform(this.o.rand, this.o.paceMs));
  }

  private act(): void {
    this.actTimer = null;
    const view = this.view;
    if (this.stopped || this.hidden || this.stall || this.pending || !view || this.ws?.readyState !== WebSocket.OPEN) return;
    const pick = pickAction(view.hand, view.legal, this.o.rand, this.o.illegalRate);
    if (!pick) return;
    const actionId = randomUUID();
    const msg: ClientMsg = { t: 'action', actionId, baseSeq: this.seq, action: pick.action };
    this.pending = { actionId, msg, intendedIllegal: pick.intendedIllegal, sentAt: performance.now(), conn: this.conn, resent: false };
    this.stats.actionsSent++;
    if (pick.intendedIllegal) this.stats.intendedIllegal++;
    this.send(msg);
  }

  // ── telemetry and visibility ────────────────────────────────────────────────

  private flushTelemetry(): void {
    if (this.stall || this.telemetry.pending === 0 || this.ws?.readyState !== WebSocket.OPEN) return;
    const now = performance.now();
    if (this.lastBatchAt !== null && now - this.lastBatchAt < TELEMETRY_MIN_BATCH_INTERVAL_MS) {
      this.after(TELEMETRY_MIN_BATCH_INTERVAL_MS - (now - this.lastBatchAt), () => this.flushTelemetry());
      return;
    }
    const batch = this.telemetry.takeBatch();
    if (!batch) return;
    this.lastBatchAt = now;
    this.stats.telemetryBatches++;
    this.stats.telemetrySamples += (batch.actionRttMs?.length ?? 0) + (batch.resumeGaps?.length ?? 0);
    this.send(batch);
  }

  private scheduleHidden(): void {
    const mean = this.o.hiddenEveryMs!;
    this.after(-Math.log(1 - this.o.rand()) * mean, () => {
      if (!this.stall && this.ws?.readyState === WebSocket.OPEN) {
        this.hidden = true;
        this.stats.hiddenSpells++;
        this.send({ t: 'visibility', state: 'hidden' });
        this.after(uniform(this.o.rand, this.o.hiddenForMs), () => {
          this.hidden = false;
          this.send({ t: 'visibility', state: 'visible' });
          this.maybeAct();
        });
      }
      this.scheduleHidden();
    });
  }

  // ── slow consumer ───────────────────────────────────────────────────────────

  private beginStall(): void {
    const slow = this.o.slow!;
    const ws = this.ws;
    if (this.stopped || !ws || ws.readyState !== WebSocket.OPEN) return;
    (ws as unknown as { _socket: Socket })._socket.pause();
    const since = performance.now();
    this.stallSince = since;
    const timers = [
      setInterval(() => this.send({ t: 'pong', id: 0 }), slow.pongEveryMs),
      setInterval(() => {
        this.stats.slow!.resyncsSent++;
        this.send({ t: 'resync' });
      }, 1000 / slow.resyncPerSec),
      setTimeout(() => {
        this.stats.slow!.resumedReading = true;
        this.stats.slow!.stalledMs = Math.round(performance.now() - since);
        this.endStall();
        (ws as unknown as { _socket: Socket })._socket.resume();
        this.maybeAct();
      }, slow.maxStallMs),
    ];
    this.stall = { timers, since };
  }

  private endStall(): void {
    if (!this.stall) return;
    for (const t of this.stall.timers) clearTimeout(t);
    this.stall = null;
  }

  // ── timers ──────────────────────────────────────────────────────────────────

  private after(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (!this.stopped) fn();
    }, Math.max(0, ms));
    this.timers.add(t);
  }

  private every(ms: number, fn: () => void): void {
    const t = setInterval(() => {
      if (!this.stopped) fn();
    }, ms);
    this.timers.add(t);
  }
}
