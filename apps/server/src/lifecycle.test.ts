import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_GAME_CONFIG,
  ENGINE_VERSION,
  STANDARD_TOPOLOGY,
  deserializeState,
  serializeState,
  stateHash,
  type GameState,
  type Seat,
  type VertexId,
} from '@hexlands/engine';
import { buildState } from '@hexlands/engine/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { hashSeatToken, mintRoomCode, mintSeatToken } from './codes';
import { evaluate } from './lifecycle';
import { startServer, type RunningServer } from './server';
import type { GameMetaRow } from './store/game-store';
import { openGameStore, type SqliteGameStore } from './store/sqlite';
import { FakeClock } from './testing';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 9, 8, 12, 0, 0);

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

// ── evaluate() ───────────────────────────────────────────────────────────────

const L = DEFAULT_GAME_CONFIG.lifecycle;
const row = (over: Partial<GameMetaRow>): Parameters<typeof evaluate>[0] => ({
  lifecycle: 'active',
  config: DEFAULT_GAME_CONFIG,
  createdAt: T0,
  startedAt: T0,
  lastLobbyActivityAt: T0,
  lastActionAt: T0,
  allDisconnectedSince: null,
  abandonedAt: null,
  ...over,
});

describe('evaluate (design §5.7): pure, ≥ comparisons', () => {
  it('active → abandoned for inactivity at 30:00, not at 29:59', () => {
    expect(evaluate(row({}), T0 + 30 * MIN - 1000)).toBeNull();
    expect(evaluate(row({}), T0 + 30 * MIN)).toEqual({ from: 'active', to: 'abandoned', reason: 'inactivity' });
  });

  it('active → abandoned when all seats are disconnected for 10:00, not 9:59', () => {
    const r = row({ lastActionAt: T0 + 20 * MIN, allDisconnectedSince: T0 + 20 * MIN });
    expect(evaluate(r, T0 + 30 * MIN - 1000)).toBeNull();
    expect(evaluate(r, T0 + 30 * MIN)).toEqual({ from: 'active', to: 'abandoned', reason: 'all_disconnected' });
    expect(evaluate(row({ lastActionAt: T0 + 20 * MIN }), T0 + 49 * MIN)).toBeNull();
  });

  it('inactivity wins when both thresholds are due', () => {
    expect(evaluate(row({ allDisconnectedSince: T0 }), T0 + 30 * MIN)).toMatchObject({ reason: 'inactivity' });
  });

  it('lobby → expired at 24 h of lobby inactivity', () => {
    const r = row({ lifecycle: 'lobby', startedAt: null, lastActionAt: null, lastLobbyActivityAt: T0 + HOUR });
    expect(evaluate(r, T0 + 25 * HOUR - 1)).toBeNull();
    expect(evaluate(r, T0 + 25 * HOUR)).toEqual({ from: 'lobby', to: 'expired' });
  });

  it('abandoned → expired at 7 days after abandoned_at', () => {
    const r = row({ lifecycle: 'abandoned', abandonedAt: T0 });
    expect(evaluate(r, T0 + 7 * DAY - 1)).toBeNull();
    expect(evaluate(r, T0 + 7 * DAY)).toEqual({ from: 'abandoned', to: 'expired' });
  });

  it('finished and expired are terminal', () => {
    expect(evaluate(row({ lifecycle: 'finished' }), T0 + 400 * DAY)).toBeNull();
    expect(evaluate(row({ lifecycle: 'expired' }), T0 + 400 * DAY)).toBeNull();
  });

  it('reads the thresholds from the game row’s own lifecycle config', () => {
    const config = { ...DEFAULT_GAME_CONFIG, lifecycle: { ...L, inactivityAbandonMin: 5 } };
    expect(evaluate(row({ config }), T0 + 5 * MIN)).toMatchObject({ to: 'abandoned' });
  });
});

// ── server fixtures ──────────────────────────────────────────────────────────

interface Booted {
  s: RunningServer;
  store: SqliteGameStore;
  clock: FakeClock;
  dbPath: string;
}

async function boot(clock = new FakeClock(T0), dbPath?: string): Promise<Booted> {
  if (dbPath === undefined) {
    const dir = mkdtempSync(path.join(tmpdir(), 'hexlands-life-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    dbPath = path.join(dir, 'db');
  }
  const s = await startServer({ port: 0, dbPath, telemetry: 'memory', clock, buildVersion: 'v-life' });
  const store = openGameStore(dbPath);
  cleanups.push(() => s.close(), () => store.close());
  return { s, store, clock, dbPath };
}

interface Game {
  gameId: string;
  roomCode: string;
  tokens: string[];
  state: GameState;
}

/** Seat 0 active in main on turn 3 (endTurn is legal). */
const mainState = (): GameState => buildState({ playerCount: 3, phase: { name: 'main' }, turn: { number: 3, active: 0 } });

/** A started game written into the store at clock time: seats, the seq-0 snapshot, lifecycle active. */
function startGame(b: Booted, state: GameState = mainState()): Game {
  const gameId = randomUUID();
  const roomCode = mintRoomCode(6);
  const now = b.clock.now();
  b.store.createRoom({ id: gameId, roomCode, config: { ...DEFAULT_GAME_CONFIG, rules: state.config }, hostSeat: 0, createdAt: now });
  const tokens = Array.from({ length: state.playerCount }, () => mintSeatToken());
  tokens.forEach((t, seat) => b.store.upsertSeat(gameId, seat as Seat, `P${seat}`, hashSeatToken(t), now));
  b.store.writeSnapshot(gameId, 0, serializeState(state), stateHash(state), ENGINE_VERSION, now);
  b.store.updateMeta(gameId, { lifecycle: 'active', seed: 'life-seed', engineVersion: ENGINE_VERSION, startedAt: now, lastActionAt: now });
  return { gameId, roomCode, tokens, state };
}

const meta = (b: Booted, g: Game) => b.store.findGame(g.gameId)!;
const logs = (b: Booted) => b.s.telemetry.logs().map((r) => JSON.parse(r.body as string) as Record<string, unknown>);
const points = (b: Booted, name: string) => b.s.telemetry.metrics()[name]?.points ?? [];
const transitions = (b: Booted, from: string, to: string) =>
  (points(b, 'catan.games.transitions').find((p) => p.attributes['from'] === from && p.attributes['to'] === to)?.value as number) ?? 0;

type Frame = Record<string, unknown> & { t: string };

class Client {
  readonly frames: Frame[] = [];
  closeCode: number | null = null;
  private readonly ws: WebSocket;
  private waiters: (() => void)[] = [];

  constructor(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    cleanups.push(() => this.ws.terminate());
    this.ws.on('message', (d) => {
      this.frames.push(JSON.parse(String(d)) as Frame);
      this.wake();
    });
    this.ws.on('close', (code) => {
      this.closeCode = code;
      this.wake();
    });
  }

  static async open(port: number): Promise<Client> {
    const c = new Client(port);
    await new Promise((r, j) => c.ws.once('open', r).once('error', j));
    return c;
  }

  send(msg: Record<string, unknown>): Promise<Frame> {
    const actionId = randomUUID();
    this.ws.send(JSON.stringify({ ...msg, actionId }));
    return this.until(() => this.frames.find((f) => f.t === 'outcome' && f['actionId'] === actionId));
  }

  hello(roomCode: string, seatToken?: string): Promise<Frame> {
    return this.send({ t: 'hello', v: 1, roomCode, ...(seatToken !== undefined ? { seatToken } : {}) });
  }

  act(action: Record<string, unknown>, baseSeq = 0): Promise<Frame> {
    return this.send({ t: 'action', baseSeq, action });
  }

  control(op: Record<string, unknown>): Promise<Frame> {
    return this.send({ t: 'control', op });
  }

  async close(): Promise<void> {
    this.ws.close();
    await this.until(() => (this.closeCode !== null ? true : undefined));
  }

  until<T>(probe: () => T | undefined, ms = 3000): Promise<T> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const v = probe();
        if (v === undefined) return false;
        clearTimeout(timer);
        this.waiters = this.waiters.filter((w) => w !== check);
        resolve(v);
        return true;
      };
      const timer = setTimeout(() => reject(new Error('timed out waiting for a frame')), ms);
      if (!check()) this.waiters.push(check);
    });
  }

  private wake(): void {
    for (const w of [...this.waiters]) w();
  }
}

/** Waits until the server has processed the socket close (the disconnect hook runs asynchronously). */
async function settle(probe: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !probe(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(probe()).toBe(true);
}

// ── AbandonmentJob + LifecycleService ────────────────────────────────────────

describe('abandonment (AC29)', () => {
  it('inactivity: still active at 29:59, abandoned at 30:00 by the periodic job, with snapshot, event and metric', async () => {
    const b = await boot();
    const g = startGame(b);
    b.clock.advance(30 * MIN - 1000);
    b.s.runAbandonmentJob();
    expect(meta(b, g).lifecycle).toBe('active');
    b.clock.advance(1000); // the 60 s job interval fires at exactly 30:00
    expect(meta(b, g)).toMatchObject({ lifecycle: 'abandoned', abandonReason: 'inactivity', abandonedAt: T0 + 30 * MIN });
    expect(logs(b)).toContainEqual(expect.objectContaining({ event: 'game.abandoned', game_id: g.gameId, reason: 'inactivity' }));
    expect(transitions(b, 'active', 'abandoned')).toBe(1);
    expect(points(b, 'catan.games')).toContainEqual({ attributes: { state: 'abandoned' }, value: 1 });
  });

  it('all disconnected: 9:59 after the last seated socket leaves is active, 10:00 is abandoned', async () => {
    const b = await boot();
    const g = startGame(b);
    const c = await Client.open(b.s.port);
    expect(await c.hello(g.roomCode, g.tokens[0])).toMatchObject({ result: 'ok' });
    expect(meta(b, g).allDisconnectedSince).toBeNull();
    b.clock.advance(5 * MIN);
    await c.close();
    await settle(() => meta(b, g).allDisconnectedSince !== null);
    expect(meta(b, g).allDisconnectedSince).toBe(T0 + 5 * MIN);
    b.clock.advance(10 * MIN - 1000);
    b.s.runAbandonmentJob();
    expect(meta(b, g).lifecycle).toBe('active');
    b.clock.advance(1000);
    b.s.runAbandonmentJob();
    expect(meta(b, g)).toMatchObject({ lifecycle: 'abandoned', abandonReason: 'all_disconnected' });
  });

  it('a seated reconnect clears all_disconnected_since', async () => {
    const b = await boot();
    const g = startGame(b);
    const c = await Client.open(b.s.port);
    await c.hello(g.roomCode, g.tokens[1]);
    await c.close();
    await settle(() => meta(b, g).allDisconnectedSince !== null);
    const d = await Client.open(b.s.port);
    await d.hello(g.roomCode, g.tokens[2]);
    expect(meta(b, g).allDisconnectedSince).toBeNull();
  });

  it('the job is idempotent: a second run at the same time changes nothing', async () => {
    const b = await boot();
    const g = startGame(b);
    b.clock.advance(30 * MIN);
    const once = meta(b, g);
    b.s.runAbandonmentJob();
    b.s.runAbandonmentJob();
    expect(meta(b, g)).toEqual(once);
    expect(transitions(b, 'active', 'abandoned')).toBe(1);
    expect(logs(b).filter((e) => e['event'] === 'game.abandoned')).toHaveLength(1);
  });
});

describe('resume (AC29): stateHash unchanged, last_action_at = now', () => {
  /**
   * A game with one committed action (seq 1), then abandoned for inactivity by the job while client `c` (seat 0) stays
   * connected. Time is moved through last_action_at rather than the clock, so the gateway heartbeat keeps `c` open.
   */
  async function abandoned() {
    const b = await boot();
    const g = startGame(b);
    const c = await Client.open(b.s.port);
    await c.hello(g.roomCode, g.tokens[0]);
    expect(await c.act({ type: 'endTurn' })).toMatchObject({ result: 'ok', seq: 1 });
    const hash = b.store.loadGame(g.gameId)!.events.at(-1)!.hashAfter;
    b.store.updateMeta(g.gameId, { lastActionAt: b.clock.now() - 30 * MIN });
    b.s.runAbandonmentJob();
    expect(meta(b, g)).toMatchObject({ lifecycle: 'abandoned', abandonReason: 'inactivity' });
    const snap = b.store.loadGame(g.gameId)!.snapshot!;
    expect([snap.seq, snap.stateHash]).toEqual([1, hash]);
    return { b, g, c, hash };
  }

  it('a seated hello resumes (reason rejoin) and gets the same state', async () => {
    const { b, g, hash } = await abandoned();
    b.clock.advance(2 * HOUR);
    const d = await Client.open(b.s.port);
    expect(await d.hello(g.roomCode, g.tokens[1])).toMatchObject({ result: 'ok' });
    const now = b.clock.now();
    expect(meta(b, g)).toMatchObject({ lifecycle: 'active', lastActionAt: now, abandonedAt: null, allDisconnectedSince: null });
    expect(d.frames.find((f) => f.t === 'welcome')).toMatchObject({ seq: 1 });
    const snap = deserializeState(b.store.loadGame(g.gameId)!.snapshot!.stateJson);
    expect(snap.ok && stateHash(snap.state)).toBe(hash);
    expect(logs(b)).toContainEqual(expect.objectContaining({ event: 'game.resumed', game_id: g.gameId, reason: 'rejoin', abandoned_s: 7200 }));
    expect(transitions(b, 'abandoned', 'active')).toBe(1);
  });

  it('a seatless hello does not resume', async () => {
    const { b, g } = await abandoned();
    const d = await Client.open(b.s.port);
    expect(await d.hello(g.roomCode)).toMatchObject({ result: 'ok' });
    expect(meta(b, g).lifecycle).toBe('abandoned');
  });

  it('control resume from a seated player resumes (reason resume); on an active game it is a no-op ok', async () => {
    const { b, g, c } = await abandoned();
    expect(await c.control({ kind: 'resume' })).toMatchObject({ result: 'ok' });
    expect(meta(b, g).lifecycle).toBe('active');
    expect(logs(b)).toContainEqual(expect.objectContaining({ event: 'game.resumed', reason: 'resume' }));
    expect(await c.control({ kind: 'resume' })).toMatchObject({ result: 'ok' });
    expect(transitions(b, 'abandoned', 'active')).toBe(1);
  });

  it('an action from a seated player resumes implicitly (reason action) and is processed normally', async () => {
    const { b, g, c, hash } = await abandoned();
    const before = b.clock.now();
    expect(await c.act({ type: 'rollDice' }, 1)).toMatchObject({ result: 'turn', reasonCode: 'not_your_turn' });
    expect(meta(b, g)).toMatchObject({ lifecycle: 'active', lastActionAt: before });
    expect(logs(b)).toContainEqual(expect.objectContaining({ event: 'game.resumed', reason: 'action' }));
    const s1 = await Client.open(b.s.port);
    await s1.hello(g.roomCode, g.tokens[1]);
    expect(await s1.act({ type: 'rollDice' }, 1)).toMatchObject({ result: 'ok', seq: 2 });
    // The resumed game continues from the abandoned head: the seq-1 snapshot keeps its hash and seq 2 follows it.
    const after = b.store.loadGame(g.gameId)!;
    expect([after.snapshot!.seq, after.snapshot!.stateHash, after.events.map((e) => e.seq)]).toEqual([1, hash, [2]]);
  });
});

describe('clients see lifecycle transitions without reconnecting (bug c5981bfb)', () => {
  type RoomFrame = { t: 'room'; rev: number; room: { lifecycle: string } };
  const rooms = (c: Client) => c.frames.filter((f): f is Frame & RoomFrame => f.t === 'room');
  const roomWith = (c: Client, lifecycle: string) =>
    c.until(() => rooms(c).find((f) => f.room.lifecycle === lifecycle));

  it('finish: the winning action’s final state, then room{lifecycle: finished} with room_rev + 1', async () => {
    const free: VertexId[] = [];
    for (const v of STANDARD_TOPOLOGY.vertices) {
      if (!free.some((x) => x === v || STANDARD_TOPOLOGY.vertexNeighbours(x).includes(v))) free.push(v);
      if (free.length === 6) break;
    }
    const state = buildState({
      playerCount: 3,
      phase: { name: 'main' },
      turn: { number: 9, active: 0 },
      pieces: [{ seat: 0, cities: free.slice(0, 3), settlements: free.slice(3, 6) }],
      hands: { 0: { grain: 2, ore: 3 } },
    });
    const b = await boot();
    const g = startGame(b, state);
    const c = await Client.open(b.s.port);
    const watcher = await Client.open(b.s.port);
    await c.hello(g.roomCode, g.tokens[0]);
    await watcher.hello(g.roomCode, g.tokens[1]);
    const rev0 = meta(b, g).roomRev;
    expect(await c.act({ type: 'buildCity', vertex: free[3] })).toMatchObject({ result: 'ok', seq: 1 });
    for (const client of [c, watcher]) {
      const room = await roomWith(client, 'finished');
      expect(room.rev).toBe(rev0 + 1);
      const finalState = client.frames.findIndex((f) => f.t === 'state' && f['seq'] === 1);
      expect(finalState).toBeGreaterThanOrEqual(0);
      expect(finalState).toBeLessThan(client.frames.indexOf(room));
    }
    expect(meta(b, g).roomRev).toBe(rev0 + 1);
  });

  it('abandon and resume each bump room_rev once and reach every bound socket; revs only grow', async () => {
    const b = await boot();
    const g = startGame(b);
    const c = await Client.open(b.s.port);
    await c.hello(g.roomCode, g.tokens[0]);
    const rev0 = meta(b, g).roomRev;
    b.store.updateMeta(g.gameId, { lastActionAt: b.clock.now() - 30 * MIN });
    b.s.runAbandonmentJob();
    expect((await roomWith(c, 'abandoned')).rev).toBe(rev0 + 1);
    // A second seat rejoining resumes the game; the socket that was already bound hears about it.
    const d = await Client.open(b.s.port);
    await d.hello(g.roomCode, g.tokens[1]);
    expect((await roomWith(c, 'active')).rev).toBe(rev0 + 2);
    expect(meta(b, g)).toMatchObject({ lifecycle: 'active', roomRev: rev0 + 2 });
    // Implicit resume by an action: abandon again, then act.
    b.store.updateMeta(g.gameId, { lastActionAt: b.clock.now() - 30 * MIN });
    b.s.runAbandonmentJob();
    await c.until(() => (rooms(c).filter((f) => f.room.lifecycle === 'abandoned').length === 2 ? true : undefined));
    expect(await c.act({ type: 'endTurn' })).toMatchObject({ result: 'ok' });
    await c.until(() => (rooms(c).filter((f) => f.room.lifecycle === 'active').length === 2 ? true : undefined));
    const revs = rooms(c).map((f) => f.rev);
    expect(revs).toEqual([rev0 + 1, rev0 + 2, rev0 + 3, rev0 + 4]);
  });

  it('expiry with a socket still bound sends room{lifecycle: expired}', async () => {
    const b = await boot();
    const g = startGame(b);
    const c = await Client.open(b.s.port);
    await c.hello(g.roomCode, g.tokens[0]);
    const rev0 = meta(b, g).roomRev;
    b.store.updateMeta(g.gameId, { lifecycle: 'abandoned', abandonedAt: b.clock.now() - 7 * DAY, abandonReason: 'inactivity' });
    b.s.runAbandonmentJob();
    expect((await roomWith(c, 'expired')).rev).toBe(rev0 + 1);
  });

  it('room_rev is persisted with the transition: after a restart the next room message continues the sequence', async () => {
    const b = await boot();
    const g = startGame(b);
    const c = await Client.open(b.s.port);
    await c.hello(g.roomCode, g.tokens[0]);
    const rev0 = meta(b, g).roomRev;
    b.store.updateMeta(g.gameId, { lastActionAt: b.clock.now() - 30 * MIN });
    b.s.runAbandonmentJob();
    const broadcast = (await roomWith(c, 'abandoned')).rev;
    expect(broadcast).toBe(rev0 + 1);
    // The lifecycle and its rev were written by the same UPDATE.
    expect(meta(b, g)).toMatchObject({ lifecycle: 'abandoned', roomRev: broadcast });
    await b.s.close();
    const b2 = await boot(new FakeClock(b.clock.now()), b.dbPath);
    expect(meta(b2, g).roomRev).toBe(broadcast);
    // A visitor is bound when a seated rejoin resumes the game: its room message carries the next rev, never a reused one.
    const visitor = await Client.open(b2.s.port);
    await visitor.hello(g.roomCode);
    const seated = await Client.open(b2.s.port);
    await seated.hello(g.roomCode, g.tokens[1]);
    expect((await roomWith(visitor, 'active')).rev).toBe(broadcast + 1);
    expect(meta(b2, g).roomRev).toBe(broadcast + 1);
  });

  it('D24 no-ops (control resume on an active game) send no room message and keep room_rev', async () => {
    const b = await boot();
    const g = startGame(b);
    const c = await Client.open(b.s.port);
    await c.hello(g.roomCode, g.tokens[0]);
    const rev0 = meta(b, g).roomRev;
    const before = rooms(c).length;
    expect(await c.control({ kind: 'resume' })).toMatchObject({ result: 'ok' });
    expect(rooms(c)).toHaveLength(before);
    expect(meta(b, g).roomRev).toBe(rev0);
  });

  it('job transitions with no socket bound leave room_rev alone', async () => {
    const b = await boot();
    const g = startGame(b);
    const rev0 = meta(b, g).roomRev;
    b.clock.advance(30 * MIN);
    expect(meta(b, g)).toMatchObject({ lifecycle: 'abandoned', roomRev: rev0 });
  });
});

describe('control resume outside abandoned (design D24)', () => {
  it('active → ok no-op; finished → game_over; expired → game_expired; seq never advances', async () => {
    const b = await boot();
    const g = startGame(b);
    const c = await Client.open(b.s.port);
    await c.hello(g.roomCode, g.tokens[0]);
    const before = meta(b, g);
    const ok = await c.control({ kind: 'resume' });
    expect(ok).toMatchObject({ result: 'ok' });
    expect(ok['seq']).toBeUndefined();
    expect(meta(b, g)).toEqual(before);
    b.store.updateMeta(g.gameId, { lifecycle: 'finished', endReason: 'won', endedAt: b.clock.now() });
    expect(await c.control({ kind: 'resume' })).toMatchObject({ result: 'rule', reasonCode: 'game_over' });
    b.store.updateMeta(g.gameId, { lifecycle: 'expired', endReason: 'abandoned_expired' });
    expect(await c.control({ kind: 'resume' })).toMatchObject({ result: 'rule', reasonCode: 'game_expired' });
    expect(meta(b, g).headSeq).toBe(0);
    expect(transitions(b, 'abandoned', 'active')).toBe(0);
  });

  it('lobby → ok no-op for a seated member', async () => {
    const b = await boot();
    const gameId = randomUUID();
    const roomCode = mintRoomCode(6);
    const token = mintSeatToken();
    b.store.createRoom({ id: gameId, roomCode, config: DEFAULT_GAME_CONFIG, hostSeat: 0, createdAt: T0 });
    b.store.upsertSeat(gameId, 0, 'Host', hashSeatToken(token), T0);
    const c = await Client.open(b.s.port);
    expect(await c.hello(roomCode, token)).toMatchObject({ result: 'ok' });
    const before = b.store.findGame(gameId);
    expect(await c.control({ kind: 'resume' })).toMatchObject({ result: 'ok' });
    expect(b.store.findGame(gameId)).toEqual(before);
  });
});

describe('expiry and retention (AC29, design §4)', () => {
  it('abandoned → expired at 7 days by the job, game.ended{expired, abandoned}, then purged', async () => {
    const b = await boot();
    const g = startGame(b);
    b.clock.advance(30 * MIN);
    expect(meta(b, g).lifecycle).toBe('abandoned');
    b.clock.advance(7 * DAY - 2 * MIN);
    b.s.runAbandonmentJob();
    expect(meta(b, g).lifecycle).toBe('abandoned');
    b.clock.advance(2 * MIN);
    expect(meta(b, g)).toMatchObject({ lifecycle: 'expired', endReason: 'abandoned_expired', roomCode: null });
    expect(b.store.loadGame(g.gameId)).toMatchObject({ seats: [], snapshot: null, events: [] });
    expect(logs(b)).toContainEqual(
      expect.objectContaining({ event: 'game.ended', game_id: g.gameId, outcome: 'expired', from_state: 'abandoned', seed: 'life-seed' }),
    );
    expect(transitions(b, 'abandoned', 'expired')).toBe(1);
    const c = await Client.open(b.s.port);
    expect(await c.hello(g.roomCode, g.tokens[0])).toMatchObject({ result: 'auth', reasonCode: 'unknown_room' });
  });

  it('a hello that finds the resume window over answers game_expired (close 4410)', async () => {
    const b = await boot();
    const g = startGame(b);
    b.store.updateMeta(g.gameId, { lifecycle: 'abandoned', abandonedAt: b.clock.now() - 7 * DAY, abandonReason: 'inactivity' });
    const c = await Client.open(b.s.port);
    expect(await c.hello(g.roomCode, g.tokens[0])).toMatchObject({ result: 'rule', reasonCode: 'game_expired' });
    await c.until(() => (c.closeCode !== null ? true : undefined));
    expect(c.closeCode).toBe(4410);
    expect(meta(b, g)).toMatchObject({ lifecycle: 'expired', endReason: 'abandoned_expired' });
  });

  it('an action or control on a game that expired meanwhile answers game_expired', async () => {
    const b = await boot();
    const g = startGame(b);
    const c = await Client.open(b.s.port);
    await c.hello(g.roomCode, g.tokens[0]);
    b.store.updateMeta(g.gameId, { lifecycle: 'abandoned', abandonedAt: b.clock.now() - 7 * DAY, abandonReason: 'inactivity' });
    expect(await c.act({ type: 'endTurn' })).toMatchObject({ result: 'rule', reasonCode: 'game_expired' });
    expect(await c.control({ kind: 'resume' })).toMatchObject({ result: 'rule', reasonCode: 'game_expired' });
  });

  it('lobby → expired after 24 h without lobby activity, then purged', async () => {
    const b = await boot();
    const gameId = randomUUID();
    b.store.createRoom({ id: gameId, roomCode: mintRoomCode(6), config: DEFAULT_GAME_CONFIG, hostSeat: 0, createdAt: T0 });
    b.clock.advance(24 * HOUR - 1000);
    b.s.runAbandonmentJob();
    expect(b.store.findGame(gameId)!.lifecycle).toBe('lobby');
    b.clock.advance(1000);
    b.s.runAbandonmentJob();
    expect(b.store.findGame(gameId)).toMatchObject({ lifecycle: 'expired', endReason: 'lobby_expired', roomCode: null });
    expect(logs(b)).toContainEqual(expect.objectContaining({ event: 'game.ended', outcome: 'expired', from_state: 'lobby' }));
    expect(transitions(b, 'lobby', 'expired')).toBe(1);
  });
});

describe('finish on gameOver (AC18 lifecycle part)', () => {
  // Seat 0 at 9 VP (3 cities, 3 settlements) holding a city's cost: buildCity reaches 10 and wins.
  it('ends an active game: lifecycle finished, ended_at, game.ended{finished}, histogram; purged after 7 days', async () => {
    const free: VertexId[] = [];
    for (const v of STANDARD_TOPOLOGY.vertices) {
      if (!free.some((c) => c === v || STANDARD_TOPOLOGY.vertexNeighbours(c).includes(v))) free.push(v);
      if (free.length === 6) break;
    }
    const state = buildState({
      playerCount: 3,
      phase: { name: 'main' },
      turn: { number: 9, active: 0 },
      pieces: [{ seat: 0, cities: free.slice(0, 3), settlements: free.slice(3, 6) }],
      hands: { 0: { grain: 2, ore: 3 } },
    });
    const b = await boot();
    const g = startGame(b, state);
    b.clock.advance(20 * MIN);
    const c = await Client.open(b.s.port);
    await c.hello(g.roomCode, g.tokens[0]);
    expect(await c.act({ type: 'buildCity', vertex: free[3] })).toMatchObject({ result: 'ok', seq: 1 });
    const endedAt = b.clock.now();
    expect(meta(b, g)).toMatchObject({ lifecycle: 'finished', endReason: 'won', endedAt });
    expect(meta(b, g).activePlayMs).toBe(20 * MIN);
    expect(logs(b)).toContainEqual(
      expect.objectContaining({
        event: 'game.ended',
        outcome: 'finished',
        from_state: 'active',
        winner_seat: 0,
        turns: 9,
        active_play_s: 1200,
        wall_s: 1200,
        vp_by_seat: [10, 0, 0],
        seed: 'life-seed',
      }),
    );
    expect(transitions(b, 'active', 'finished')).toBe(1);
    expect(points(b, 'catan.game.active_play')).toHaveLength(1);
    expect(await c.act({ type: 'endTurn' }, 1)).toMatchObject({ result: 'rule', reasonCode: 'game_over' });

    b.clock.advance(7 * DAY - 2 * MIN);
    b.s.runAbandonmentJob();
    expect(meta(b, g).roomCode).not.toBeNull();
    b.clock.advance(2 * MIN);
    expect(meta(b, g)).toMatchObject({ lifecycle: 'finished', roomCode: null });
  });
});

describe('restart keeps timers (V28)', () => {
  it('inactivity counts across a restart', async () => {
    const b = await boot();
    const g = startGame(b);
    b.clock.advance(20 * MIN);
    await b.s.close();
    const b2 = await boot(new FakeClock(T0 + 25 * MIN), b.dbPath);
    b2.clock.advance(5 * MIN - 1000);
    b2.s.runAbandonmentJob();
    expect(meta(b2, g).lifecycle).toBe('active');
    b2.clock.advance(1000);
    b2.s.runAbandonmentJob();
    expect(meta(b2, g)).toMatchObject({ lifecycle: 'abandoned', abandonReason: 'inactivity' });
  });

  it('after boot nobody is connected: all_disconnected_since = boot time when unset, the persisted value otherwise', async () => {
    const b = await boot();
    const fresh = startGame(b);
    const kept = startGame(b);
    b.store.updateMeta(kept.gameId, { allDisconnectedSince: T0 + MIN });
    await b.s.close();
    const b2 = await boot(new FakeClock(T0 + 5 * MIN), b.dbPath);
    expect(meta(b2, fresh).allDisconnectedSince).toBe(T0 + 5 * MIN);
    expect(meta(b2, kept).allDisconnectedSince).toBe(T0 + MIN);
    b2.clock.advance(6 * MIN);
    b2.s.runAbandonmentJob();
    expect(meta(b2, kept)).toMatchObject({ lifecycle: 'abandoned', abandonReason: 'all_disconnected' });
    expect(meta(b2, fresh).lifecycle).toBe('active');
    b2.clock.advance(4 * MIN);
    b2.s.runAbandonmentJob();
    expect(meta(b2, fresh)).toMatchObject({ lifecycle: 'abandoned', abandonReason: 'all_disconnected' });
  });
});

describe('job metrics and active play (design §9.2)', () => {
  it('records runs{ok}, duration and last_success, and /healthz reports the job age', async () => {
    const b = await boot();
    b.clock.advance(60_000);
    expect(points(b, 'catan.job.abandonment.runs')).toEqual([{ attributes: { result: 'ok' }, value: 1 }]);
    expect(points(b, 'catan.job.abandonment.last_success')).toEqual([{ attributes: {}, value: Math.floor((T0 + 60_000) / 1000) }]);
    expect(points(b, 'catan.job.abandonment.duration')).toHaveLength(1);
    b.clock.advance(30_000);
    const res = await fetch(`http://127.0.0.1:${b.s.port}/healthz`);
    expect(((await res.json()) as Record<string, unknown>)['abandonment_job_last_success_s_ago']).toBe(30);
    expect(b.s.telemetry.spans().filter((s) => s.name === 'catan.job.abandonment')).toHaveLength(1);
  });

  it('accumulates active_play_ms on job ticks and stops counting while abandoned', async () => {
    const b = await boot();
    const g = startGame(b);
    b.clock.advance(10 * MIN);
    expect(meta(b, g).activePlayMs).toBe(10 * MIN);
    b.clock.advance(20 * MIN);
    expect(meta(b, g)).toMatchObject({ lifecycle: 'abandoned', activePlayMs: 30 * MIN });
    b.clock.advance(HOUR);
    expect(meta(b, g).activePlayMs).toBe(30 * MIN);
    const sum = points(b, 'catan.games.active_play_seconds').reduce((n, p) => n + (p.value as number), 0);
    expect(sum).toBe(30 * 60);
  });

  it('no job tick runs once drain has begun (D22)', async () => {
    const b = await boot();
    const g = startGame(b);
    b.clock.advance(60_000);
    expect(points(b, 'catan.job.abandonment.runs')).toEqual([{ attributes: { result: 'ok' }, value: 1 }]);
    const drained = b.s.drain();
    b.clock.advance(31 * MIN);
    await drained;
    // A tick 31 min after the last action would abandon the game; it is still active, so none ran.
    expect(meta(b, g).lifecycle).toBe('active');
    expect(b.clock.pendingTimers()).toBe(0);
  });

  it('stops the job timer on close', async () => {
    const clock = new FakeClock(T0);
    const b = await boot(clock);
    expect(clock.pendingTimers()).toBeGreaterThan(0);
    await b.s.close();
    expect(clock.pendingTimers()).toBe(0);
  });
});
