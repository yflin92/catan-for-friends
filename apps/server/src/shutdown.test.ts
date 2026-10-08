// SIGTERM drain-and-flush and SIGKILL recovery (design §5.8, §5.9; AC27, V23, V24). In-process tests drive
// RunningServer.drain(); process tests run the server as a child (testing/child-server.ts) and send it real signals or
// arm a 'crash' fault, then restart on the same database and check that every ok-acked action is present exactly once.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import {
  DEFAULT_GAME_CONFIG,
  ENGINE_VERSION,
  createGame,
  eligibleSeats,
  reduce,
  serializeState,
  stateHash,
  type Action,
  type GameState,
  type Seat,
} from '@hexlands/engine';
import { sampleLegalAction } from '@hexlands/engine/testing';
import { CloseCode } from '@hexlands/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { hashSeatToken, mintRoomCode, mintSeatToken } from './codes';
import { startServer, type RunningServer, type ServerOptions } from './server';
import { DEPLOY_FORCED_FILE, exitOnShutdownSignals } from './shutdown';
import { openGameStore } from './store/sqlite';
import type { ChildSpec } from './testing/child-server';
import { ArmableFaults } from './testing';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CHILD = path.join(REPO, 'apps/server/src/testing/child-server.ts');
const HOOK = path.join(REPO, 'tooling/ts-resolve-hook.mjs');
/** Generous per-connection limits: the drivers below send as fast as outcomes come back. */
const FAST = { ops: { maxMsgsPerSecPerConn: 1000, maxMsgBurstPerConn: 1000 } };

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function tempDb(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'hexlands-drain-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'hexlands.db');
}

async function boot(dbPath: string, opts: Partial<ServerOptions> = {}): Promise<RunningServer> {
  const s = await startServer({ port: 0, dbPath, telemetry: 'memory', config: FAST, ...opts });
  cleanups.push(() => s.close());
  return s;
}

const counter = (s: RunningServer, name: string, attrs: Record<string, string> = {}): number =>
  (s.telemetry.metrics()[name]?.points ?? [])
    .filter((p) => Object.entries(attrs).every(([k, v]) => p.attributes[k] === v))
    .reduce((n, p) => n + (p.value ?? 0), 0);

const events = (s: RunningServer, name: string): Record<string, unknown>[] =>
  s.telemetry
    .logs()
    .map((r) => JSON.parse(r.body as string) as Record<string, unknown>)
    .filter((e) => e['event'] === name);

// ── a started game written into the store, and a client-side replica that plays it ──────────────────────────────

interface Seeded {
  readonly gameId: string;
  readonly roomCode: string;
  readonly tokens: readonly string[];
  readonly initial: GameState;
}

function seedGame(dbPath: string, seed: string): Seeded {
  const r = createGame({ config: DEFAULT_GAME_CONFIG.rules, playerCount: 3, seed });
  if (!r.ok) throw new Error('createGame failed');
  const store = openGameStore(dbPath);
  const gameId = randomUUID();
  const roomCode = mintRoomCode(6);
  const now = Date.now();
  store.createRoom({ id: gameId, roomCode, config: { ...DEFAULT_GAME_CONFIG, rules: r.state.config }, hostSeat: 0, createdAt: now });
  const tokens = [0, 1, 2].map(() => mintSeatToken());
  tokens.forEach((t, seat) => store.upsertSeat(gameId, seat as Seat, `P${seat}`, hashSeatToken(t), now));
  store.writeSnapshot(gameId, 0, serializeState(r.state), stateHash(r.state), ENGINE_VERSION, now);
  store.updateMeta(gameId, { lifecycle: 'active', seed, engineVersion: ENGINE_VERSION, startedAt: now, lastActionAt: now });
  store.close();
  return { gameId, roomCode, tokens, initial: r.state };
}

type Frame = Record<string, unknown> & { t: string };

class Client {
  readonly frames: Frame[] = [];
  closeCode: number | null = null;
  private waiters = new Map<string, { resolve: (f: Frame) => void; reject: (e: Error) => void }>();
  private constructor(private readonly ws: WebSocket) {
    ws.on('message', (d) => {
      const f = JSON.parse(String(d)) as Frame;
      this.frames.push(f);
      if (f.t === 'outcome') {
        const w = this.waiters.get(String(f['actionId']));
        this.waiters.delete(String(f['actionId']));
        w?.resolve(f);
      }
    });
    ws.on('close', (code) => {
      this.closeCode = code;
      for (const w of this.waiters.values()) w.reject(new Error(`closed ${code}`));
      this.waiters.clear();
    });
    ws.on('error', () => undefined);
  }
  static async open(port: number): Promise<Client> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    cleanups.push(() => ws.terminate());
    await new Promise((r, j) => ws.once('open', r).once('error', j));
    return new Client(ws);
  }
  send(msg: Record<string, unknown>, actionId: string): Promise<Frame> {
    const done = new Promise<Frame>((resolve, reject) => this.waiters.set(actionId, { resolve, reject }));
    this.ws.send(JSON.stringify({ ...msg, actionId }));
    return done;
  }
  hello(roomCode: string, seatToken: string): Promise<Frame> {
    return this.send({ t: 'hello', v: 1, roomCode, seatToken }, randomUUID());
  }
  act(action: Action, actionId: string): Promise<Frame> {
    return this.send({ t: 'action', baseSeq: 0, action }, actionId);
  }
}

/** Plays one game through its seats' sockets, keeping an exact engine replica of the committed state. */
class Table {
  state: GameState;
  seq = 0;
  clients: Client[] = [];
  /** ok-acked actionId → seq. */
  readonly acked = new Map<string, number>();
  /** The action sent last without an outcome yet (or whose socket closed first). */
  pending: { id: string; seat: Seat; action: Action } | null = null;
  private n = 0;

  constructor(readonly game: Seeded) {
    this.state = game.initial;
  }

  async connect(port: number): Promise<void> {
    this.clients = [];
    for (const token of this.game.tokens) {
      const c = await Client.open(port);
      expect(await c.hello(this.game.roomCode, token)).toMatchObject({ result: 'ok' });
      this.clients.push(c);
    }
  }

  private next(): { seat: Seat; action: Action } {
    const rand = () => ((this.n = (this.n * 1103515245 + 12345) >>> 0) / 2 ** 32);
    for (const seat of eligibleSeats(this.state)) {
      const action = sampleLegalAction(this.state, seat, rand);
      if (action) return { seat, action };
    }
    throw new Error('nobody can act');
  }

  /** Sends one action (the pending one first, with its original actionId). Returns false once the server stops. */
  async step(): Promise<boolean> {
    this.pending ??= { id: randomUUID(), ...this.next() };
    const { id, seat, action } = this.pending;
    let out: Frame;
    try {
      out = await this.clients[seat]!.act(action, id);
    } catch {
      return false;
    }
    if (out['result'] === 'error' && out['reasonCode'] === 'server_draining') return false;
    expect(out).toMatchObject({ result: 'ok' });
    this.apply(id, seat, action, out['seq'] as number);
    return true;
  }

  apply(id: string, seat: Seat, action: Action, seq: number): void {
    const res = reduce(this.state, { by: seat, action });
    if (!res.ok) throw new Error(`replica rejected ${action.type}: ${res.reason}`);
    this.state = res.state;
    expect(seq).toBe(this.seq + 1);
    this.seq = seq;
    this.acked.set(id, seq);
    this.pending = null;
  }

  async play(steps: number): Promise<void> {
    for (let i = 0; i < steps; i++) if (!(await this.step())) return;
  }
}

/** Every ok-acked action is in the log exactly once at its acked seq, and seqs are gap-free. */
function assertLog(dbPath: string, t: Table): { seq: number; actionId: string | null }[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare('SELECT seq, action_id AS actionId FROM events WHERE game_id = ? ORDER BY seq')
      .all(t.game.gameId) as { seq: number; actionId: string | null }[];
    expect(rows.map((r) => r.seq)).toEqual(rows.map((_, i) => i + 1));
    for (const [id, seq] of t.acked) expect(rows.filter((r) => r.actionId === id)).toEqual([{ seq, actionId: id }]);
    return rows;
  } finally {
    db.close();
  }
}

// ── child process ────────────────────────────────────────────────────────────────────────────────────────────────

interface Child {
  readonly proc: ChildProcess;
  readonly port: number;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

async function spawnChild(spec: ChildSpec): Promise<Child> {
  const proc = spawn(process.execPath, ['--experimental-transform-types', '--no-warnings', '--import', HOOK, CHILD], {
    cwd: REPO,
    env: { ...process.env, NODE_ENV: 'test', HEXLANDS_CHILD: JSON.stringify({ config: FAST, ...spec }) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  cleanups.push(() => proc.kill('SIGKILL'));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    proc.once('exit', (code, signal) => resolve({ code, signal })),
  );
  let err = '';
  proc.stderr!.on('data', (d: Buffer) => (err += d.toString()));
  const port = await new Promise<number>((resolve, reject) => {
    let out = '';
    proc.stdout!.on('data', (d: Buffer) => {
      out += d.toString();
      const m = /^READY (\d+)$/m.exec(out);
      if (m) resolve(Number(m[1]));
    });
    void exited.then(() => reject(new Error(`child exited before READY: ${err}`)));
  });
  return { proc, port, exited };
}

// ── tests ────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('drain (design §5.8)', () => {
  it('snapshots every loaded game at head, closes sockets with 1012, writes the marker, and restarts clean and replay-free', async () => {
    const dbPath = tempDb();
    const games = [seedGame(dbPath, 'd-1'), seedGame(dbPath, 'd-2')];
    const s = await boot(dbPath);
    const tables = games.map((g) => new Table(g));
    for (const t of tables) {
      await t.connect(s.port);
      await t.play(7);
    }
    await s.drain();
    for (const t of tables) for (const c of t.clients) expect(c.closeCode).toBe(CloseCode.SERVICE_RESTART);
    expect(events(s, 'server.stopped')).toEqual([expect.objectContaining({ games_flushed: 2, drain_ms: expect.any(Number) })]);

    const store = openGameStore(dbPath);
    for (const t of tables) {
      const loaded = store.loadGame(t.game.gameId)!;
      expect(loaded.snapshot?.seq).toBe(t.seq);
      expect(loaded.events).toEqual([]);
    }
    store.close();

    const s2 = await boot(dbPath);
    expect(counter(s2, 'catan.server.starts', { shutdown: 'clean' })).toBe(1);
    expect(counter(s2, 'catan.games.restored_on_start')).toBe(2);
    expect(events(s2, 'server.started')).toEqual([
      expect.objectContaining({ games_restored: 2, lost_on_restart: 0, previous_shutdown: 'clean' }),
    ]);
    for (const t of tables) expect(s2.stateHash(t.game.roomCode)).toEqual({ seq: t.seq, stateHash: stateHash(t.state) });
  });

  it('/healthz, upgrades and POST /api/rooms answer 503 while draining, never counted as errors; drain and close are idempotent', async () => {
    const dbPath = tempDb();
    const s = await boot(dbPath);
    const http = (p: string, method = 'GET', body?: string, headers: Record<string, string> = {}) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port: s.port, path: p, method, headers }, (res) => {
          let b = '';
          res.on('data', (d: Buffer) => (b += d.toString()));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
        });
        req.on('error', reject);
        req.end(body);
      });
    expect((await http('/healthz')).status).toBe(200);
    // A socket that stops reading never answers the 1012 close frame, which holds the drain in step 5 (≤ 1 s).
    const stuck = new WebSocket(`ws://127.0.0.1:${s.port}/ws`);
    cleanups.push(() => stuck.terminate());
    await new Promise((r) => stuck.once('open', r));
    (stuck as unknown as { _socket: { pause(): void } })._socket.pause();

    const drained = s.drain();
    expect(s.drain()).toBe(drained);
    expect(s.close()).toBe(drained);
    await new Promise((r) => setTimeout(r, 100));
    expect(await http('/healthz')).toEqual({ status: 503, body: JSON.stringify({ status: 'draining' }) });
    expect((await http('/api/rooms', 'POST', JSON.stringify({ displayName: 'Ana' }), { 'Content-Type': 'application/json' })).status).toBe(503);
    expect((await http('/ws', 'GET', undefined, { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' })).status).toBe(503);
    await drained;
    expect(counter(s, 'catan.errors')).toBe(0);
    expect(counter(s, 'catan.http.responses_5xx')).toBe(0);
  });

  it('past ops.drainTimeoutSec the remaining snapshots are skipped; the restart replays them losslessly', async () => {
    const dbPath = tempDb();
    const games = [seedGame(dbPath, 't-1'), seedGame(dbPath, 't-2')];
    const faults = new ArmableFaults();
    const s = await boot(dbPath, { faults, config: { ...FAST, ops: { ...FAST.ops, drainTimeoutSec: 1 } } });
    const tables = games.map((g) => new Table(g));
    for (const t of tables) {
      await t.connect(s.port);
      await t.play(3);
    }
    faults.arm('duringDrain', { delayMs: 1100 });
    const started = performance.now();
    await s.drain();
    expect(performance.now() - started).toBeLessThan(1100 + 1000 + 2000);
    expect(events(s, 'server.stopped')).toEqual([expect.objectContaining({ games_flushed: 1 })]);

    const s2 = await boot(dbPath);
    expect(counter(s2, 'catan.server.starts', { shutdown: 'clean' })).toBe(1);
    expect(counter(s2, 'catan.games.lost_on_restart')).toBe(0);
    for (const t of tables) {
      assertLog(dbPath, t);
      expect(s2.stateHash(t.game.roomCode)).toEqual({ seq: t.seq, stateHash: stateHash(t.state) });
    }
  });

  it('a duringDrain snapshot failure is counted and the drain carries on', async () => {
    const dbPath = tempDb();
    const game = seedGame(dbPath, 'f-1');
    const faults = new ArmableFaults();
    const s = await boot(dbPath, { faults });
    const t = new Table(game);
    await t.connect(s.port);
    await t.play(2);
    faults.arm('duringDrain', 'throw');
    await s.drain();
    expect(counter(s, 'catan.errors', { component: 'persist' })).toBe(1);
    expect(events(s, 'server.stopped')).toEqual([expect.objectContaining({ games_flushed: 0 })]);
    const s2 = await boot(dbPath);
    expect(s2.stateHash(game.roomCode)).toEqual({ seq: t.seq, stateHash: stateHash(t.state) });
  });

  it('a forced deploy leaves deploy-forced next to the database: WARN deploy.forced {active_games}, then the marker is gone', async () => {
    const dbPath = tempDb();
    seedGame(dbPath, 'df');
    const s = await boot(dbPath);
    const marker = path.join(path.dirname(dbPath), DEPLOY_FORCED_FILE);
    writeFileSync(marker, '');
    await s.drain();
    expect(events(s, 'deploy.forced')).toEqual([expect.objectContaining({ severity_text: 'WARN', active_games: 1 })]);
    expect(existsSync(marker)).toBe(false);
  });

  it('a plain close() leaves no marker: the next start is unclean but still lossless', async () => {
    const dbPath = tempDb();
    const game = seedGame(dbPath, 'c-1');
    const s = await boot(dbPath);
    const t = new Table(game);
    await t.connect(s.port);
    await t.play(4);
    await s.close();
    const s2 = await boot(dbPath);
    expect(counter(s2, 'catan.server.starts', { shutdown: 'unclean' })).toBe(1);
    expect(s2.stateHash(game.roomCode)).toEqual({ seq: t.seq, stateHash: stateHash(t.state) });
  });
});

describe('telemetry flush during shutdown (bug b55f88ab)', () => {
  it('an unreachable OTLP collector with a pending span: drain finishes within the deadline, never rejects, WARN telemetry.flush_failed', async () => {
    const closedPort = await new Promise<number>((resolve) => {
      const probe = createNetServer().listen(0, '127.0.0.1', () => {
        const { port } = probe.address() as { port: number };
        probe.close(() => resolve(port));
      });
    });
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', `http://127.0.0.1:${closedPort}`);
    cleanups.push(() => vi.unstubAllEnvs());
    const lines: string[] = [];
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
    cleanups.push(() => write.mockRestore());

    const dbPath = tempDb();
    const game = seedGame(dbPath, 'otlp');
    const s = await boot(dbPath, { telemetry: 'otlp' });
    const t = new Table(game);
    await t.connect(s.port);
    await t.play(1); // one catan.action span waits in the batch processor
    const started = performance.now();
    await expect(s.drain()).resolves.toBeUndefined();
    expect(performance.now() - started).toBeLessThan(10_000);
    write.mockRestore();
    const logged = lines.flatMap((l) => l.split('\n')).filter((l) => l.startsWith('{'));
    expect(logged.map((l) => JSON.parse(l) as Record<string, unknown>)).toContainEqual(
      expect.objectContaining({ event: 'telemetry.flush_failed', severity_text: 'WARN' }),
    );
  }, 20_000);
});

describe('exitOnShutdownSignals', () => {
  it('SIGTERM and SIGINT drain once, then exit(0); a second signal is ignored', async () => {
    const proc = new EventEmitter() as EventEmitter & { exit: (code: number) => void };
    const exits: number[] = [];
    proc.exit = (code) => void exits.push(code);
    let drains = 0;
    let release!: () => void;
    const server = { drain: () => ((drains += 1), new Promise<void>((r) => (release = r))) };
    const remove = exitOnShutdownSignals(server, proc as unknown as Parameters<typeof exitOnShutdownSignals>[1]);
    proc.emit('SIGTERM');
    proc.emit('SIGINT');
    expect(drains).toBe(1);
    expect(exits).toEqual([]);
    release();
    await new Promise((r) => setImmediate(r));
    expect(exits).toEqual([0]);
    remove();
    expect(proc.listenerCount('SIGTERM')).toBe(0);
  });
});

describe('real signals against a child process (V23, V24)', () => {
  it('SIGTERM under load: exit 0 within the deadline, 1012 to every socket, no acked loss, pending actions resent once', async () => {
    const dbPath = tempDb();
    const games = [seedGame(dbPath, 'l-1'), seedGame(dbPath, 'l-2'), seedGame(dbPath, 'l-3')];
    const child = await spawnChild({ dbPath });
    const tables = games.map((g) => new Table(g));
    for (const t of tables) await t.connect(child.port);
    const loops = tables.map((t) => t.play(400));
    await new Promise((r) => setTimeout(r, 300));
    const sent = performance.now();
    child.proc.kill('SIGTERM');
    await Promise.all(loops);
    expect(await child.exited).toEqual({ code: 0, signal: null });
    expect(performance.now() - sent).toBeLessThan(10_000);
    for (const t of tables) for (const c of t.clients) expect(c.closeCode).toBe(CloseCode.SERVICE_RESTART);
    expect(tables.every((t) => t.seq > 0)).toBe(true);

    const s = await boot(dbPath);
    expect(counter(s, 'catan.server.starts', { shutdown: 'clean' })).toBe(1);
    expect(counter(s, 'catan.games.restored_on_start')).toBe(3);
    expect(counter(s, 'catan.games.lost_on_restart')).toBe(0);
    const store = openGameStore(dbPath);
    for (const t of tables) {
      expect(store.loadGame(t.game.gameId)!.events).toEqual([]);
      assertLog(dbPath, t);
      expect(s.stateHash(t.game.roomCode)).toEqual({ seq: t.seq, stateHash: stateHash(t.state) });
      // The client resends whatever was pending with its original actionId; it commits exactly once.
      await t.connect(s.port);
      const before = t.seq;
      await t.play(2);
      expect(t.seq).toBe(before + 2);
      assertLog(dbPath, t);
    }
    store.close();
  }, 30_000);

  it.each([
    ['beforePersist', 5, false],
    ['afterPersistBeforeAck', 5, true],
    ['beforeSnapshot', 25, true],
  ] as const)('SIGKILL at %s (seq %i): no ok-acked action lost, none applied twice', async (point, seq, durable) => {
    const dbPath = tempDb();
    const game = seedGame(dbPath, `k-${point}`);
    const child = await spawnChild({ dbPath, faults: [{ point, action: 'crash', seq }] });
    const t = new Table(game);
    await t.connect(child.port);
    await t.play(seq + 5);
    expect(await child.exited).toEqual({ code: null, signal: 'SIGKILL' });
    expect(t.seq).toBe(seq - 1);
    expect(t.pending).not.toBeNull();

    const s = await boot(dbPath);
    expect(counter(s, 'catan.server.starts', { shutdown: 'unclean' })).toBe(1);
    expect(counter(s, 'catan.games.lost_on_restart')).toBe(0);
    const rows = assertLog(dbPath, t);
    expect(rows.length).toBe(durable ? seq : seq - 1);
    // The resend of the un-acked action gets ok at `seq` either way: the original commit, or a first one.
    const pending = t.pending!;
    await t.connect(s.port);
    expect(await t.step()).toBe(true);
    expect(t.acked.get(pending.id)).toBe(seq);
    expect(assertLog(dbPath, t).length).toBe(seq);
    expect(s.stateHash(game.roomCode)).toEqual({ seq, stateHash: stateHash(t.state) });
  }, 30_000);

  it('SIGKILL during the drain (duringDrain): the restart is unclean and still lossless', async () => {
    const dbPath = tempDb();
    const game = seedGame(dbPath, 'k-drain');
    const child = await spawnChild({ dbPath, faults: [{ point: 'duringDrain', action: 'crash' }] });
    const t = new Table(game);
    await t.connect(child.port);
    await t.play(9);
    child.proc.kill('SIGTERM');
    expect(await child.exited).toEqual({ code: null, signal: 'SIGKILL' });

    const s = await boot(dbPath);
    expect(counter(s, 'catan.server.starts', { shutdown: 'unclean' })).toBe(1);
    expect(counter(s, 'catan.games.lost_on_restart')).toBe(0);
    assertLog(dbPath, t);
    expect(s.stateHash(game.roomCode)).toEqual({ seq: t.seq, stateHash: stateHash(t.state) });
  }, 30_000);
});
