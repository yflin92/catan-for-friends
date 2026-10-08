// WsClient: the browser's single WebSocket session with the server (design §2.4, §3.11, §5.2, §5.5; ADR-0004).
// - Connects, authenticates with hello, and reconnects with backoff 0, 250 ms, 500 ms, 1 s, 2 s, then 4 s (±20 %
//   jitter); immediately on `online` and on visibility → visible.
// - Close codes 4001 (superseded), 4401 (auth failed) and 4410 (game gone) are terminal; every other close
//   reconnects. A close the client asked for is terminal too.
// - Adopts a welcome view when its seq ≥ the local seq and a state view when its seq > the local seq; never renders
//   an older view. A state that skips seqs is adopted (it is a full view) and a resync is also requested.
// - Every action, lobby and control message stays pending until its outcome arrives, and is resent with its original
//   actionId, in order, after each welcome. There are no optimistic updates.
// - Signals: ack per applied state, pong per ping, visibility changes, and telemetry batches every 15 s and after
//   each reconnect (G1 sample rules in telemetry.ts).
import { publicProjectionHash, viewHash, type Action } from '@hexlands/engine';
import {
  CloseCode,
  PROTOCOL_VERSION,
  TELEMETRY_MIN_BATCH_INTERVAL_MS,
  serverMsgSchema,
  type ClientMsg,
  type ControlOp,
  type LobbyOp,
  type OutcomeRecord,
  type ServerMsgWire,
} from '@hexlands/protocol';
import { readCredentials, writeCredentials } from './fragment';
import type { LogStore } from './log-store';
import type { Pending, Store, TerminalReason } from './store';
import { GapClock, TelemetryBuffer } from './telemetry';
import type { ActionId, PlayerViewWire, RoomView } from './wire';

/** Reconnect delays before jitter; the last one repeats. */
export const BACKOFF_MS: readonly number[] = [0, 250, 500, 1000, 2000, 4000];
export const BACKOFF_JITTER = 0.2;
export const TELEMETRY_INTERVAL_MS = 15_000;

/** The subset of the browser WebSocket the client uses. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface Timers {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(h: unknown): void;
}

/** Page visibility and network state, with change notifications. */
export interface PageEnv {
  isVisible(): boolean;
  isOnline(): boolean;
  /** Subscribes to visible/hidden/online/offline changes; returns an unsubscribe function. */
  subscribe(listener: (event: 'visible' | 'hidden' | 'online' | 'offline') => void): () => void;
  /** location.href, used only to scrub it from error reports. */
  href(): string;
}

export interface WsClientDeps {
  readonly url: string;
  readonly createSocket: (url: string) => SocketLike;
  readonly store: Store;
  readonly log?: LogStore;
  readonly storage: Pick<Storage, 'getItem' | 'setItem'>;
  readonly timers: Timers;
  readonly page: PageEnv;
  readonly random: () => number;
  readonly uuid: () => string;
  /** This bundle's build version, compared with room.buildVersion. */
  readonly buildVersion: string;
}

type OutcomeListener = (o: OutcomeRecord) => void;

interface PendingEntry {
  readonly entry: Pending;
  /** Connection the message was last sent on; null while unsent. */
  conn: number | null;
  /** Send time on that connection. */
  sentAt: number;
  /** True once the message has been sent on more than one connection; such actions are never RTT-sampled. */
  resent: boolean;
  readonly resolve: OutcomeListener;
}

const OPEN = 1;

export class WsClient {
  private readonly d: WsClientDeps;
  private readonly telemetry = new TelemetryBuffer();
  private readonly pending = new Map<ActionId, PendingEntry>();
  private roomCode: string | null = null;
  private socket: SocketLike | null = null;
  private conn = 0;
  private welcomed = false;
  private helloId: ActionId | null = null;
  private attempt = 0;
  private reconnectTimer: unknown = null;
  private telemetryTimer: unknown = null;
  private deferredFlush: unknown = null;
  private lastBatchAt: number | null = null;
  private gap: { clock: GapClock; cause: 'network' | 'server_restart' } | null = null;
  private stopped = true;
  private unsubscribePage: (() => void) | null = null;

  constructor(deps: WsClientDeps) {
    this.d = deps;
  }

  /** Starts (or switches to) the session for `roomCode`, using the credentials stored for it. */
  start(roomCode: string): void {
    if (this.roomCode !== roomCode) {
      this.stop();
      this.d.store.update({ room: null, view: null, seq: null, viewHash: '', publicHash: '', seat: null });
      this.d.log?.clear();
    }
    this.roomCode = roomCode;
    this.d.store.update({ roomCode });
    this.stopped = false;
    this.unsubscribePage ??= this.d.page.subscribe((e) => this.onPageEvent(e));
    this.telemetryTimer ??= this.d.timers.setInterval(() => this.flushTelemetry(), TELEMETRY_INTERVAL_MS);
    this.setConnection('connecting', null);
    this.connectNow();
  }

  /** Closes the session; nothing reconnects until start() or useHere(). */
  stop(): void {
    this.stopped = true;
    this.clearReconnect();
    this.closeSocket(CloseCode.NORMAL);
    if (this.telemetryTimer !== null) this.d.timers.clearInterval(this.telemetryTimer);
    if (this.deferredFlush !== null) this.d.timers.clearTimeout(this.deferredFlush);
    this.telemetryTimer = null;
    this.deferredFlush = null;
    this.unsubscribePage?.();
    this.unsubscribePage = null;
    this.setConnection('idle', null);
  }

  /** After "This seat was opened on another device": reconnect here, superseding the other device. */
  useHere(): void {
    if (this.roomCode === null) return;
    this.start(this.roomCode);
  }

  sendAction(action: Action): Promise<OutcomeRecord> {
    const actionId = this.d.uuid();
    return this.submit({ t: 'action', actionId, baseSeq: this.d.store.getSnapshot().seq ?? 0, action });
  }

  sendLobby(op: LobbyOp): Promise<OutcomeRecord> {
    return this.submit({ t: 'lobby', actionId: this.d.uuid(), op });
  }

  sendControl(op: ControlOp): Promise<OutcomeRecord> {
    return this.submit({ t: 'control', actionId: this.d.uuid(), op });
  }

  /** Records a client-side error for the next telemetry batch (sanitised). */
  reportError(kind: 'js_error' | 'ws_protocol' | 'render' | 'other', message: string): void {
    this.telemetry.addError(kind, message, this.d.page.href());
  }

  // ── sending ────────────────────────────────────────────────────────────────

  private submit(msg: Extract<ClientMsg, { t: 'action' | 'lobby' | 'control' }>): Promise<OutcomeRecord> {
    return new Promise<OutcomeRecord>((resolve) => {
      const entry: Pending = { actionId: msg.actionId, msg, sentAt: this.d.timers.now() };
      const p: PendingEntry = { entry, conn: null, sentAt: entry.sentAt, resent: false, resolve };
      this.pending.set(msg.actionId, p);
      this.publishPending();
      if (this.welcomed) this.sendPending(p);
    });
  }

  private sendPending(p: PendingEntry): void {
    if (p.conn !== null && p.conn !== this.conn) p.resent = true;
    p.conn = this.conn;
    p.sentAt = this.d.timers.now();
    this.sendRaw(p.entry.msg as ClientMsg);
  }

  private sendRaw(msg: ClientMsg): boolean {
    const s = this.socket;
    if (s === null || s.readyState !== OPEN) return false;
    s.send(JSON.stringify(msg));
    return true;
  }

  /** Signals go only on an authenticated (welcomed) connection. */
  private sendSignal(msg: Extract<ClientMsg, { t: 'resync' | 'ack' | 'pong' | 'visibility' | 'telemetry' }>): boolean {
    return this.welcomed && this.sendRaw(msg);
  }

  private publishPending(): void {
    this.d.store.update({ pending: new Map([...this.pending].map(([id, p]) => [id, p.entry])) });
  }

  // ── connection lifecycle ───────────────────────────────────────────────────

  private connectNow(): void {
    this.clearReconnect();
    if (this.stopped || this.roomCode === null || this.socket !== null) return;
    const conn = ++this.conn;
    const socket = this.d.createSocket(this.d.url);
    this.socket = socket;
    this.welcomed = false;
    this.lastBatchAt = null;
    socket.onopen = () => {
      if (conn === this.conn) this.sendHello();
    };
    socket.onmessage = (ev) => {
      if (conn === this.conn) this.onFrame(ev.data);
    };
    socket.onclose = (ev) => {
      if (conn === this.conn) this.onClose(ev.code);
    };
    socket.onerror = () => undefined;
  }

  private sendHello(): void {
    if (this.roomCode === null) return;
    const creds = readCredentials(this.d.storage, this.roomCode);
    const seq = this.d.store.getSnapshot().seq;
    this.helloId = this.d.uuid();
    this.sendRaw({
      t: 'hello',
      v: PROTOCOL_VERSION,
      actionId: this.helloId,
      roomCode: this.roomCode,
      ...(creds?.seatToken !== undefined ? { seatToken: creds.seatToken } : {}),
      ...(seq !== null ? { lastSeq: seq } : {}),
    });
  }

  private onClose(code: number): void {
    this.socket = null;
    this.welcomed = false;
    if (this.stopped) return;
    const terminal = terminalReason(code);
    if (terminal !== null) {
      this.stopped = true;
      this.gap = null;
      this.setConnection('stopped', terminal);
      return;
    }
    if (this.gap === null) {
      const now = this.d.timers.now();
      this.gap = {
        clock: new GapClock(now, this.d.page.isVisible() && this.d.page.isOnline()),
        cause: code === CloseCode.SERVICE_RESTART ? 'server_restart' : 'network',
      };
    }
    this.setConnection('reconnecting', null);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    this.clearReconnect();
    const base = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)] ?? 0;
    this.attempt += 1;
    const delay = base * (1 + (this.d.random() * 2 - 1) * BACKOFF_JITTER);
    this.reconnectTimer = this.d.timers.setTimeout(() => {
      this.reconnectTimer = null;
      this.connectNow();
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) this.d.timers.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private closeSocket(code: number): void {
    const s = this.socket;
    this.socket = null;
    this.welcomed = false;
    if (s !== null) {
      s.onopen = s.onmessage = s.onclose = s.onerror = null;
      s.close(code);
    }
  }

  private onPageEvent(e: 'visible' | 'hidden' | 'online' | 'offline'): void {
    const now = this.d.timers.now();
    if (e === 'hidden' || e === 'offline') {
      this.gap?.clock.pause(now);
      if (e === 'hidden') this.sendSignal({ t: 'visibility', state: 'hidden' });
      return;
    }
    if (this.d.page.isVisible() && this.d.page.isOnline()) this.gap?.clock.resume(now);
    if (e === 'visible') {
      this.sendSignal({ t: 'visibility', state: 'visible' });
      this.sendSignal({ t: 'resync' });
    }
    if (!this.stopped && this.socket === null) this.connectNow();
  }

  private setConnection(status: 'idle' | 'connecting' | 'open' | 'reconnecting' | 'stopped', terminal: TerminalReason | null): void {
    const cur = this.d.store.getSnapshot().connection;
    if (cur.status !== status || cur.terminal !== terminal) this.d.store.update({ connection: { status, terminal } });
  }

  // ── receiving ──────────────────────────────────────────────────────────────

  private onFrame(data: unknown): void {
    let json: unknown;
    try {
      json = JSON.parse(typeof data === 'string' ? data : '');
    } catch {
      this.reportError('ws_protocol', 'server frame is not JSON');
      return;
    }
    const parsed = serverMsgSchema.safeParse(json);
    if (!parsed.success) {
      const t = typeof json === 'object' && json !== null && 't' in json ? String((json as { t: unknown }).t) : '?';
      this.reportError('ws_protocol', `unparseable server frame (t=${t})`);
      return;
    }
    this.onMessage(parsed.data);
  }

  private onMessage(msg: ServerMsgWire): void {
    switch (msg.t) {
      case 'welcome':
        return this.onWelcome(msg);
      case 'state':
        return this.onState(msg.seq, msg.view);
      case 'room':
        // yourSeat is per recipient and authoritative after a reorder, shuffle or start (design D9).
        this.applyRoom(msg.room);
        this.d.store.update({ seat: msg.yourSeat });
        return;
      case 'outcome':
        return this.onOutcome(msg);
      case 'seatToken':
        // A relinked token belongs to another player's seat (sent to the host only): it is held for the host to copy,
        // and this tab's own credentials and seat are untouched.
        if (msg.purpose === 'relinked') {
          this.d.store.update({ relinked: { seat: msg.seat, seatToken: msg.seatToken } });
          return;
        }
        if (this.roomCode !== null) writeCredentials(this.d.storage, { roomCode: this.roomCode, seatToken: msg.seatToken });
        this.d.store.update({ seat: msg.seat });
        return;
      case 'superseded':
        return;
      case 'ping':
        this.sendSignal({ t: 'pong', id: msg.id });
        return;
    }
  }

  private onWelcome(msg: Extract<ServerMsgWire, { t: 'welcome' }>): void {
    const local = this.d.store.getSnapshot().seq;
    this.d.store.update({ seat: msg.seat });
    this.applyRoom(msg.room);
    if (msg.view !== null && (local === null || msg.seq >= local)) this.adoptView(msg.seq, msg.view);
    this.welcomed = true;
    this.attempt = 0;
    this.setConnection('open', null);
    const reconnected = this.gap !== null;
    if (this.gap !== null) {
      this.telemetry.addResumeGap(this.gap.clock.elapsed(this.d.timers.now()), this.gap.cause);
      this.gap = null;
    }
    for (const p of this.pending.values()) this.sendPending(p);
    if (reconnected) this.flushTelemetry();
  }

  private onState(seq: number, view: PlayerViewWire): void {
    const local = this.d.store.getSnapshot().seq;
    if (local !== null && seq <= local) return;
    if (!this.adoptView(seq, view)) return;
    this.sendSignal({ t: 'ack', seq });
    if (local !== null && seq > local + 1) this.sendSignal({ t: 'resync' });
  }

  /**
   * Adopts a view exactly as received, with its viewHash and publicProjectionHash (TH15, D7). A view the hash helpers
   * reject (TypeError on non-JSON-safe input) is reported as a malformed view and not adopted.
   */
  private adoptView(seq: number, view: PlayerViewWire): boolean {
    let vh: string;
    let ph: string;
    try {
      vh = viewHash(view);
      ph = publicProjectionHash(view);
    } catch (err) {
      this.reportError('ws_protocol', `malformed view at seq ${seq}: ${err instanceof Error ? err.message : 'hash failed'}`);
      return false;
    }
    this.d.store.update({ view, seq, viewHash: vh, publicHash: ph });
    this.d.log?.merge(view.log);
    return true;
  }

  /**
   * A hello answered with a non-ok outcome ends this connection attempt even if the server keeps the socket open:
   * - auth/* and game_expired are terminal (no reconnect loop);
   * - rate_limited, rate_limited_auth and server_draining retry with backoff;
   * - anything else stops with a generic error the user can retry.
   */
  private onHelloRejected(result: OutcomeRecord['result'], code: string | undefined): void {
    this.closeSocket(CloseCode.NORMAL);
    if (result === 'auth' && code !== 'rate_limited_auth') {
      this.stop();
      this.setConnection('stopped', 'auth_failed');
      return;
    }
    if (code === 'game_expired') {
      this.stop();
      this.setConnection('stopped', 'game_gone');
      return;
    }
    if (code === 'rate_limited' || code === 'rate_limited_auth' || code === 'server_draining') {
      this.setConnection('reconnecting', null);
      this.scheduleReconnect();
      return;
    }
    this.stop();
    this.setConnection('stopped', 'connect_failed');
  }

  private applyRoom(room: RoomView): void {
    this.d.store.update({ room, staleBundle: isStaleBundle(room.buildVersion, this.d.buildVersion) });
  }

  private onOutcome(o: OutcomeRecord): void {
    if (o.actionId === null) {
      this.reportError('ws_protocol', `server reported a malformed client frame (${o.reasonCode ?? 'no code'})`);
      return;
    }
    if (o.actionId === this.helloId) {
      this.helloId = null;
      if (o.result !== 'ok') this.onHelloRejected(o.result, o.reasonCode);
      return;
    }
    const p = this.pending.get(o.actionId);
    if (p === undefined) return;
    this.pending.delete(o.actionId);
    if (!p.resent && p.conn === this.conn) this.telemetry.addActionRtt(this.d.timers.now() - p.sentAt);
    this.publishPending();
    p.resolve(o);
  }

  // ── telemetry ──────────────────────────────────────────────────────────────

  /** Sends one batch if there is data and the socket has not sent one in the last 5 s; otherwise defers. */
  private flushTelemetry(): void {
    if (!this.welcomed || this.telemetry.isEmpty) return;
    const now = this.d.timers.now();
    if (this.lastBatchAt !== null && now - this.lastBatchAt < TELEMETRY_MIN_BATCH_INTERVAL_MS) {
      if (this.deferredFlush === null) {
        this.deferredFlush = this.d.timers.setTimeout(() => {
          this.deferredFlush = null;
          this.flushTelemetry();
        }, TELEMETRY_MIN_BATCH_INTERVAL_MS - (now - this.lastBatchAt));
      }
      return;
    }
    const batch = this.telemetry.takeBatch();
    if (batch !== null && this.sendSignal(batch)) this.lastBatchAt = now;
  }
}

/** True when server and bundle versions differ; a 'dev' build on either side never counts as stale (design D12). */
export function isStaleBundle(serverVersion: string, bundleVersion: string): boolean {
  return serverVersion !== 'dev' && bundleVersion !== 'dev' && serverVersion !== bundleVersion;
}

function terminalReason(code: number): TerminalReason | null {
  switch (code) {
    case CloseCode.SUPERSEDED:
      return 'superseded';
    case CloseCode.AUTH_FAILED:
      return 'auth_failed';
    case CloseCode.GAME_GONE:
      return 'game_gone';
    default:
      return null;
  }
}

/** PageEnv over the real document and window. */
export function browserPageEnv(win: Window): PageEnv {
  const doc = win.document;
  return {
    isVisible: () => doc.visibilityState !== 'hidden',
    isOnline: () => win.navigator.onLine,
    href: () => win.location.href,
    subscribe(listener) {
      const onVis = () => listener(doc.visibilityState === 'hidden' ? 'hidden' : 'visible');
      const onOnline = () => listener('online');
      const onOffline = () => listener('offline');
      doc.addEventListener('visibilitychange', onVis);
      win.addEventListener('online', onOnline);
      win.addEventListener('offline', onOffline);
      return () => {
        doc.removeEventListener('visibilitychange', onVis);
        win.removeEventListener('online', onOnline);
        win.removeEventListener('offline', onOffline);
      };
    },
  };
}

/** A SocketLike over the browser WebSocket. */
export function browserSocket(url: string): SocketLike {
  const ws = new WebSocket(url);
  const s: SocketLike = {
    get readyState() {
      return ws.readyState;
    },
    send: (data) => ws.send(data),
    close: (code, reason) => ws.close(code, reason),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  ws.onopen = (ev) => s.onopen?.(ev);
  ws.onmessage = (ev: MessageEvent) => s.onmessage?.({ data: ev.data });
  ws.onclose = (ev: CloseEvent) => s.onclose?.({ code: ev.code });
  ws.onerror = (ev) => s.onerror?.(ev);
  return s;
}

/** The same-origin WebSocket URL for the page (`/ws`); no secret ever goes in it. */
export function wsUrl(loc: Pick<Location, 'protocol' | 'host'>): string {
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/ws`;
}
