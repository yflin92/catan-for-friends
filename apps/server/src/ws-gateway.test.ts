import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DeepPartial } from './config';
import type { ServerConfig } from '@hexlands/engine';
import { MAX_INBOUND_FRAME_BYTES } from '@hexlands/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { FakeClock, SystemClock, type Clock, type Scheduler } from './clock';
import { loadServerConfig } from './config';
import type { ServerContext } from './server';
import { startServer } from './server';
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  WsGateway,
  originAllowed,
  type CommandResult,
  type Connection,
  type DisconnectInfo,
  type GatewayHandlers,
} from './ws-gateway';

const ID = '3b241101-e2bb-4255-8caf-4136c566a962';
const ID2 = '9f0c1a52-6d6e-4b8c-9a7e-2f1e8c3d4b5a';

interface Harness {
  readonly gw: WsGateway;
  readonly port: number;
  readonly calls: { kind: string; arg?: unknown }[];
  readonly disconnects: DisconnectInfo[];
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function harness(
  opts: { config?: DeepPartial<ServerConfig>; clock?: Clock & Scheduler; allowedOrigins?: string[]; handlers?: Partial<GatewayHandlers> } = {},
): Promise<Harness> {
  const calls: Harness['calls'] = [];
  const disconnects: DisconnectInfo[] = [];
  const ok: CommandResult = { result: 'ok' };
  const handlers: GatewayHandlers = {
    hello: (_c, m) => (calls.push({ kind: 'hello', arg: m }), ok),
    action: (_c, m) => (calls.push({ kind: 'action', arg: m }), ok),
    lobby: (_c, m) => (calls.push({ kind: 'lobby', arg: m }), ok),
    control: (_c, m) => (calls.push({ kind: 'control', arg: m }), ok),
    resync: () => void calls.push({ kind: 'resync' }),
    ack: (_c, seq) => void calls.push({ kind: 'ack', arg: seq }),
    visibility: (_c, s) => void calls.push({ kind: 'visibility', arg: s }),
    telemetry: (_c, m) => void calls.push({ kind: 'telemetry', arg: m }),
    telemetryDropped: () => void calls.push({ kind: 'telemetryDropped' }),
    disconnected: (_c, info) => void disconnects.push(info),
    ...opts.handlers,
  };
  const ctx = {
    config: loadServerConfig({}, opts.config),
    clock: opts.clock ?? new SystemClock(),
    allowedOrigins: opts.allowedOrigins ?? [],
  } as unknown as ServerContext;
  const gw = new WsGateway(ctx, handlers);
  const http: Server = createServer((_q, r) => r.end());
  http.on('upgrade', (req, socket, head) => gw.handleUpgrade(req, socket, head));
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  cleanups.push(async () => {
    await gw.close();
    http.closeAllConnections();
    await new Promise<void>((r) => http.close(() => r()));
  });
  return { gw, port: (http.address() as AddressInfo).port, calls, disconnects };
}

interface Client {
  readonly ws: WebSocket;
  next(): Promise<Record<string, unknown>>;
  closed: Promise<number>;
  received: Record<string, unknown>[];
  send(v: unknown): void;
}

async function connect(port: number, path = '/ws', headers: Record<string, string> = {}): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
  const received: Record<string, unknown>[] = [];
  const waiters: ((m: Record<string, unknown>) => void)[] = [];
  ws.on('message', (d) => {
    const m = JSON.parse(String(d)) as Record<string, unknown>;
    const w = waiters.shift();
    if (w) w(m);
    else received.push(m);
  });
  const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
  await new Promise<void>((resolve, reject) => ws.once('open', () => resolve()).once('error', reject));
  return {
    ws,
    received,
    closed,
    next: () => {
      const m = received.shift();
      return m ? Promise.resolve(m) : new Promise((r) => waiters.push(r));
    },
    send: (v) => ws.send(typeof v === 'string' ? v : JSON.stringify(v)),
  };
}

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

function upgradeStatus(port: number, path: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers },
    });
    req.on('response', (res) => resolve(res.statusCode ?? 0));
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('upgrade (design §2.3, §8)', () => {
  it('accepts /ws and refuses other paths', async () => {
    const h = await harness();
    expect(await upgradeStatus(h.port, '/ws')).toBe(101);
    expect(await upgradeStatus(h.port, '/other')).toBe(404);
    expect(await upgradeStatus(h.port, '/ws?roomCode=ABCDEF')).toBe(101);
  });

  it('enforces the Origin allow-list', async () => {
    const h = await harness({ allowedOrigins: ['https://hexlands.example'] });
    expect(await upgradeStatus(h.port, '/ws', { Origin: 'https://hexlands.example' })).toBe(101);
    expect(await upgradeStatus(h.port, '/ws', { Origin: 'https://evil.example' })).toBe(403);
    expect(await upgradeStatus(h.port, '/ws')).toBe(101);
  });

  it('with an empty allow-list accepts only same-origin browsers', async () => {
    const h = await harness();
    expect(await upgradeStatus(h.port, '/ws', { Origin: `http://127.0.0.1:${h.port}` })).toBe(101);
    expect(await upgradeStatus(h.port, '/ws', { Origin: 'https://evil.example' })).toBe(403);
    expect(originAllowed({ headers: { origin: 'not a url', host: 'x' } } as never, [])).toBe(false);
  });

  it('refuses upgrades with 503 while draining', async () => {
    const h = await harness();
    h.gw.setDraining(true);
    expect(await upgradeStatus(h.port, '/ws')).toBe(503);
  });
});

describe('frames, malformed input and outcomes (AC20, P1)', () => {
  it('sends exactly one outcome per command, after anything the handler sent', async () => {
    const h = await harness({
      handlers: {
        hello: (c) => {
          c.send({ t: 'ping', id: 99 });
          return { result: 'ok' };
        },
        action: () => ({ result: 'rule', reasonCode: 'not_your_turn' }),
        lobby: () => ({ result: 'ok', seq: 4 }),
      },
    });
    const c = await connect(h.port);
    c.send({ t: 'hello', v: 1, actionId: ID, roomCode: 'ABCDEF' });
    expect(await c.next()).toEqual({ t: 'ping', id: 99 });
    expect(await c.next()).toEqual({ t: 'outcome', actionId: ID, result: 'ok' });
    c.send({ t: 'action', actionId: ID2, baseSeq: 1, action: { type: 'endTurn' } });
    expect(await c.next()).toEqual({ t: 'outcome', actionId: ID2, result: 'rule', reasonCode: 'not_your_turn' });
    c.send({ t: 'lobby', actionId: ID, op: { kind: 'start' } });
    expect(await c.next()).toEqual({ t: 'outcome', actionId: ID, result: 'ok', seq: 4 });
    await tick();
    expect(c.received).toEqual([]);
  });

  it('answers malformed frames with rule/malformed_action and keeps the socket open', async () => {
    const h = await harness();
    const c = await connect(h.port);
    const malformed = { t: 'outcome', actionId: null, result: 'rule', reasonCode: 'malformed_action' };
    for (const frame of ['not json', '[]', '{"t":"shout"}', '{"t":"action","baseSeq":1,"action":{"type":"endTurn"}}', '42']) {
      c.send(frame);
      expect(await c.next()).toEqual(malformed);
    }
    c.ws.send(Buffer.from([1, 2, 3]), { binary: true });
    expect(await c.next()).toEqual(malformed);
    c.send({ t: 'action', actionId: ID, baseSeq: 1, action: { type: 'teleport' } });
    expect(await c.next()).toEqual({ ...malformed, actionId: ID });
    c.send({ t: 'hello', v: 1, actionId: ID, roomCode: 'A', extra: 1 });
    expect(await c.next()).toEqual({ ...malformed, actionId: ID });
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    expect(h.calls).toEqual([]);
  });

  it('never answers signals, and drops malformed ones (telemetry counted as dropped)', async () => {
    const h = await harness();
    const c = await connect(h.port);
    c.send({ t: 'ack', seq: 3 });
    c.send({ t: 'resync' });
    c.send({ t: 'visibility', state: 'hidden' });
    c.send({ t: 'telemetry', actionRttMs: [12] });
    c.send({ t: 'pong', id: 1 });
    c.send({ t: 'ack', seq: 'x' });
    c.send({ t: 'telemetry', resumeGaps: [{ ms: 1, cause: 'wifi' }] });
    c.send({ t: 'resync', extra: true });
    await tick(100);
    expect(c.received).toEqual([]);
    expect(h.calls.map((x) => x.kind)).toEqual(['ack', 'resync', 'visibility', 'telemetry', 'telemetryDropped']);
    expect(h.calls[0]?.arg).toBe(3);
  });

  it('closes with 1008 after more than malformedCloseThreshold malformed frames in the window', async () => {
    const h = await harness({ config: { ops: { malformedCloseThreshold: { count: 3, windowSec: 60 } } } });
    const c = await connect(h.port);
    for (let i = 0; i < 4; i++) c.send('nope');
    expect(await c.closed).toBe(1008);
    expect(c.received).toHaveLength(4);
  });

  it('closes with 1009 when a frame exceeds 16 KiB', async () => {
    const h = await harness();
    const c = await connect(h.port);
    c.send({ t: 'hello', v: 1, actionId: ID, roomCode: 'x'.repeat(MAX_INBOUND_FRAME_BYTES) });
    expect(await c.closed).toBe(1009);
  });

  it('answers a throwing handler with error/internal_error', async () => {
    const errors: string[] = [];
    const h = await harness({
      handlers: {
        control: () => {
          throw new Error('boom');
        },
        handlerError: (_e, kind) => void errors.push(kind),
      },
    });
    const c = await connect(h.port);
    c.send({ t: 'control', actionId: ID, op: { kind: 'resume' } });
    expect(await c.next()).toEqual({ t: 'outcome', actionId: ID, result: 'error', reasonCode: 'internal_error' });
    expect(errors).toEqual(['control']);
  });

  it('closes after the outcome when the handler asks for it', async () => {
    const h = await harness({ handlers: { hello: () => ({ result: 'auth', reasonCode: 'bad_seat_token', close: 4401 }) } });
    const c = await connect(h.port);
    c.send({ t: 'hello', v: 1, actionId: ID, roomCode: 'ABCDEF', seatToken: 't' });
    expect(await c.next()).toEqual({ t: 'outcome', actionId: ID, result: 'auth', reasonCode: 'bad_seat_token' });
    expect(await c.closed).toBe(4401);
  });

  it('refuses to let handlers send outcomes', async () => {
    let threw = false;
    const h = await harness({
      handlers: {
        hello: (c) => {
          try {
            c.send({ t: 'outcome', actionId: null, result: 'ok' } as never);
          } catch {
            threw = true;
          }
          return { result: 'ok' };
        },
      },
    });
    const c = await connect(h.port);
    c.send({ t: 'hello', v: 1, actionId: ID, roomCode: 'A' });
    await c.next();
    expect(threw).toBe(true);
  });
});

describe('rate limits (P7, TH16)', () => {
  it('answers commands over the per-connection rate with error/rate_limited', async () => {
    const h = await harness({ clock: new FakeClock(0), config: { ops: { maxMsgsPerSecPerConn: 1, maxMsgBurstPerConn: 2 } } });
    const c = await connect(h.port);
    for (let i = 0; i < 3; i++) c.send({ t: 'action', actionId: ID, baseSeq: 1, action: { type: 'endTurn' } });
    expect(await c.next()).toMatchObject({ result: 'ok' });
    expect(await c.next()).toMatchObject({ result: 'ok' });
    expect(await c.next()).toEqual({ t: 'outcome', actionId: ID, result: 'error', reasonCode: 'rate_limited' });
    expect(h.calls).toHaveLength(2);
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('drops signals over the rate silently, counting telemetry as dropped', async () => {
    const h = await harness({ clock: new FakeClock(0), config: { ops: { maxMsgsPerSecPerConn: 1, maxMsgBurstPerConn: 1 } } });
    const c = await connect(h.port);
    c.send({ t: 'ack', seq: 1 });
    c.send({ t: 'ack', seq: 2 });
    c.send({ t: 'telemetry' });
    await tick(100);
    expect(c.received).toEqual([]);
    expect(h.calls.map((x) => x.kind)).toEqual(['ack', 'telemetryDropped']);
  });

  it('refuses hellos with auth/rate_limited_auth once an IP reaches its failed room-code limit', async () => {
    const h = await harness({
      clock: new FakeClock(0),
      config: { rooms: { failedCodeAttemptsPerIpPerMin: 2 } },
      handlers: {
        hello: (conn) => {
          conn.recordFailedRoomCode();
          return { result: 'auth', reasonCode: 'unknown_room', close: 4401 };
        },
      },
    });
    for (let i = 0; i < 2; i++) {
      const c = await connect(h.port);
      c.send({ t: 'hello', v: 1, actionId: ID, roomCode: 'WRONG1' });
      expect(await c.next()).toMatchObject({ reasonCode: 'unknown_room' });
    }
    const c = await connect(h.port);
    c.send({ t: 'hello', v: 1, actionId: ID, roomCode: 'WRONG1' });
    expect(await c.next()).toEqual({ t: 'outcome', actionId: ID, result: 'auth', reasonCode: 'rate_limited_auth' });
    expect(await c.closed).toBe(4401);
  });
});

describe('per-IP key behind a trusted proxy (D11)', () => {
  it('limits by the X-Forwarded-For client, not by the proxy', async () => {
    const h = await harness({
      clock: new FakeClock(0),
      config: { rooms: { failedCodeAttemptsPerIpPerMin: 1 } },
      handlers: {
        hello: (conn) => {
          conn.recordFailedRoomCode();
          return { result: 'auth', reasonCode: 'unknown_room', close: 4401 };
        },
      },
    });
    const hello = { t: 'hello', v: 1, actionId: ID, roomCode: 'WRONG1' };
    const a1 = await connect(h.port, '/ws', { 'X-Forwarded-For': '198.51.100.7' });
    a1.send(hello);
    expect(await a1.next()).toMatchObject({ reasonCode: 'unknown_room' });
    const a2 = await connect(h.port, '/ws', { 'X-Forwarded-For': '198.51.100.7' });
    a2.send(hello);
    expect(await a2.next()).toMatchObject({ reasonCode: 'rate_limited_auth' });
    const b = await connect(h.port, '/ws', { 'X-Forwarded-For': '203.0.113.9' });
    b.send(hello);
    expect(await b.next()).toMatchObject({ reasonCode: 'unknown_room' });
  });
});

describe('heartbeat and disconnect classification (§9.4)', () => {
  it('pings every 10 s and terminates after 25 s without a pong (unplanned/heartbeat_timeout)', async () => {
    const clock = new FakeClock(0);
    const h = await harness({ clock });
    const c = await connect(h.port);
    await tick();
    clock.advance(HEARTBEAT_INTERVAL_MS);
    expect(await c.next()).toEqual({ t: 'ping', id: 1 });
    clock.advance(HEARTBEAT_TIMEOUT_MS - HEARTBEAT_INTERVAL_MS - 1);
    await tick();
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    clock.advance(1);
    await c.closed;
    await tick();
    expect(h.disconnects).toEqual([
      { reason: 'unplanned', cause: 'heartbeat_timeout', binding: null, connectedMs: HEARTBEAT_TIMEOUT_MS },
    ]);
  });

  it('a pong resets the deadline', async () => {
    const clock = new FakeClock(0);
    const h = await harness({ clock });
    const c = await connect(h.port);
    await tick();
    clock.advance(20_000);
    c.send({ t: 'pong', id: 2 });
    await tick();
    clock.advance(20_000);
    await tick();
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    expect(h.gw.size).toBe(1);
  });

  it('classifies a client close and a drop after a hidden notice', async () => {
    const h = await harness();
    const a = await connect(h.port);
    a.ws.close(1000);
    await a.closed;
    const b = await connect(h.port);
    b.send({ t: 'visibility', state: 'hidden' });
    await tick();
    b.ws.terminate();
    await tick(100);
    expect(h.disconnects.map((d) => d.reason)).toEqual(['client_closed', 'client_backgrounded']);
  });

  it('classifies a gateway shutdown close as server_restart', async () => {
    const h = await harness();
    const c = await connect(h.port);
    await h.gw.close(1012, 'drain');
    expect(await c.closed).toBe(1012);
    await tick();
    expect(h.disconnects.map((d) => d.reason)).toEqual(['server_restart']);
  });

  it('cuts off a client whose outbound buffer exceeds 1 MiB (close 1008, unplanned/backpressure)', async () => {
    let conn: Connection | null = null;
    const h = await harness({ handlers: { hello: (c) => ((conn = c), { result: 'ok' }) } });
    const c = await connect(h.port);
    c.send({ t: 'hello', v: 1, actionId: ID, roomCode: 'A' });
    await c.next();
    const raw = (c.ws as unknown as { _socket: { pause(): void } })._socket;
    raw.pause();
    const big = 'x'.repeat(256 * 1024);
    for (let i = 0; i < 400 && h.gw.size > 0; i++) {
      conn!.send({ t: 'seatToken', seat: 0, seatToken: big, purpose: 'joined' });
      await new Promise((r) => setImmediate(r));
    }
    await tick(100);
    expect(h.gw.size).toBe(0);
    expect(h.disconnects.at(-1)).toMatchObject({ reason: 'unplanned', cause: 'backpressure' });
  });
});

describe('binding registry', () => {
  it('binds sockets to games and seats, reports the previous seat holder, and unbinds on close', async () => {
    const conns: Connection[] = [];
    const h = await harness({ handlers: { hello: (c) => (conns.push(c), { result: 'ok' }) } });
    const a = await connect(h.port);
    const b = await connect(h.port);
    const l = await connect(h.port);
    for (const x of [a, b, l]) {
      x.send({ t: 'hello', v: 1, actionId: ID, roomCode: 'A' });
      await x.next();
    }
    const [ca, cb, cl] = conns as [Connection, Connection, Connection];
    expect(h.gw.bind(ca, { gameId: 'g', seat: 1 })).toBeNull();
    expect(h.gw.bind(cl, { gameId: 'g', seat: null })).toBeNull();
    expect(h.gw.connectionOf('g', 1)).toBe(ca);
    expect(h.gw.bind(cb, { gameId: 'g', seat: 1 })).toBe(ca);
    expect(h.gw.connectionOf('g', 1)).toBe(cb);
    expect(new Set(h.gw.connectionsOf('g'))).toEqual(new Set([ca, cb, cl]));
    a.ws.close(1000);
    await a.closed;
    await tick();
    expect(h.gw.connectionOf('g', 1)).toBe(cb);
    expect(h.disconnects[0]?.binding).toEqual({ gameId: 'g', seat: 1 });
    b.ws.close(1000);
    await b.closed;
    await tick();
    expect(h.gw.connectionOf('g', 1)).toBeNull();
    expect(h.gw.connectionsOf('g')).toEqual([cl]);
  });
});

describe('startServer wiring', () => {
  it('answers a hello for an unknown room with auth/unknown_room and close 4401', async () => {
    const s = await startServer({ port: 0, dbPath: ':memory:', telemetry: 'off' });
    cleanups.push(() => s.close());
    const c = await connect(s.port);
    c.send({ t: 'hello', v: 1, actionId: ID, roomCode: 'ABCDEF' });
    expect(await c.next()).toEqual({ t: 'outcome', actionId: ID, result: 'auth', reasonCode: 'unknown_room' });
    expect(await c.closed).toBe(4401);
  });
});
