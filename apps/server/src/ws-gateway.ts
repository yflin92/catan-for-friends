// WebSocket gateway (design §2.3, §3.11, §7 F10–F12, §8, §9.4; ADR-0004). It owns transport concerns only:
// - /ws upgrades with an Origin allow-list; 16 KiB inbound frame cap (close 1009);
// - strict zod parsing of client frames; malformed frames get rule/malformed_action and the socket stays open, unless
//   one socket sends more than ops.malformedCloseThreshold of them in the window (close 1008);
// - the per-connection message rate (error/rate_limited) and the per-IP failed room-code limit (auth/rate_limited_auth);
// - heartbeat (ping every 10 s, terminate after 25 s without a pong) and backpressure (> 1 MiB buffered → close 1008);
// - the socket ↔ (game, seat) binding registry and disconnect classification.
// Game semantics live behind GatewayHandlers. The gateway sends exactly ONE outcome for every hello, action, lobby and
// control message, built from the handler's result; handlers cannot send outcomes themselves. Signals (resync, ack,
// pong, visibility, telemetry) never get an outcome.
import type { IncomingMessage } from 'node:http';
import { performance } from 'node:perf_hooks';
import type { Duplex } from 'node:stream';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { OutcomeResult, ReasonCode, Seat } from '@hexlands/engine';
import {
  CloseCode,
  MAX_INBOUND_FRAME_BYTES,
  SIGNAL_TYPES,
  actionIdSchema,
  clientMsgSchema,
  type ActionMsg,
  type ClientMsg,
  type ControlMsg,
  type HelloMsg,
  type LobbyMsg,
  type OutcomeRecord,
  type ServerMsg,
  type TelemetryMsg,
} from '@hexlands/protocol';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { serverMetrics } from './metrics';
import type { ServerContext } from './server';
import { withRootSpan } from './telemetry';
import { clientIp, rateLimitKey, trustedProxySet } from './ws-gateway/client-ip';
import { classifyDisconnect, type DisconnectClass, type ServerCloseCause } from './ws-gateway/disconnect';
import { FailedCodeLimiter, SlidingWindowCounter, TokenBucket } from './ws-gateway/limits';

export const WS_PATH = '/ws';
export const HEARTBEAT_INTERVAL_MS = 10_000;
export const HEARTBEAT_TIMEOUT_MS = 25_000;
/** Outbound buffer above which a slow client is cut off (F12). */
export const MAX_BUFFERED_BYTES = 1024 * 1024;

type CommandKind = 'hello' | 'action' | 'lobby' | 'control';
const COMMAND_TYPES = new Set<string>(['hello', 'action', 'lobby', 'control']);
const SIGNALS = new Set<string>(SIGNAL_TYPES);

/** What a command handler decides; the gateway turns it into the single outcome (and optional close). */
export interface CommandResult {
  readonly result: OutcomeResult;
  readonly reasonCode?: ReasonCode;
  readonly seq?: number;
  /** Close the socket with this code right after the outcome. */
  readonly close?: number;
}

export interface Binding {
  readonly gameId: string;
  /** null for a room member without a seat (lobby before join, or a started game without a token). */
  readonly seat: Seat | null;
}

export interface DisconnectInfo extends DisconnectClass {
  /** The binding at close time; disconnects count only when a seat was bound (design §9.4). */
  readonly binding: Binding | null;
  readonly connectedMs: number;
  /** When the socket was last bound to a seat (clock ms); null if it never was. */
  readonly seatedSince: number | null;
}

/** One client socket as seen by handlers. */
export interface Connection {
  readonly id: number;
  readonly binding: Binding | null;
  /** When the socket was bound to its current seat (clock ms); null while it holds no seat. */
  readonly seatedSince: number | null;
  /** Sends a server message. Outcomes are reserved to the gateway and throw here. */
  send(msg: Exclude<ServerMsg, { t: 'outcome' }>): void;
  /** Closes the socket; `cause` feeds disconnect classification. */
  close(code: number, cause: ServerCloseCause): void;
  /** Counts a failed room code against this client's IP (F11). */
  recordFailedRoomCode(): void;
}

export interface GatewayHandlers {
  hello(conn: Connection, msg: HelloMsg): CommandResult;
  action(conn: Connection, msg: ActionMsg): CommandResult;
  lobby(conn: Connection, msg: LobbyMsg): CommandResult;
  control(conn: Connection, msg: ControlMsg): CommandResult;
  resync?(conn: Connection): void;
  ack?(conn: Connection, seq: number): void;
  visibility?(conn: Connection, state: 'hidden' | 'visible'): void;
  telemetry?(conn: Connection, msg: TelemetryMsg): void;
  /** A telemetry frame that failed the schema or the rate limit (catan.telemetry.dropped). */
  telemetryDropped?(conn: Connection): void;
  disconnected?(conn: Connection, info: DisconnectInfo): void;
  /** Called for every outcome the gateway sends; `kind` is the command type, or null for an unparseable frame. */
  outcome?(conn: Connection, kind: 'hello' | 'action' | 'lobby' | 'control' | null, outcome: OutcomeRecord): void;
  /** A handler threw; the sender got error/internal_error. `msg` is the command that was being handled. */
  handlerError?(err: unknown, kind: string, conn: Connection, msg: ClientMsg): void;
}

class Conn implements Connection {
  binding: Binding | null = null;
  /**
   * Set when the socket lost its seat: another socket took it (P6, seat_superseded) or its token was relinked away
   * (§5.1(6), seat_token_revoked). Its commands are refused with that code until it closes.
   */
  detached: 'seat_superseded' | 'seat_token_revoked' | null = null;
  seatedSince: number | null = null;
  serverCause: ServerCloseCause | null = null;
  hiddenSince: number | null = null;
  readonly openedAt: number;
  pingId = 0;
  /** performance.now() when ping `pingId` was sent; the matching pong records catan.ws.rtt. */
  pingSentAt: number | null = null;
  private readonly timers: ReturnType<ServerContext['clock']['setTimeout']>[] = [];
  private deadline: ReturnType<ServerContext['clock']['setTimeout']> | null = null;

  constructor(
    readonly id: number,
    readonly ws: WebSocket,
    /** Per-IP limiter key (IPv4 address or IPv6 /64); memory only. */
    readonly ip: string,
    readonly rate: TokenBucket,
    readonly malformed: SlidingWindowCounter,
    private readonly gw: WsGateway,
  ) {
    this.openedAt = gw.ctx.clock.now();
  }

  send(msg: Exclude<ServerMsg, { t: 'outcome' }>): void {
    if ((msg as ServerMsg).t === 'outcome') throw new Error('outcomes are sent by the gateway only');
    this.raw(msg);
  }

  /** Writes any server message, then enforces the backpressure limit. */
  raw(msg: ServerMsg): void {
    if (this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(JSON.stringify(msg));
    if (this.ws.bufferedAmount > MAX_BUFFERED_BYTES) this.kill(CloseCode.POLICY, 'backpressure');
  }

  close(code: number, cause: ServerCloseCause): void {
    if (this.ws.readyState === this.ws.CLOSED || this.ws.readyState === this.ws.CLOSING) return;
    this.serverCause ??= cause;
    this.ws.close(code);
  }

  /** Sends a close frame and drops the connection without waiting for the peer. */
  kill(code: number, cause: ServerCloseCause): void {
    this.serverCause ??= cause;
    if (this.ws.readyState === this.ws.OPEN) this.ws.close(code);
    this.ws.terminate();
  }

  recordFailedRoomCode(): void {
    this.gw.failedCodes.recordFailure(this.ip);
  }

  startHeartbeat(): void {
    const clock = this.gw.ctx.clock;
    this.timers.push(
      clock.setInterval(() => {
        this.pingSentAt = performance.now();
        this.raw({ t: 'ping', id: ++this.pingId });
      }, HEARTBEAT_INTERVAL_MS),
    );
    this.armDeadline();
  }

  armDeadline(): void {
    const clock = this.gw.ctx.clock;
    if (this.deadline) clock.clear(this.deadline);
    this.deadline = clock.setTimeout(() => this.kill(CloseCode.HEARTBEAT, 'heartbeat_timeout'), HEARTBEAT_TIMEOUT_MS);
  }

  stopTimers(): void {
    const clock = this.gw.ctx.clock;
    for (const t of this.timers) clock.clear(t);
    this.timers.length = 0;
    if (this.deadline) clock.clear(this.deadline);
    this.deadline = null;
  }
}

export class WsGateway {
  readonly failedCodes: FailedCodeLimiter;
  private readonly trustedProxies: ReturnType<typeof trustedProxySet>;
  private readonly wss: WebSocketServer;
  private readonly conns = new Set<Conn>();
  private readonly seats = new Map<string, Map<Seat, Conn>>();
  private readonly members = new Map<string, Set<Conn>>();
  private nextId = 1;
  private draining = false;

  /** `failedCodes` is shared with POST /api/rooms (passphrase failures count toward the same limit, D13). */
  constructor(
    readonly ctx: ServerContext,
    private readonly handlers: GatewayHandlers,
    failedCodes?: FailedCodeLimiter,
  ) {
    this.failedCodes = failedCodes ?? new FailedCodeLimiter(ctx.clock, ctx.config.rooms.failedCodeAttemptsPerIpPerMin);
    this.trustedProxies = trustedProxySet(ctx.config.ops.trustedProxies);
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_INBOUND_FRAME_BYTES });
  }

  /** New upgrades are refused with 503 while draining (design §5.8). */
  setDraining(on: boolean): void {
    this.draining = on;
  }

  /** Handles an HTTP upgrade; anything other than an allowed /ws upgrade is refused. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (requestPath(req) !== WS_PATH) return refuse(socket, 404);
    if (this.draining) return refuse(socket, 503);
    if (!originAllowed(req, this.ctx.allowedOrigins)) return refuse(socket, 403);
    this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws, req));
  }

  /** Binds a connection to a game (and seat). Returns the connection previously bound to that seat, if any. */
  bind(conn: Connection, binding: Binding): Connection | null {
    const c = conn as Conn;
    const sameSeat = c.binding !== null && c.binding.gameId === binding.gameId && c.binding.seat === binding.seat;
    const since = sameSeat ? c.seatedSince : null;
    this.unbind(c);
    c.binding = binding;
    c.seatedSince = binding.seat === null ? null : (since ?? this.ctx.clock.now());
    let members = this.members.get(binding.gameId);
    if (!members) this.members.set(binding.gameId, (members = new Set()));
    members.add(c);
    if (binding.seat === null) return null;
    let seats = this.seats.get(binding.gameId);
    if (!seats) this.seats.set(binding.gameId, (seats = new Map<Seat, Conn>()));
    const previous = seats.get(binding.seat) ?? null;
    seats.set(binding.seat, c);
    // The previous socket is detached: it keeps its own binding (its disconnect still counts, as superseded) but no
    // longer receives the seat's traffic, and its commands get auth/seat_superseded.
    if (previous && previous !== c) {
      previous.detached = 'seat_superseded';
      return previous;
    }
    return null;
  }

  /**
   * Re-points the game's seated sockets after a seat renumbering (design D9): the socket on old index order[i] moves
   * to index i. Nothing is closed or superseded.
   */
  renumber(gameId: string, order: readonly Seat[]): void {
    const seats = this.seats.get(gameId);
    if (!seats) return;
    const moved = new Map<Seat, Conn>();
    for (const [old, c] of seats) {
      const next = order.indexOf(old) as Seat;
      c.binding = { gameId, seat: next };
      moved.set(next, c);
    }
    this.seats.set(gameId, moved);
  }

  /**
   * The seat's token was revoked (relink, §5.1(6)): its socket, if any, stops receiving the seat's traffic, its
   * in-flight commands get auth/seat_token_revoked, and it is closed 4401.
   */
  revokeSeat(gameId: string, seat: Seat): void {
    const seats = this.seats.get(gameId);
    const c = seats?.get(seat);
    if (!c) return;
    seats!.delete(seat);
    c.detached = 'seat_token_revoked';
    c.close(CloseCode.AUTH_FAILED, 'revoked');
  }

  /** The socket currently bound to (gameId, seat). */
  connectionOf(gameId: string, seat: Seat): Connection | null {
    return this.seats.get(gameId)?.get(seat) ?? null;
  }

  /** Every open socket bound to a seat. */
  seatedConnections(): readonly Connection[] {
    return [...this.conns].filter((c) => c.binding?.seat != null);
  }

  /** Every socket bound to the game, seated or not. */
  connectionsOf(gameId: string): readonly Connection[] {
    return [...(this.members.get(gameId) ?? [])];
  }

  /** Number of open sockets. */
  get size(): number {
    return this.conns.size;
  }

  /** Open sockets bound to a seat (catan.players.connected). */
  get seatedCount(): number {
    let n = 0;
    for (const c of this.conns) if (c.binding?.seat != null) n++;
    return n;
  }

  /**
   * Stops accepting upgrades and closes every socket with `code`. Waits up to `waitMs` (wall clock) for the closing
   * handshakes, then terminates whatever is still open.
   */
  async close(code: number = CloseCode.GOING_AWAY, cause: ServerCloseCause = 'shutdown', waitMs = 1000): Promise<void> {
    this.draining = true;
    for (const c of this.conns) c.close(code, cause);
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      new Promise<void>((resolve) => this.wss.close(() => resolve())),
      new Promise<void>((resolve) => (timer = setTimeout(resolve, Math.max(0, waitMs)))),
    ]);
    clearTimeout(timer);
    for (const c of this.conns) c.ws.terminate();
  }

  private accept(ws: WebSocket, req: IncomingMessage): void {
    const { ops } = this.ctx.config;
    const c = new Conn(
      this.nextId++,
      ws,
      rateLimitKey(clientIp(req, this.trustedProxies)),
      new TokenBucket(this.ctx.clock, ops.maxMsgsPerSecPerConn, ops.maxMsgBurstPerConn),
      new SlidingWindowCounter(this.ctx.clock, ops.malformedCloseThreshold.windowSec * 1000),
      this,
    );
    this.conns.add(c);
    ws.on('message', (data, isBinary) => this.onFrame(c, data, isBinary));
    ws.on('close', (code) => this.onClose(c, code));
    ws.on('error', () => c.ws.terminate());
    c.startHeartbeat();
  }

  private onFrame(c: Conn, data: RawData, isBinary: boolean): void {
    let json: unknown;
    let parsedJson = false;
    if (!isBinary) {
      try {
        json = JSON.parse(rawToString(data));
        parsedJson = true;
      } catch {
        parsedJson = false;
      }
    }
    const t = parsedJson && isRecord(json) && typeof json['t'] === 'string' ? json['t'] : null;
    const parsed = parsedJson ? clientMsgSchema.safeParse(json) : null;

    if (!parsed?.success) {
      if (t !== null && SIGNALS.has(t)) {
        // Signals never get an outcome; a bad telemetry batch is counted as dropped.
        if (t === 'telemetry') this.handlers.telemetryDropped?.(c);
        return;
      }
      const isCommand = t !== null && COMMAND_TYPES.has(t);
      const actionId = isCommand && isRecord(json) ? validActionId(json['actionId']) : null;
      this.outcome(c, isCommand ? (t as CommandKind) : null, { actionId, result: 'rule', reasonCode: 'malformed_action' });
      if (c.malformed.hit() > this.ctx.config.ops.malformedCloseThreshold.count) c.close(CloseCode.POLICY, 'policy');
      return;
    }

    const msg = parsed.data;
    if (c.detached !== null) {
      if (msg.t === 'hello' || msg.t === 'action' || msg.t === 'lobby' || msg.t === 'control') {
        this.outcome(c, msg.t, { actionId: msg.actionId, result: 'auth', reasonCode: c.detached });
      }
      return;
    }
    const withinRate = c.rate.take();
    switch (msg.t) {
      case 'pong':
        c.armDeadline();
        if (msg.id === c.pingId && c.pingSentAt !== null) {
          serverMetrics(this.ctx.telemetry).wsRtt.record((performance.now() - c.pingSentAt) / 1000);
          c.pingSentAt = null;
        }
        return;
      case 'ack':
        if (withinRate) this.handlers.ack?.(c, msg.seq);
        return;
      case 'visibility':
        c.hiddenSince = msg.state === 'hidden' ? this.ctx.clock.now() : null;
        if (withinRate) this.handlers.visibility?.(c, msg.state);
        return;
      case 'resync':
        if (withinRate) withRootSpan(this.ctx.telemetry.tracer, 'catan.resync', SpanKind.SERVER, { 'catan.resync.trigger': 'resync' }, () => this.handlers.resync?.(c));
        return;
      case 'telemetry':
        if (withinRate) this.handlers.telemetry?.(c, msg);
        else this.handlers.telemetryDropped?.(c);
        return;
      case 'hello':
        // One root catan.resync span per hello (design §9.3), with the outcome and no ids.
        withRootSpan(this.ctx.telemetry.tracer, 'catan.resync', SpanKind.SERVER, { 'catan.resync.trigger': 'hello' }, (span) => {
          const o = this.dispatch(c, msg, withinRate);
          span.setAttribute('catan.result', o.result);
          if (o.reasonCode !== undefined) span.setAttribute('catan.reason_code', o.reasonCode);
          if (o.reasonCode === 'internal_error') span.setStatus({ code: SpanStatusCode.ERROR });
        });
        return;
      case 'action':
      case 'lobby':
      case 'control':
        this.inActionSpan(c, msg, () => this.dispatch(c, msg, withinRate));
        return;
    }
  }

  /**
   * Exactly one catan.action span (kind SERVER, no children) per action, lobby and control message, from receipt to
   * its outcome, plus catan.action.duration{result} (design §9.2, §9.3). Handlers add their own attributes to the active
   * span. An internal_error outcome sets the span status to ERROR.
   */
  private inActionSpan(c: Conn, msg: ActionMsg | LobbyMsg | ControlMsg, run: () => OutcomeRecord): void {
    const t0 = performance.now();
    this.ctx.telemetry.tracer.startActiveSpan('catan.action', { kind: SpanKind.SERVER }, (span) => {
      // type = the Action type, or the lobby/control op kind (design D23; the sets are disjoint). The action handler sets
      // an action's group (it depends on the phase); lobby and control messages have fixed groups.
      span.setAttributes({ 'catan.action.type': msg.t === 'action' ? msg.action.type : msg.op.kind, 'catan.action_id': msg.actionId });
      if (msg.t !== 'action') span.setAttribute('catan.action.group', msg.t);
      const b = c.binding;
      if (b !== null) {
        span.setAttribute('catan.game.id', b.gameId);
        if (b.seat !== null) span.setAttribute('catan.seat', b.seat);
      }
      let o: OutcomeRecord = { actionId: msg.actionId, result: 'error', reasonCode: 'internal_error' };
      try {
        o = run();
      } finally {
        span.setAttribute('catan.result', o.result);
        if (o.reasonCode !== undefined) span.setAttribute('catan.reason_code', o.reasonCode);
        if (o.reasonCode === 'internal_error') span.setStatus({ code: SpanStatusCode.ERROR });
        serverMetrics(this.ctx.telemetry).actionDuration.record((performance.now() - t0) / 1000, { result: o.result });
        span.end();
      }
    });
  }

  /** Rate checks, the handler and the single outcome for one hello/action/lobby/control message; returns the outcome. */
  private dispatch(c: Conn, msg: HelloMsg | ActionMsg | LobbyMsg | ControlMsg, withinRate: boolean): OutcomeRecord {
    if (!withinRate) {
      return this.outcome(c, msg.t, { actionId: msg.actionId, result: 'error', reasonCode: 'rate_limited' });
    }
    if (msg.t === 'hello' && this.failedCodes.blocked(c.ip)) {
      const o = this.outcome(c, msg.t, { actionId: msg.actionId, result: 'auth', reasonCode: 'rate_limited_auth' });
      c.close(CloseCode.AUTH_FAILED, 'policy');
      return o;
    }

    let res: CommandResult;
    try {
      switch (msg.t) {
        case 'hello':
          res = this.handlers.hello(c, msg);
          break;
        case 'action':
          res = this.handlers.action(c, msg);
          break;
        case 'lobby':
          res = this.handlers.lobby(c, msg);
          break;
        case 'control':
          res = this.handlers.control(c, msg);
          break;
      }
    } catch (err) {
      this.handlers.handlerError?.(err, msg.t, c, msg);
      res = { result: 'error', reasonCode: 'internal_error' };
    }
    const o = this.outcome(c, msg.t, {
      actionId: msg.actionId,
      result: res.result,
      ...(res.reasonCode !== undefined ? { reasonCode: res.reasonCode } : {}),
      ...(res.seq !== undefined ? { seq: res.seq } : {}),
    });
    if (res.close !== undefined) c.close(res.close, res.close === CloseCode.SUPERSEDED ? 'superseded' : 'policy');
    return o;
  }

  private outcome(c: Conn, kind: CommandKind | null, o: OutcomeRecord): OutcomeRecord {
    c.raw({ t: 'outcome', ...o });
    this.handlers.outcome?.(c, kind, o);
    return o;
  }

  private onClose(c: Conn, code: number): void {
    c.stopTimers();
    this.conns.delete(c);
    const binding = c.binding;
    const seatedSince = c.seatedSince;
    this.unbind(c);
    const cls = classifyDisconnect({
      serverCause: c.serverCause,
      code,
      hiddenSince: c.hiddenSince,
      now: this.ctx.clock.now(),
      backgroundGraceMs: this.ctx.config.telemetry.backgroundGraceSec * 1000,
    });
    this.handlers.disconnected?.(c, { ...cls, binding, connectedMs: this.ctx.clock.now() - c.openedAt, seatedSince });
  }

  private unbind(c: Conn): void {
    const b = c.binding;
    if (!b) return;
    this.members.get(b.gameId)?.delete(c);
    if (this.members.get(b.gameId)?.size === 0) this.members.delete(b.gameId);
    if (b.seat !== null) {
      const seats = this.seats.get(b.gameId);
      if (seats?.get(b.seat) === c) seats.delete(b.seat);
      if (seats?.size === 0) this.seats.delete(b.gameId);
    }
    c.binding = null;
    c.seatedSince = null;
  }
}

/**
 * Browsers always send Origin on WebSocket upgrades. An upgrade is allowed when it has no Origin (non-browser
 * clients), when its Origin is in allowedOrigins, or — with an empty allow-list — when the Origin matches the Host.
 */
export function originAllowed(req: IncomingMessage, allowed: readonly string[]): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  if (allowed.length > 0) return allowed.includes(origin);
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function refuse(socket: Duplex, status: 403 | 404 | 503): void {
  const text = { 403: 'Forbidden', 404: 'Not Found', 503: 'Service Unavailable' }[status];
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function requestPath(req: IncomingMessage): string {
  const url = req.url ?? '';
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validActionId(v: unknown): string | null {
  return actionIdSchema.safeParse(v).success ? (v as string) : null;
}
