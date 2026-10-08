// T-2 contract tests (design §9.4, §9.5 with D25, §3.11 telemetry; AC33, AC30 log redaction): the log body contract,
// reserved and forbidden keys, log write failures, disconnect classification and events, connected time, reconnect
// gaps, client telemetry ingestion, delivery duration, the turn/trade/action events, and one emitting site per event.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildState } from '@hexlands/engine/testing';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { WebSocket } from 'ws';
import { FakeClock } from './clock';
import { LOG_EVENT_SEVERITY } from './log-events';
import { Presence } from './presence';
import { startServer, type RunningServer, type ServerContext, type ServerOptions } from './server';
import { createTelemetry, logRecord, type Telemetry } from './telemetry';
import type { Binding, Connection, DisconnectInfo, WsGateway } from './ws-gateway';

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
let n = 0;
const id = () => `00000000-0000-4000-9000-${String(++n).padStart(12, '0')}`;
const tick = () => new Promise((r) => setTimeout(r, 30));
type Msg = Record<string, unknown>;

// ── helpers ───────────────────────────────────────────────────────────────────────────────────────────────────────

class Client {
  readonly frames: Msg[] = [];
  closed: Promise<number>;
  private waiters = new Map<string, (m: Msg) => void>();
  private constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as Msg;
      this.frames.push(m);
      if (m['t'] === 'ping') ws.send(JSON.stringify({ t: 'pong', id: m['id'] }));
      if (m['t'] === 'outcome') this.waiters.get(String(m['actionId']))?.(m);
    });
    this.closed = new Promise((r) => ws.on('close', (c) => r(c)));
  }
  static async open(port: number): Promise<Client> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    cleanups.push(() => ws.terminate());
    await new Promise((r, j) => ws.once('open', r).once('error', j));
    return new Client(ws);
  }
  cmd(msg: Msg): Promise<Msg> {
    const actionId = id();
    const done = new Promise<Msg>((r) => this.waiters.set(actionId, r));
    this.ws.send(JSON.stringify({ ...msg, actionId }));
    return done;
  }
  signal(msg: Msg): void {
    this.ws.send(JSON.stringify(msg));
  }
  hello(roomCode: string, extra: Msg = {}) {
    return this.cmd({ t: 'hello', v: 1, roomCode, ...extra });
  }
  last(t: string): Msg | undefined {
    return [...this.frames].reverse().find((f) => f['t'] === t);
  }
}

function createRoom(port: number): Promise<{ roomCode: string; seatToken: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/api/rooms', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as { roomCode: string; seatToken: string }));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ displayName: 'Ana' }));
  });
}

interface Game {
  s: RunningServer;
  clock: FakeClock;
  roomCode: string;
  tokens: string[];
  clients: Client[];
}

/**
 * A started 3-player game on a FakeClock, every seat connected. The seq-0 state is replaced (test hook) by a main-phase
 * state where seat 0 holds a wool card, so trades and endTurn are legal at once.
 */
async function startedGame(opts: Partial<ServerOptions> = {}): Promise<Game> {
  const dir = mkdtempSync(path.join(tmpdir(), 'hexlands-t2-'));
  const clock = new FakeClock(1_000_000);
  const s = await startServer({
    port: 0,
    dbPath: path.join(dir, 'db'),
    telemetry: 'memory',
    clock,
    testHooks: { initialState: () => buildState({ playerCount: 3, turn: { number: 3 }, hands: { 0: { wool: 1 }, 1: { ore: 1 } } }) },
    ...opts,
  });
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => s.close());
  const { roomCode, seatToken } = await createRoom(s.port);
  const host = await Client.open(s.port);
  await host.hello(roomCode, { seatToken });
  const clients = [host];
  const tokens = [seatToken];
  for (const name of ['Bo', 'Cy']) {
    const c = await Client.open(s.port);
    await c.hello(roomCode);
    await c.cmd({ t: 'lobby', op: { kind: 'join', displayName: name } });
    tokens.push(c.last('seatToken')!['seatToken'] as string);
    clients.push(c);
  }
  expect(await host.cmd({ t: 'lobby', op: { kind: 'start' } })).toMatchObject({ result: 'ok' });
  await tick();
  return { s, clock, roomCode, tokens, clients };
}

/** Advances the fake clock in heartbeat-sized steps, letting clients answer pings in between. */
async function advance(clock: FakeClock, ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 5_000) {
    clock.advance(Math.min(5_000, left));
    await tick();
  }
}

const bodies = (s: RunningServer) => s.telemetry.logs().map((r) => JSON.parse(r.body as string) as Msg);
const events = (s: RunningServer, event: string) => bodies(s).filter((b) => b['event'] === event);
const counter = (s: RunningServer, name: string, attrs: Record<string, string> = {}) =>
  (s.telemetry.metrics()[name]?.points ?? [])
    .filter((p) => Object.entries(attrs).every(([k, v]) => p.attributes[k] === v))
    .reduce((t, p) => t + (p.value ?? p.count ?? 0), 0);

// ── log facade (D25) ──────────────────────────────────────────────────────────────────────────────────────────────

function memoryTelemetry(writeLine: (l: string) => void, onWriteError?: () => void): Telemetry {
  const t = createTelemetry({ mode: 'memory', environment: 'dev', serviceVersion: 'v-t2', writeLine, ...(onWriteError ? { onWriteError } : {}) });
  cleanups.push(() => t.shutdown());
  return t;
}

describe('log body contract (design §9.5, D25)', () => {
  it('the OTLP body and the stdout line are the same JSON, with the required keys present and typed', () => {
    const lines: string[] = [];
    const t = memoryTelemetry((l) => lines.push(l));
    t.log('WARN', 'x.y', { game_id: 'g1', reason: 'because' });
    t.tracer.startActiveSpan('catan.action', (span) => {
      t.log('INFO', 'action.rejected', { game_id: 'g1', reason_code: 'wrong_phase' });
      span.end();
    });
    const records = t.logs();
    expect(records.map((r) => r.body)).toEqual(lines);
    const [plain, inSpan] = lines.map((l) => JSON.parse(l) as Msg);
    for (const b of [plain!, inSpan!]) {
      expect(typeof b['event']).toBe('string');
      expect(['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL']).toContain(b['severity_text']);
      expect(b['service_name']).toBe('catan-server');
      expect(b['environment']).toBe('dev');
      expect(b['game_id']).toBe('g1');
      expect(typeof b['timestamp']).toBe('string');
    }
    expect(plain!['reason']).toBe('because');
    expect(plain!['trace_id']).toBeUndefined();
    expect(inSpan!['reason_code']).toBe('wrong_phase');
    expect(inSpan!['trace_id']).toMatch(/^[0-9a-f]{32}$/);
    expect(inSpan!['span_id']).toMatch(/^[0-9a-f]{16}$/);
  });

  it('a caller field never replaces a reserved key; its value moves under fields.<key>', () => {
    const body = logRecord({ event: 'real', severity_text: 'INFO', service_name: 'catan-server', trace_id: 't' }, 'real', {
      event: 'fake',
      severity_text: 'ERROR',
      trace_id: 'forged',
      service_name: 'other',
      game_id: 'g',
    });
    expect(body).toMatchObject({ event: 'real', severity_text: 'INFO', service_name: 'catan-server', trace_id: 't', game_id: 'g' });
    expect(body['fields']).toEqual({ event: 'fake', severity_text: 'ERROR', trace_id: 'forged', service_name: 'other' });
  });

  it('secrets, forbidden keys and link fragments are replaced at any depth; the seed only outside game.ended', () => {
    const fields = {
      roomCode: 'ABCDEF',
      nested: { seatToken: 'x'.repeat(43), ip: '10.0.0.1', userAgent: 'UA', name: 'Ana', url: 'https://h/x', deck: ['knight'] },
      list: [{ passphrase: 'p' }, 'see https://h/#join=ABCDEF'],
      seed: 'live-seed',
    };
    const live = logRecord({}, 'game.started', fields);
    expect(JSON.stringify(live)).not.toMatch(/ABCDEF|xxxxxxxx|10\.0\.0\.1|"UA"|Ana|https:\/\/h\/x|knight|live-seed|"p"/);
    expect(live).toMatchObject({ roomCode: '[Redacted]', seed: '[Redacted]', nested: { ip: '[Redacted]', name: '[Redacted]' } });
    expect(logRecord({}, 'game.ended', { seed: 'done-seed' })['seed']).toBe('done-seed');
  });

  it('the replacement is the literal string "[Redacted]" (the G4 production LogQL matches on it)', () => {
    const body = JSON.stringify(logRecord({}, 'x', { seatToken: 's', ip: '1.2.3.4', seed: 'live' }));
    expect(body).toBe('{"seatToken":"[Redacted]","ip":"[Redacted]","seed":"[Redacted]"}');
  });

  it('one process-wide stdout error listener serves every telemetry instance, and shutdown unregisters it', async () => {
    const before = process.stdout.listenerCount('error');
    const instances = Array.from({ length: 5 }, () => createTelemetry({ mode: 'off', environment: 'dev', serviceVersion: 'v', onWriteError: () => undefined }));
    expect(process.stdout.listenerCount('error')).toBeLessThanOrEqual(before + 1);
    for (const t of instances) await t.shutdown();
    expect(process.stdout.listenerCount('error')).toBeLessThanOrEqual(before + 1);
  });

  it('an asynchronous stdout error reaches each live instance once; a shut-down instance is never called again', async () => {
    let first = 0;
    let second = 0;
    const a = createTelemetry({ mode: 'off', environment: 'dev', serviceVersion: 'v', onWriteError: () => void first++ });
    const b = createTelemetry({ mode: 'off', environment: 'dev', serviceVersion: 'v', onWriteError: () => void second++ });
    process.stdout.emit('error', new Error('EPIPE'));
    expect([first, second]).toEqual([1, 1]);
    await a.shutdown();
    process.stdout.emit('error', new Error('EPIPE'));
    expect([first, second]).toEqual([1, 2]);
    await b.shutdown();
    process.stdout.emit('error', new Error('EPIPE'));
    expect([first, second]).toEqual([1, 2]);
  });

  it('a failing log write never throws and is reported once per failure', () => {
    let failures = 0;
    const t = memoryTelemetry(
      () => {
        throw new Error('EPIPE');
      },
      () => failures++,
    );
    expect(() => t.log('INFO', 'a')).not.toThrow();
    expect(() => t.log('INFO', 'b', { cyclic: undefined })).not.toThrow();
    expect(failures).toBe(2);
    expect(t.logs()).toHaveLength(2);
  });

  it('server: stdout write failures are counted as catan.errors{component=telemetry} and never break the commit path', async () => {
    const g = await startedGame({
      logLine: () => {
        throw new Error('EPIPE');
      },
    });
    expect(counter(g.s, 'catan.errors', { component: 'telemetry' })).toBeGreaterThan(0);
    expect(await g.clients[0]!.cmd({ t: 'action', baseSeq: 0, action: { type: 'endTurn' } })).toMatchObject({ result: 'ok', seq: 1 });
  });
});

// ── turns, trades, actions ────────────────────────────────────────────────────────────────────────────────────────

describe('turn, trade and action events (§9.5)', () => {
  it('trade.proposed, trade.resolved{withdrawn, exit_to} and turn.ended come from the commit; action.rejected carries the trace', async () => {
    const g = await startedGame();
    const [host, bo] = g.clients;
    const offer = { give: { brick: 0, lumber: 0, wool: 1, grain: 0, ore: 0 }, get: { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 1 } };
    expect(await host!.cmd({ t: 'action', baseSeq: 0, action: { type: 'proposeTrade', ...offer } })).toMatchObject({ result: 'ok' });
    await advance(g.clock, 4_000);
    expect(await bo!.cmd({ t: 'action', baseSeq: 1, action: { type: 'endTurn' } })).toMatchObject({ reasonCode: 'not_your_turn' });
    expect(await host!.cmd({ t: 'action', baseSeq: 1, action: { type: 'endTurn' } })).toMatchObject({ result: 'ok' });

    const [proposed] = events(g.s, 'trade.proposed');
    expect(proposed).toMatchObject({ severity_text: 'INFO', trade_id: 1, from_seat: 0, give_count: 1, get_count: 1 });
    expect(typeof proposed!['game_id']).toBe('string');
    expect(events(g.s, 'trade.resolved')).toEqual([
      expect.objectContaining({ trade_id: 1, outcome: 'withdrawn', exit_to: 'preRoll', partner_seat: null, open_s: 4 }),
    ]);
    expect(events(g.s, 'turn.ended')).toEqual([
      expect.objectContaining({ turn: 3, seat: 0, actions: 2, dice_total: null, reason: 'end_turn' }),
    ]);
    const [rejected] = events(g.s, 'action.rejected');
    expect(rejected).toMatchObject({ reason_code: 'not_your_turn', 'action.type': 'endTurn', seat: 1 });
    expect(rejected!['trace_id']).toMatch(/^[0-9a-f]{32}$/);
  });
});

// ── disconnects, connected time, reconnects (§9.4) ────────────────────────────────────────────────────────────────

describe('disconnect classification and presence (§9.4, NFR5, NFR6)', () => {
  it.each([
    ['dropped 59 s after hidden', 'client_backgrounded', 59_000],
    ['dropped 61 s after hidden', 'unplanned', 61_000],
  ])('%s → %s', async (_n, reason, after) => {
    const g = await startedGame();
    g.clients[1]!.signal({ t: 'visibility', state: 'hidden' });
    await tick();
    await advance(g.clock, after);
    g.clients[1]!.ws.terminate();
    await tick();
    expect(counter(g.s, 'catan.ws.disconnects', { reason })).toBe(1);
    const [ev] = events(g.s, 'player.disconnected');
    expect(ev).toMatchObject({ seat: 1, reason });
    if (reason === 'unplanned') expect(ev!['cause']).toBe('abnormal_close');
    else expect(ev!['cause']).toBeUndefined();
  });

  it('a client close 1000 → client_closed; an unseated socket never counts; connected_s is seated time', async () => {
    const g = await startedGame();
    const visitor = await Client.open(g.s.port);
    await visitor.hello(g.roomCode);
    visitor.ws.close(1000);
    await advance(g.clock, 10_000);
    g.clients[2]!.ws.close(1000);
    await g.clients[2]!.closed;
    await tick();
    expect(counter(g.s, 'catan.ws.disconnects')).toBe(1);
    expect(counter(g.s, 'catan.ws.disconnects', { reason: 'client_closed' })).toBe(1);
    expect(events(g.s, 'player.disconnected')).toEqual([expect.objectContaining({ seat: 2, reason: 'client_closed', connected_s: 10 })]);
  });

  it('a drain closes 1012 → server_restart for every seated socket', async () => {
    const g = await startedGame();
    await g.s.drain();
    await tick();
    expect(counter(g.s, 'catan.ws.disconnects', { reason: 'server_restart' })).toBe(3);
  });

  it('catan.player.connected_seconds accrues seated time in an active game (tick + disconnect)', async () => {
    const g = await startedGame();
    const before = counter(g.s, 'catan.player.connected_seconds');
    await advance(g.clock, 60_000);
    const afterTick = counter(g.s, 'catan.player.connected_seconds');
    expect(afterTick - before).toBeCloseTo(3 * 60, 0);
    await advance(g.clock, 10_000);
    g.clients[0]!.ws.close(1000);
    await tick();
    expect(counter(g.s, 'catan.player.connected_seconds') - afterTick).toBeCloseTo(10, 0);
  });

  it('a socket superseded by another device stops accruing connected time (no double count per seat)', async () => {
    const g = await startedGame();
    const second = await Client.open(g.s.port);
    expect(await second.hello(g.roomCode, { seatToken: g.tokens[1] })).toMatchObject({ result: 'ok' });
    await tick();
    const before = counter(g.s, 'catan.player.connected_seconds');
    await advance(g.clock, 60_000);
    // Three seats, each with one current holder; the superseded socket of seat 1 is not counted.
    expect(counter(g.s, 'catan.player.connected_seconds') - before).toBeCloseTo(3 * 60, 0);
  });

  it('player.reconnected{resumed} carries the gap since the seat dropped and how far behind the client was', async () => {
    const g = await startedGame();
    expect(await g.clients[0]!.cmd({ t: 'action', baseSeq: 0, action: { type: 'endTurn' } })).toMatchObject({ seq: 1 });
    g.clients[1]!.ws.terminate();
    await tick();
    await advance(g.clock, 5_000);
    const again = await Client.open(g.s.port);
    expect(await again.hello(g.roomCode, { seatToken: g.tokens[1], lastSeq: 0 })).toMatchObject({ result: 'ok' });
    const resumed = events(g.s, 'player.reconnected').filter((e) => e['seat'] === 1);
    expect(resumed.at(-1)).toMatchObject({ outcome: 'resumed', gap_s: 5, seq_behind: 1 });
  });
});

// ── client telemetry (§3.11, P9) and delivery ─────────────────────────────────────────────────────────────────────

describe('client telemetry ingestion and delivery duration', () => {
  it('records resume gaps by cause, clamped RTTs and client errors; never an outcome, a seq or a state change', async () => {
    const g = await startedGame();
    const c = g.clients[1]!;
    const head = g.s.stateHash(g.roomCode);
    const framesBefore = c.frames.length;
    c.signal({
      t: 'telemetry',
      resumeGaps: [{ ms: 1_500, cause: 'network' }, { ms: 9_000_000, cause: 'server_restart' }],
      actionRttMs: [40, 70_000, -5],
      errors: [{ kind: 'render', message: 'boom at https://x.example/p?q=1#join=ABCDEF' }],
    });
    await tick();
    const m = g.s.telemetry.metrics();
    const gap = (cause: string) => m['catan.ws.resume_gap']!.points.find((p) => p.attributes['cause'] === cause)!;
    expect(gap('network')).toMatchObject({ count: 1, sum: 1.5 });
    expect(gap('server_restart')).toMatchObject({ count: 1, sum: 600 });
    expect(m['catan.client.action_rtt']!.points[0]).toMatchObject({ count: 3, sum: 60.04 });
    expect(counter(g.s, 'catan.client.errors', { kind: 'render' })).toBe(1);
    expect(events(g.s, 'client.error')).toEqual([expect.objectContaining({ kind: 'render', message: 'boom at [url]', seat: 1 })]);
    expect(c.frames.slice(framesBefore).filter((f) => f['t'] === 'outcome' || f['t'] === 'state')).toEqual([]);
    expect(g.s.stateHash(g.roomCode)).toEqual(head);
  });

  it('a 101-sample array and a second batch within 5 s are dropped (catan.telemetry.dropped)', async () => {
    const g = await startedGame();
    const c = g.clients[1]!;
    c.signal({ t: 'telemetry', actionRttMs: new Array(101).fill(10) });
    await tick();
    expect(counter(g.s, 'catan.telemetry.dropped')).toBe(1);
    c.signal({ t: 'telemetry', actionRttMs: [10] });
    c.signal({ t: 'telemetry', actionRttMs: [20] });
    await tick();
    expect(counter(g.s, 'catan.telemetry.dropped')).toBe(2);
    expect(g.s.telemetry.metrics()['catan.client.action_rtt']!.points[0]).toMatchObject({ count: 1 });
    await advance(g.clock, 5_000);
    c.signal({ t: 'telemetry', actionRttMs: [30] });
    await tick();
    expect(g.s.telemetry.metrics()['catan.client.action_rtt']!.points[0]).toMatchObject({ count: 2 });
  });

  it('catan.ws.delivery.duration: commit of seq N → each recipient\'s first ack of N', async () => {
    const g = await startedGame();
    expect(await g.clients[0]!.cmd({ t: 'action', baseSeq: 0, action: { type: 'endTurn' } })).toMatchObject({ seq: 1 });
    await advance(g.clock, 2_000);
    g.clients[1]!.signal({ t: 'ack', seq: 1 });
    g.clients[1]!.signal({ t: 'ack', seq: 1 });
    g.clients[2]!.signal({ t: 'ack', seq: 1 });
    await tick();
    expect(g.s.telemetry.metrics()['catan.ws.delivery.duration']!.points[0]).toMatchObject({ count: 2, sum: 4 });
  });

  it('the ack high-water mark is per game: after moving to another game, a lower seq there is a first ack', async () => {
    const g = await startedGame();
    // Seat 2's socket acks a high seq in game A, then joins game B as a spectator.
    const mover = g.clients[2]!;
    mover.signal({ t: 'ack', seq: 50 });
    const b = await createRoom(g.s.port);
    const hostB = await Client.open(g.s.port);
    await hostB.hello(b.roomCode, { seatToken: b.seatToken });
    for (const name of ['Eve', 'Fay']) {
      const c = await Client.open(g.s.port);
      await c.hello(b.roomCode);
      await c.cmd({ t: 'lobby', op: { kind: 'join', displayName: name } });
    }
    expect(await hostB.cmd({ t: 'lobby', op: { kind: 'start' } })).toMatchObject({ result: 'ok' });
    expect(await mover.hello(b.roomCode)).toMatchObject({ result: 'ok' });
    expect(await hostB.cmd({ t: 'action', baseSeq: 0, action: { type: 'endTurn' } })).toMatchObject({ seq: 1 });
    await advance(g.clock, 1_000);
    mover.signal({ t: 'ack', seq: 1 });
    await tick();
    expect(g.s.telemetry.metrics()['catan.ws.delivery.duration']?.points[0]).toMatchObject({ count: 1 });
  });
});

// ── presence with a superseded socket still open (P6) ───────────────────────────────────────────────────────────

describe('presence: only the seat\'s current holder accrues connected time', () => {
  /** Presence over a fake gateway: seat 1 of game g is bound first to socket A, then superseded by socket B. */
  function harness() {
    const clock = new FakeClock(0);
    const telemetry = createTelemetry({ mode: 'memory', environment: 'dev', serviceVersion: 'v' });
    cleanups.push(() => telemetry.shutdown());
    const ctx = {
      clock,
      telemetry,
      store: { listGames: () => [{ id: 'g' }], findGame: () => ({ id: 'g', lifecycle: 'active' }) },
    } as unknown as ServerContext;
    const binding: Binding = { gameId: 'g', seat: 1 };
    const a = { id: 1, binding, seatedSince: 0 } as unknown as Connection;
    const b = { id: 2, binding, seatedSince: 30_000 } as unknown as Connection;
    let open: Connection[] = [a];
    let holder: Connection | null = a;
    const gateway = { seatedConnections: () => open, connectionOf: () => holder } as unknown as WsGateway;
    const presence = new Presence(ctx, () => gateway);
    const seconds = () =>
      (telemetry.metrics()['catan.player.connected_seconds']?.points ?? []).reduce((t, p) => t + (p.value ?? 0), 0);
    const supersede = () => {
      open = [a, b];
      holder = b;
    };
    const close = (c: Connection) => {
      open = open.filter((x) => x !== c);
      if (holder === c) holder = null;
      const info: DisconnectInfo = { reason: 'superseded', binding, connectedMs: 0, seatedSince: c.seatedSince };
      presence.disconnected(c, info);
    };
    return { clock, presence, seconds, supersede, close, a, b };
  }

  it('a tick counts the holder only, while the superseded socket is still open', () => {
    const h = harness();
    h.clock.advance(30_000);
    h.presence.accrueAll();
    expect(h.seconds()).toBe(30);
    h.supersede();
    h.clock.advance(60_000);
    h.presence.accrueAll();
    // B since its bind (60 s); A, superseded at 30 s, adds nothing.
    expect(h.seconds()).toBe(90);
  });

  it('the superseded socket\'s close adds nothing; the holder\'s close adds its time since the last tick', () => {
    const h = harness();
    h.clock.advance(30_000);
    h.presence.accrueAll();
    h.supersede();
    h.clock.advance(20_000);
    h.close(h.a);
    expect(h.seconds()).toBe(30);
    h.clock.advance(10_000);
    h.close(h.b);
    expect(h.seconds()).toBe(60);
  });
});

// ── one emitting site per event ───────────────────────────────────────────────────────────────────────────────────

describe('structured event sites', () => {
  const SRC = path.dirname(new URL(import.meta.url).pathname);
  const sources = readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.startsWith('testing'))
    .map((f) => [f, readFileSync(path.join(SRC, f), 'utf8')] as const);

  it('every structured line goes through logEvent: no direct telemetry.log call outside the facade and the catalogue', () => {
    const direct = sources.filter(([f, s]) => f !== 'telemetry.ts' && f !== 'log-events.ts' && /\.log\(\s*'(DEBUG|INFO|WARN|ERROR|FATAL)'/.test(s));
    expect(direct.map(([f]) => f)).toEqual([]);
  });

  it('logEvent and its wrappers are never imported under another name (the site check matches the call name)', () => {
    const aliased = sources.filter(([, s]) => /\b(logEvent|reportFault|playerReconnected|gameEnded)\s+as\s+\w+/.test(s));
    expect(aliased.map(([f]) => f)).toEqual([]);
  });

  it('each catalogued event is emitted from exactly one site', () => {
    const sites = new Map<string, string[]>();
    for (const [f, s] of sources) {
      for (const m of s.matchAll(/logEvent\([^,]+,\s*'([a-z_.]+)'/g)) sites.set(m[1]!, [...(sites.get(m[1]!) ?? []), f]);
    }
    for (const event of Object.keys(LOG_EVENT_SEVERITY)) expect(sites.get(event) ?? [], event).toHaveLength(1);
  });
});

describe('store failures in the job and in metric reads (Evolve N2)', () => {
  it('a failing game listing: one ERROR per listing in the job; the catan.games gauge is skipped, counted and WARNed once', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hexlands-t2-job-'));
    const dbPath = path.join(dir, 'db');
    const s = await startServer({ port: 0, dbPath, telemetry: 'memory' });
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => s.close());
    const raw = new Database(dbPath);
    raw.exec('ALTER TABLE games RENAME TO games_gone');
    s.runAbandonmentJob();
    // A metrics read with the store still failing: the catan.games gauge is skipped, never thrown, and counted.
    expect(() => s.telemetry.metrics()).not.toThrow();
    expect(s.telemetry.metrics()['catan.games']?.points ?? []).toEqual([]);
    expect(counter(s, 'catan.errors', { component: 'telemetry' })).toBe(2);
    expect(events(s, 'telemetry.gauge_failed')).toEqual([expect.objectContaining({ severity_text: 'WARN', gauge: 'catan.games' })]);
    raw.exec('ALTER TABLE games_gone RENAME TO games');
    raw.close();
    expect(counter(s, 'catan.errors', { component: 'job' })).toBe(3);
    expect(s.telemetry.metrics()['catan.games']!.points.length).toBeGreaterThan(0);
    expect(events(s, 'job.abandonment.error').map((e) => [e['severity_text'], e['stage']])).toEqual([
      ['ERROR', 'list_live'],
      ['ERROR', 'list_terminal'],
      ['ERROR', 'clear_tombstones'],
    ]);
  });
});
