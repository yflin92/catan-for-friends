// In-process observability contract (AC33, V32): one catan.action span per action/lobby/control message with no
// children, catan.action.duration per span, catan.actions.rejected for every non-ok outcome, closed label sets on
// every recorded metric, the runtime and disk gauges, and drain 503s that never count as errors.
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { SystemClock } from './clock';
import { loadServerConfig } from './config';
import { createHttpHandler } from './http';
import { ALLOWED_LABEL_KEYS, INSTRUMENTS } from './metrics';
import type { ActionType } from '@hexlands/engine';
import type { ControlOp, LobbyOp } from '@hexlands/protocol';
import { RUNTIME_INSTRUMENTS } from './runtime-metrics';
import { startServer, type RunningServer, type ServerContext } from './server';
import { createTelemetry } from './telemetry';
import { CreateRateLimiter, FailedCodeLimiter } from './ws-gateway/limits';

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

let idCounter = 0;
const nextId = () => `00000000-0000-4000-8000-${String(++idCounter).padStart(12, '0')}`;
type Msg = Record<string, unknown>;

async function boot(): Promise<RunningServer> {
  const dir = mkdtempSync(path.join(tmpdir(), 'hexlands-obs-'));
  const s = await startServer({ port: 0, dbPath: path.join(dir, 'db'), telemetry: 'memory', buildVersion: 'v-obs' });
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => s.close());
  return s;
}

function createRoom(port: number, displayName: string): Promise<{ roomCode: string; seatToken: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/api/rooms', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as { roomCode: string; seatToken: string }));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ displayName }));
  });
}

class Client {
  readonly frames: Msg[] = [];
  private waiters: { pred: (m: Msg) => boolean; resolve: (m: Msg) => void }[] = [];
  private constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as Msg;
      this.frames.push(m);
      const i = this.waiters.findIndex((w) => w.pred(m));
      if (i >= 0) this.waiters.splice(i, 1)[0]!.resolve(m);
    });
  }
  static async open(port: number): Promise<Client> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    cleanups.push(() => ws.terminate());
    await new Promise((r, j) => ws.once('open', r).once('error', j));
    return new Client(ws);
  }
  cmd(msg: Msg): Promise<Msg> {
    const actionId = nextId();
    const done = new Promise<Msg>((resolve) => this.waiters.push({ pred: (m) => m['t'] === 'outcome' && m['actionId'] === actionId, resolve }));
    this.ws.send(JSON.stringify({ ...msg, actionId }));
    return done;
  }
  raw(text: string): Promise<Msg> {
    const done = new Promise<Msg>((resolve) => this.waiters.push({ pred: (m) => m['t'] === 'outcome' && m['actionId'] === null, resolve }));
    this.ws.send(text);
    return done;
  }
  last(t: string): Msg | undefined {
    return [...this.frames].reverse().find((f) => f['t'] === t);
  }
}

/** Plays a short scripted session; returns the server and how many action/lobby/control messages were sent. */
async function scripted() {
  const s = await boot();
  const { roomCode, seatToken } = await createRoom(s.port, 'Ana');
  const host = await Client.open(s.port);
  await host.cmd({ t: 'hello', v: 1, roomCode, seatToken });
  let commands = 0;
  for (const name of ['Bo', 'Cy']) {
    const p = await Client.open(s.port);
    await p.cmd({ t: 'hello', v: 1, roomCode });
    expect(await p.cmd({ t: 'lobby', op: { kind: 'join', displayName: name } })).toMatchObject({ result: 'ok' });
    commands++;
  }
  expect(await host.cmd({ t: 'lobby', op: { kind: 'start' } })).toMatchObject({ result: 'ok' });
  commands++;
  await new Promise((r) => setTimeout(r, 50));
  const view = host.last('state')!['view'] as { legal: { placeSettlement: string[] } };
  expect(await host.cmd({ t: 'action', baseSeq: 0, action: { type: 'endTurn' } })).toMatchObject({ result: 'turn' });
  commands++;
  expect(await host.cmd({ t: 'action', baseSeq: 0, action: { type: 'placeSettlement', vertex: view.legal.placeSettlement[0] } })).toMatchObject({
    result: 'ok',
  });
  commands++;
  expect(await host.cmd({ t: 'control', op: { kind: 'resume' } })).toMatchObject({ result: 'ok' });
  commands++;
  expect(await host.raw('{"t":"action","nope":1}')).toMatchObject({ result: 'rule', reasonCode: 'malformed_action' });
  return { s, commands, roomCode, seatToken };
}

describe('catan.action spans (design §9.3, AC33)', () => {
  it('exactly one span per action, lobby and control message, none for hello or malformed frames, and no children', async () => {
    const { s, commands } = await scripted();
    const spans = s.telemetry.spans();
    const actionSpans = spans.filter((x) => x.name === 'catan.action');
    expect(actionSpans).toHaveLength(commands);
    for (const sp of spans) expect(sp.parentSpanContext, sp.name).toBeUndefined();
    const byType = Object.fromEntries(actionSpans.map((x) => [String(x.attributes['catan.action.type']), x.attributes]));
    expect(byType['join']).toMatchObject({ 'catan.action.group': 'lobby', 'catan.result': 'ok' });
    expect(byType['endTurn']).toMatchObject({ 'catan.result': 'turn', 'catan.reason_code': 'wrong_phase' });
    expect(byType['placeSettlement']).toMatchObject({ 'catan.result': 'ok', 'catan.action.group': 'setup', 'catan.seq': 1, 'catan.seat': 0 });
    expect(byType['resume']).toMatchObject({ 'catan.action.group': 'control', 'catan.result': 'ok' });
    for (const a of actionSpans) {
      const isAction = ['endTurn', 'placeSettlement'].includes(String(a.attributes['catan.action.type']));
      // Commit timings exist only where a commit was attempted (action messages); lobby/control spans carry none.
      for (const k of ['catan.reduce_ms', 'catan.persist_ms', 'catan.broadcast_ms']) {
        expect(typeof a.attributes[k], `${String(a.attributes['catan.action.type'])} ${k}`).toBe(isAction ? 'number' : 'undefined');
      }
      expect(a.attributes['catan.game.id']).toEqual(expect.any(String));
    }
    expect(spans.filter((x) => x.name === 'catan.lobby.create')).toHaveLength(1);
  });

  it('records catan.action.duration once per span with the same result', async () => {
    const { s, commands } = await scripted();
    const points = s.telemetry.metrics()['catan.action.duration']!.points;
    expect(points.reduce((n, p) => n + (p.count ?? 0), 0)).toBe(commands);
    const results = s.telemetry.spans().filter((x) => x.name === 'catan.action').map((x) => String(x.attributes['catan.result']));
    for (const p of points) expect(p.count).toBe(results.filter((r) => r === p.attributes['result']).length);
    expect(points[0]!.buckets!.boundaries).toEqual([0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1]);
  });
});

describe('catan.action.type values (design D23)', () => {
  it('Action types, lobby op kinds, control op kinds and skipSeat are pairwise disjoint', () => {
    const actions = Object.keys({
      placeSettlement: 1, placeRoad: 1, buildCity: 1, rollDice: 1, discard: 1, moveRobber: 1, buyDevCard: 1, playKnight: 1,
      playRoadBuilding: 1, playYearOfPlenty: 1, playMonopoly: 1, maritimeTrade: 1, proposeTrade: 1, respondTrade: 1,
      confirmTrade: 1, cancelTrade: 1, endTurn: 1,
    } satisfies Record<ActionType, 1>);
    const lobby = Object.keys({
      join: 1, rename: 1, reorderSeats: 1, shuffleSeats: 1, removeSeat: 1, setConfig: 1, start: 1,
    } satisfies Record<LobbyOp['kind'], 1>);
    const control = Object.keys({ skipAbsent: 1, resume: 1, relinkSeat: 1 } satisfies Record<ControlOp['kind'], 1>);
    const all = [...actions, ...lobby, ...control, 'skipSeat'];
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('metrics recorded by a real session', () => {
  it('a successful hello is not counted in catan.actions; a failed one is', async () => {
    const s = await boot();
    const { roomCode, seatToken } = await createRoom(s.port, 'Ana');
    const c = await Client.open(s.port);
    expect(await c.cmd({ t: 'hello', v: 1, roomCode, seatToken })).toMatchObject({ result: 'ok' });
    // Every catan.actions series exists from start at 0 (zero-initialised); a successful hello moves none of them.
    const moved = () => s.telemetry.metrics()['catan.actions']!.points.filter((p) => p.value !== 0);
    expect(moved()).toEqual([]);
    const d = await Client.open(s.port);
    expect(await d.cmd({ t: 'hello', v: 1, roomCode, seatToken: 'x'.repeat(43) })).toMatchObject({ result: 'auth' });
    expect(moved()).toEqual([{ attributes: { result: 'auth' }, value: 1 }]);
  });

  it('actions.rejected counts every non-ok outcome by reason code', async () => {
    const { s } = await scripted();
    const m = s.telemetry.metrics();
    // internal_error is zero-initialised at start; only the moved reason codes are compared.
    const rejected = Object.fromEntries(
      m['catan.actions.rejected']!.points.filter((p) => p.value !== 0).map((p) => [p.attributes['reason_code'], p.value]),
    );
    expect(rejected).toEqual({ wrong_phase: 1, malformed_action: 1 });
    const actions = m['catan.actions']!.points.reduce((n, p) => n + (p.attributes['result'] !== 'ok' ? (p.value ?? 0) : 0), 0);
    expect(actions).toBe(2);
  });

  it('every recorded point uses only allowed label keys and never an id, room code or token', async () => {
    const { s, roomCode, seatToken } = await scripted();
    const m = s.telemetry.metrics();
    const gameId = String(s.telemetry.spans().find((x) => x.name === 'catan.action')!.attributes['catan.game.id']);
    for (const [name, inst] of Object.entries(m)) {
      for (const p of inst.points) {
        for (const [k, v] of Object.entries(p.attributes)) {
          expect(ALLOWED_LABEL_KEYS.has(k), `${name}.${k}`).toBe(true);
          expect([gameId, roomCode, seatToken]).not.toContain(v);
        }
      }
    }
    expect(m['catan.games.transitions']!.points).toEqual(
      expect.arrayContaining([
        { attributes: { from: 'none', to: 'lobby' }, value: 1 },
        { attributes: { from: 'lobby', to: 'active' }, value: 1 },
      ]),
    );
    expect(m['catan.persist.duration']!.points.map((p) => p.attributes['op'])).toContain('append');
  });

  it('exposes the connection, runtime and disk gauges without labels', async () => {
    const { s } = await scripted();
    const m = s.telemetry.metrics();
    expect(m['catan.ws.connections']!.points[0]!.value).toBe(3);
    expect(m['catan.players.connected']!.points[0]!.value).toBe(3);
    for (const r of RUNTIME_INSTRUMENTS) {
      expect(m[r.name]!.points[0]!.attributes, r.name).toEqual({});
      expect(m[r.name]!.type, r.name).toBe(r.kind);
    }
    await expect.poll(() => s.telemetry.metrics()['catan.disk.free']?.points[0]?.value ?? 0).toBeGreaterThan(0);
    expect(s.telemetry.metrics()['catan.disk.free']!.points[0]!.attributes).toEqual({});
  });
});

describe('every recorded instrument is a catalogue instrument (series = 309 in practice)', () => {
  it('a session plus an abandonment-job run records only catalogue or runtime names, with the catalogue buckets', async () => {
    const { s } = await scripted();
    s.runAbandonmentJob();
    await new Promise((r) => setTimeout(r, 20));
    const known = new Map(INSTRUMENTS.map((i) => [i.name, i]));
    const runtime = new Set<string>(RUNTIME_INSTRUMENTS.map((r) => r.name));
    const m = s.telemetry.metrics();
    expect(m['catan.job.abandonment.runs']).toBeDefined();
    for (const [name, inst] of Object.entries(m)) {
      expect(known.has(name) || runtime.has(name), name).toBe(true);
      const spec = known.get(name);
      if (spec?.kind === 'histogram') {
        for (const p of inst.points) expect(p.buckets!.boundaries, name).toEqual(spec.boundaries);
      }
    }
    expect(m['catan.job.abandonment.duration']!.points[0]!.buckets!.boundaries).toEqual([0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 1, 5, 30]);
  });
});

describe('drain 503s never count as errors (V32)', () => {
  it('POST /api/rooms while draining → 503 with no catan.errors or 5xx', async () => {
    const telemetry = createTelemetry({ mode: 'memory', environment: 'dev', serviceVersion: 'test' });
    const clock = new SystemClock();
    const config = loadServerConfig({});
    const ctx = { config, clock, telemetry, settings: { environment: 'dev' } } as unknown as ServerContext;
    const handler = createHttpHandler(
      ctx,
      {} as never,
      { draining: () => true, playersConnected: () => 0, lastPersistOkAt: () => null, abandonmentJobLastSuccessAt: () => null },
      clock.now(),
      { failedCodes: new FailedCodeLimiter(clock, 10), creates: new CreateRateLimiter(clock, 10, 3_600_000) },
    );
    const http: Server = createServer(handler);
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
    cleanups.push(() => new Promise<void>((r) => http.close(() => r())), () => telemetry.shutdown());
    const port = (http.address() as AddressInfo).port;
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/api/rooms', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.on('error', reject);
      req.end(JSON.stringify({ displayName: 'Ana' }));
    });
    expect(status).toBe(503);
    expect(telemetry.metrics()['catan.errors']).toBeUndefined();
    expect(telemetry.metrics()['catan.http.responses_5xx']).toBeUndefined();
  });
});
