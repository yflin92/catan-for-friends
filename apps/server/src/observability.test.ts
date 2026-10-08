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
import { ALLOWED_LABEL_KEYS } from './metrics';
import { RUNTIME_GAUGES } from './runtime-metrics';
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
  expect(await host.cmd({ t: 'control', op: { kind: 'resume' } })).toMatchObject({ result: 'auth' });
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
    expect(byType['resume']).toMatchObject({ 'catan.action.group': 'system', 'catan.result': 'auth', 'catan.reason_code': 'unknown_room' });
    for (const a of actionSpans) {
      for (const k of ['catan.reduce_ms', 'catan.persist_ms', 'catan.broadcast_ms']) expect(typeof a.attributes[k]).toBe('number');
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

describe('metrics recorded by a real session', () => {
  it('actions.rejected counts every non-ok outcome by reason code', async () => {
    const { s } = await scripted();
    const m = s.telemetry.metrics();
    const rejected = Object.fromEntries(m['catan.actions.rejected']!.points.map((p) => [p.attributes['reason_code'], p.value]));
    expect(rejected).toEqual({ wrong_phase: 1, unknown_room: 1, malformed_action: 1 });
    const actions = m['catan.actions']!.points.reduce((n, p) => n + (p.attributes['result'] !== 'ok' ? (p.value ?? 0) : 0), 0);
    expect(actions).toBe(3);
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
    for (const g of RUNTIME_GAUGES) expect(m[g]!.points[0]!.attributes, g).toEqual({});
    await expect.poll(() => s.telemetry.metrics()['catan.disk.free_bytes']?.points[0]?.value ?? 0).toBeGreaterThan(0);
    expect(s.telemetry.metrics()['catan.disk.free_bytes']!.points[0]!.attributes).toEqual({});
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
