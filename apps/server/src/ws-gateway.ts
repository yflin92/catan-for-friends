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
import type { Duplex } from 'node:stream';
import type { OutcomeResult, ReasonCode, Seat } from '@hexlands/engine';
import {
  CloseCode,
  MAX_INBOUND_FRAME_BYTES,
  SIGNAL_TYPES,
  actionIdSchema,
  clientMsgSchema,
  type ActionMsg,
  type ControlMsg,
  type HelloMsg,
  type LobbyMsg,
  type OutcomeRecord,
  type ServerMsg,
  type TelemetryMsg,
} from '@hexlands/protocol';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import type { ServerContext } from './server';
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
}

/** One client socket as seen by handlers. */
export interface Connection {
  readonly id: number;
  readonly binding: Binding | null;
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
  /** A handler threw; the sender got error/internal_error. */
  handlerError?(err: unknown, kind: string): void;
}

class Conn implements Connection {
  binding: Binding | null = null;
  serverCause: ServerCloseCause | null = null;
  hiddenSince: number | null = null;
  readonly openedAt: number;
  pingId = 0;
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
    this.timers.push(clock.setInterval(() => this.raw({ t: 'ping', id: ++this.pingId }), HEARTBEAT_INTERVAL_MS));
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
    this.unbind(c);
    c.binding = binding;
    let members = this.members.get(binding.gameId);
    if (!members) this.members.set(binding.gameId, (members = new Set()));
    members.add(c);
    if (binding.seat === null) return null;
    let seats = this.seats.get(binding.gameId);
    if (!seats) this.seats.set(binding.gameId, (seats = new Map()));
    const previous = seats.get(binding.seat) ?? null;
    seats.set(binding.seat, c);
    // The previous socket keeps its own binding (its disconnect still counts, as superseded) but no longer receives
    // the seat's traffic.
    return previous && previous !== c ? previous : null;
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

  /** The socket currently bound to (gameId, seat). */
  connectionOf(gameId: string, seat: Seat): Connection | null {
    return this.seats.get(gameId)?.get(seat) ?? null;
  }

  /** Every socket bound to the game, seated or not. */
  connectionsOf(gameId: string): readonly Connection[] {
    return [...(this.members.get(gameId) ?? [])];
  }

  /** Number of open sockets. */
  get size(): number {
    return this.conns.size;
  }

  /** Closes every socket with `code` and stops accepting upgrades. */
  async close(code: number = CloseCode.GOING_AWAY, cause: ServerCloseCause = 'shutdown'): Promise<void> {
    this.draining = true;
    for (const c of this.conns) c.close(code, cause);
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
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
    const withinRate = c.rate.take();
    switch (msg.t) {
      case 'pong':
        c.armDeadline();
        return;
      case 'ack':
        if (withinRate) this.handlers.ack?.(c, msg.seq);
        return;
      case 'visibility':
        c.hiddenSince = msg.state === 'hidden' ? this.ctx.clock.now() : null;
        if (withinRate) this.handlers.visibility?.(c, msg.state);
        return;
      case 'resync':
        if (withinRate) this.handlers.resync?.(c);
        return;
      case 'telemetry':
        if (withinRate) this.handlers.telemetry?.(c, msg);
        else this.handlers.telemetryDropped?.(c);
        return;
      case 'hello':
      case 'action':
      case 'lobby':
      case 'control':
        break;
    }

    if (!withinRate) {
      this.outcome(c, msg.t, { actionId: msg.actionId, result: 'error', reasonCode: 'rate_limited' });
      return;
    }
    if (msg.t === 'hello' && this.failedCodes.blocked(c.ip)) {
      this.outcome(c, msg.t, { actionId: msg.actionId, result: 'auth', reasonCode: 'rate_limited_auth' });
      c.close(CloseCode.AUTH_FAILED, 'policy');
      return;
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
      this.handlers.handlerError?.(err, msg.t);
      res = { result: 'error', reasonCode: 'internal_error' };
    }
    this.outcome(c, msg.t, {
      actionId: msg.actionId,
      result: res.result,
      ...(res.reasonCode !== undefined ? { reasonCode: res.reasonCode } : {}),
      ...(res.seq !== undefined ? { seq: res.seq } : {}),
    });
    if (res.close !== undefined) c.close(res.close, res.close === CloseCode.SUPERSEDED ? 'superseded' : 'policy');
  }

  private outcome(c: Conn, kind: CommandKind | null, o: OutcomeRecord): void {
    c.raw({ t: 'outcome', ...o });
    this.handlers.outcome?.(c, kind, o);
  }

  private onClose(c: Conn, code: number): void {
    c.stopTimers();
    this.conns.delete(c);
    const binding = c.binding;
    this.unbind(c);
    const cls = classifyDisconnect({
      serverCause: c.serverCause,
      code,
      hiddenSince: c.hiddenSince,
      now: this.ctx.clock.now(),
      backgroundGraceMs: this.ctx.config.telemetry.backgroundGraceSec * 1000,
    });
    this.handlers.disconnected?.(c, { ...cls, binding, connectedMs: this.ctx.clock.now() - c.openedAt });
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
