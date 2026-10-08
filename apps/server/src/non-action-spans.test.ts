// Non-action spans (design §9.3, AC33): catan.resync per hello and per resync, server.boot over recovery, server.drain
// over drain steps 1–6, and catan.job.abandonment per job run. Each is a root span carrying counts and outcomes only:
// never a game id, room code, seat or token.
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SpanStatusCode } from '@opentelemetry/api';
import Database from 'better-sqlite3';
import { DEFAULT_GAME_CONFIG, ENGINE_VERSION, createGame, serializeState, stateHash } from '@hexlands/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { loadServerConfig } from './config';
import { RoomManager } from './room-manager';
import { startServer, type RunningServer, type ServerContext } from './server';
import { ShutdownCoordinator } from './shutdown';
import { openGameStore } from './store/sqlite';
import { createTelemetry, type ReadableSpan } from './telemetry';
import type { WsGateway } from './ws-gateway';

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
let n = 0;
const nextId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
type Msg = Record<string, unknown>;

const NON_ACTION = ['catan.resync', 'server.boot', 'server.drain', 'catan.job.abandonment'];
/** Attribute keys that would carry an identifier (design §9.3 keeps those to catan.action). */
const ID_KEY = /(\.id|_id|\.seat|room_code|room\.code|token|\.ip|address)$/;

function dbDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'hexlands-spans-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'db');
}

async function boot(dbPath: string): Promise<RunningServer> {
  const s = await startServer({ port: 0, dbPath, telemetry: 'memory' });
  cleanups.push(() => s.close());
  return s;
}

const named = (s: { telemetry: { spans(): readonly ReadableSpan[] } }, name: string) => s.telemetry.spans().filter((x) => x.name === name);

/** No id-like attribute key, and no attribute or event value containing one of `secrets`. */
function expectNoIds(spans: readonly ReadableSpan[], secrets: readonly string[]): void {
  for (const sp of spans) {
    for (const key of Object.keys(sp.attributes)) expect(key, `${sp.name} ${key}`).not.toMatch(ID_KEY);
    const dump = JSON.stringify([sp.attributes, sp.events.map((e) => e.attributes), sp.status]);
    for (const s of secrets) expect(dump, sp.name).not.toContain(s);
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

async function socket(port: number): Promise<{ ws: WebSocket; cmd(m: Msg): Promise<Msg>; frames: Msg[] }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  cleanups.push(() => ws.terminate());
  await new Promise((r, j) => ws.once('open', r).once('error', j));
  const frames: Msg[] = [];
  const waiters = new Map<string, (m: Msg) => void>();
  ws.on('message', (d) => {
    const m = JSON.parse(String(d)) as Msg;
    frames.push(m);
    if (m['t'] === 'outcome') waiters.get(String(m['actionId']))?.(m);
  });
  return {
    ws,
    frames,
    cmd(m) {
      const actionId = nextId();
      const done = new Promise<Msg>((r) => waiters.set(actionId, r));
      ws.send(JSON.stringify({ ...m, actionId }));
      return done;
    },
  };
}

/** An active 3-player game at seq 0, written straight into the database. */
function seedActiveGame(dbPath: string): { gameId: string; roomCode: string } {
  const store = openGameStore(dbPath);
  const created = createGame({ config: DEFAULT_GAME_CONFIG.rules, playerCount: 3, seed: 'spans' });
  if (!created.ok) throw new Error('createGame failed');
  store.createRoom({ id: 'g-spans', roomCode: 'QWERTY', config: DEFAULT_GAME_CONFIG, hostSeat: 0, createdAt: 0 });
  store.writeSnapshot('g-spans', 0, serializeState(created.state), stateHash(created.state), ENGINE_VERSION, 0);
  store.updateMeta('g-spans', { lifecycle: 'active' });
  store.close();
  return { gameId: 'g-spans', roomCode: 'QWERTY' };
}

describe('server.boot (design §9.3)', () => {
  it('one root span per start with previous_shutdown and the restored/lost counts; no ids', async () => {
    const dbPath = dbDir();
    const game = seedActiveGame(dbPath);
    const s1 = await boot(dbPath);
    expect(named(s1, 'server.boot')).toHaveLength(1);
    const [first] = named(s1, 'server.boot');
    expect(first!.parentSpanContext).toBeUndefined();
    expect(first!.attributes).toEqual({
      'catan.boot.previous_shutdown': 'unclean',
      'catan.boot.games_restored': 1,
      'catan.boot.lost_on_restart': 0,
    });
    expect(first!.status.code).toBe(SpanStatusCode.UNSET);
    await s1.drain();
    const s2 = await boot(dbPath);
    expect(named(s2, 'server.boot').map((x) => x.attributes['catan.boot.previous_shutdown'])).toEqual(['clean']);
    expectNoIds(named(s2, 'server.boot'), [game.gameId, game.roomCode]);
  });
});

describe('catan.resync (design §9.3)', () => {
  it('one root span per hello (with its outcome) and per resync; none for action/lobby/control; no ids', async () => {
    const s = await boot(dbDir());
    const { roomCode, seatToken } = await createRoom(s.port);
    const host = await socket(s.port);
    expect(await host.cmd({ t: 'hello', v: 1, roomCode, seatToken })).toMatchObject({ result: 'ok' });
    const stranger = await socket(s.port);
    expect(await stranger.cmd({ t: 'hello', v: 1, roomCode: 'ZZZZZZ' })).toMatchObject({ result: 'auth' });
    host.ws.send(JSON.stringify({ t: 'resync' }));
    expect(await host.cmd({ t: 'lobby', op: { kind: 'setConfig', absencePolicy: { skipAfterSec: 90 } } })).toMatchObject({ result: 'ok' });

    const spans = named(s, 'catan.resync');
    expect(spans.map((x) => [x.attributes['catan.resync.trigger'], x.attributes['catan.result'] ?? null])).toEqual([
      ['hello', 'ok'],
      ['hello', 'auth'],
      ['resync', null],
    ]);
    expect(spans[1]!.attributes['catan.reason_code']).toEqual(expect.any(String));
    for (const sp of spans) expect(sp.parentSpanContext, sp.name).toBeUndefined();
    const gameId = String(named(s, 'catan.action')[0]!.attributes['catan.game.id']);
    expectNoIds(spans, [roomCode, seatToken, gameId]);
  });
});

describe('catan.job.abandonment (design §9.3)', () => {
  it('one root span per run with counts only; a failed run is status ERROR', async () => {
    const dbPath = dbDir();
    const game = seedActiveGame(dbPath);
    const s = await boot(dbPath);
    s.runAbandonmentJob();
    const [ok] = named(s, 'catan.job.abandonment');
    expect(ok!.parentSpanContext).toBeUndefined();
    expect(ok!.attributes).toEqual({ 'catan.job.games': 1, 'catan.job.failed': 0 });
    expect(ok!.status.code).toBe(SpanStatusCode.UNSET);

    // An unreadable game row: the run carries on, counts the failure and marks its span.
    const db = new Database(dbPath);
    db.prepare('UPDATE games SET config_json = ? WHERE id = ?').run('{', game.gameId);
    db.close();
    s.runAbandonmentJob();
    const runs = named(s, 'catan.job.abandonment');
    expect(runs).toHaveLength(2);
    expect(runs[1]!.status.code).toBe(SpanStatusCode.ERROR);
    expect(runs[1]!.attributes['catan.job.failed']).toBe(1);
    expectNoIds(runs, [game.gameId, game.roomCode]);
  });
});

describe('server.drain (design §9.3, §5.8)', () => {
  it('one root span over steps 1–6, ended before the telemetry flush (so it is exported) and inside the drain deadline', async () => {
    const dbPath = dbDir();
    const game = seedActiveGame(dbPath);
    const s = await boot(dbPath);
    await s.drain();
    // spans() after the drain reads what telemetry kept at its shutdown, the last step of the flush.
    const drains = named(s, 'server.drain');
    expect(drains).toHaveLength(1);
    const [span] = drains;
    expect(span!.parentSpanContext).toBeUndefined();
    expect(span!.attributes).toEqual({ 'catan.drain.games_flushed': 1, 'catan.drain.deadline_hit': false });
    expect(span!.status.code).toBe(SpanStatusCode.UNSET);
    const [secs, nanos] = span!.duration;
    expect(secs * 1000 + nanos / 1e6).toBeLessThan(loadServerConfig({}).ops.drainTimeoutSec * 1000);
    // server.stopped (step 6) is logged inside the span.
    const stopped = s.telemetry
      .logs()
      .map((r) => JSON.parse(r.body as string) as Msg)
      .find((e) => e['event'] === 'server.stopped')!;
    expect(stopped['trace_id']).toBe(span!.spanContext().traceId);
    expectNoIds(drains, [game.gameId, game.roomCode]);
  });

  it('a failing step marks the span ERROR; the drain still resolves and still flushes telemetry', async () => {
    const store = openGameStore(':memory:');
    const telemetry = createTelemetry({ mode: 'memory', environment: 'dev', serviceVersion: 'unit' });
    let flushed = false;
    const shutdown = telemetry.shutdown.bind(telemetry);
    telemetry.shutdown = async () => {
      flushed = true;
      await shutdown();
    };
    const ctx = { config: loadServerConfig({}), store, dbPath: ':memory:', telemetry, clock: { now: () => 0 } } as unknown as ServerContext;
    const gateway = {
      setDraining: () => undefined,
      close: async () => Promise.reject(new Error('socket close failed')),
      connectionOf: () => null,
    } as unknown as WsGateway;
    const rooms = new RoomManager(ctx, () => gateway);
    await new ShutdownCoordinator({ ctx, rooms, gateway, drainStops: [], setDraining: () => undefined, closeHttp: async () => undefined }).drain();
    expect(flushed).toBe(true);
    const [span] = telemetry.spans().filter((x) => x.name === 'server.drain');
    expect(span!.status.code).toBe(SpanStatusCode.ERROR);
    expect(span!.events.map((e) => e.attributes)).toEqual([{ 'exception.type': 'Error' }]);
    store.close();
  });
});

describe('every non-action span is a root span', () => {
  it('across boot, hello, resync, a job run and the drain', async () => {
    const s = await boot(dbDir());
    const { roomCode, seatToken } = await createRoom(s.port);
    const host = await socket(s.port);
    await host.cmd({ t: 'hello', v: 1, roomCode, seatToken });
    host.ws.send(JSON.stringify({ t: 'resync' }));
    await host.cmd({ t: 'lobby', op: { kind: 'setConfig', absencePolicy: { skipAfterSec: 90 } } });
    s.runAbandonmentJob();
    await s.drain();
    const spans = s.telemetry.spans().filter((x) => NON_ACTION.includes(x.name));
    expect(new Set(spans.map((x) => x.name))).toEqual(new Set(NON_ACTION));
    for (const sp of spans) expect(sp.parentSpanContext, sp.name).toBeUndefined();
    expectNoIds(spans, [roomCode, seatToken]);
  });
});
