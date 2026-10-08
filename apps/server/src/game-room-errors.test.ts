// Engine and handler faults on the commit path (design §5.2 item 6, §9.5): injected by mocking the engine's reduce, view
// and actionGroup in this file only. A fault is counted, logged as action.error with the ids needed to reproduce it,
// and answered with error/internal_error to the sender only.
import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as engine from '@hexlands/engine';
import { DEFAULT_GAME_CONFIG, ENGINE_VERSION, createGame, serializeState, stateHash, type Action, type GameState, type Seat } from '@hexlands/engine';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { hashSeatToken, mintRoomCode, mintSeatToken } from './codes';
import { startServer, type RunningServer } from './server';
import { openGameStore, type SqliteGameStore } from './store/sqlite';

const inject = vi.hoisted(() => ({
  reduce: null as null | ((state: unknown, cmd: unknown) => unknown),
  /** Seats whose view() throws. */
  viewThrows: null as null | ((seat: Seat) => boolean),
  actionGroup: null as null | (() => never),
}));

vi.mock('@hexlands/engine', async (importOriginal) => {
  const real = await importOriginal<typeof engine>();
  return {
    ...real,
    reduce: (state: GameState, cmd: engine.Command) => (inject.reduce ? inject.reduce(state, cmd) : real.reduce(state, cmd)),
    view: (state: GameState, seat: Seat) => {
      if (inject.viewThrows?.(seat)) throw new Error('view bug');
      return real.view(state, seat);
    },
    actionGroup: (...args: Parameters<typeof real.actionGroup>) => (inject.actionGroup ? inject.actionGroup() : real.actionGroup(...args)),
  };
});

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  inject.reduce = inject.viewThrows = inject.actionGroup = null;
  for (const c of cleanups.splice(0).reverse()) await c();
});

interface Started {
  s: RunningServer;
  store: SqliteGameStore;
  gameId: string;
  roomCode: string;
  tokens: string[];
  state: GameState;
}

/** A server with a started game (3 seats by default) written straight into its store. */
async function started(playerCount: 3 | 4 = 3): Promise<Started> {
  const dir = mkdtempSync(path.join(tmpdir(), 'hexlands-faults-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'db');
  const s = await startServer({ port: 0, dbPath, telemetry: 'memory', buildVersion: 'v-faults' });
  const store = openGameStore(dbPath);
  cleanups.push(() => s.close(), () => store.close());
  const r = createGame({ config: DEFAULT_GAME_CONFIG.rules, playerCount, seed: 'faults-seed' });
  if (!r.ok) throw new Error('createGame failed');
  const state = r.state;
  const gameId = randomUUID();
  const roomCode = mintRoomCode(6);
  const now = Date.now();
  store.createRoom({ id: gameId, roomCode, config: { ...DEFAULT_GAME_CONFIG, rules: state.config }, hostSeat: 0, createdAt: now });
  const tokens = Array.from({ length: playerCount }, () => mintSeatToken());
  tokens.forEach((t, seat) => store.upsertSeat(gameId, seat as Seat, `P${seat}`, hashSeatToken(t), now));
  store.writeSnapshot(gameId, 0, serializeState(state), stateHash(state), ENGINE_VERSION, now);
  store.updateMeta(gameId, { lifecycle: 'active', seed: 'test-seed', engineVersion: ENGINE_VERSION, startedAt: now });
  return { s, store, gameId, roomCode, tokens, state };
}

type Frame = Record<string, unknown> & { t: string };

class Client {
  readonly frames: Frame[] = [];
  private readonly ws: WebSocket;
  private waiters: (() => void)[] = [];

  constructor(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    cleanups.push(() => this.ws.terminate());
    this.ws.on('message', (d) => {
      this.frames.push(JSON.parse(String(d)) as Frame);
      for (const w of [...this.waiters]) w();
    });
  }

  opened(): Promise<void> {
    return new Promise<void>((r, j) => this.ws.once('open', () => r()).once('error', j));
  }

  hello(roomCode: string, seatToken: string): Promise<Frame> {
    const actionId = randomUUID();
    this.ws.send(JSON.stringify({ t: 'hello', v: 1, actionId, roomCode, seatToken }));
    return this.outcome(actionId);
  }

  async seat(roomCode: string, seatToken: string): Promise<void> {
    await this.opened();
    await this.hello(roomCode, seatToken);
  }

  act(action: Action, actionId: string = randomUUID()): Promise<Frame> {
    this.ws.send(JSON.stringify({ t: 'action', actionId, baseSeq: 0, action }));
    return this.outcome(actionId);
  }

  states(): Frame[] {
    return this.frames.filter((f) => f.t === 'state');
  }

  outcome(actionId: string): Promise<Frame> {
    return this.until((x) => x.t === 'outcome' && x['actionId'] === actionId);
  }

  until(match: (f: Frame) => boolean): Promise<Frame> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const f = this.frames.find(match);
        if (f === undefined) return;
        clearTimeout(timer);
        this.waiters = this.waiters.filter((w) => w !== check);
        resolve(f);
      };
      const timer = setTimeout(() => reject(new Error('timed out waiting for a frame')), 3000);
      this.waiters.push(check);
      check();
    });
  }
}

async function seated(g: Started): Promise<Client[]> {
  const clients: Client[] = [];
  for (const token of g.tokens) {
    const c = new Client(g.s.port);
    await c.seat(g.roomCode, token);
    clients.push(c);
  }
  return clients;
}

/** Seat 0's first setup settlement. */
function firstAction(g: Started): Action {
  const legal = engine.legalActions(g.state, 0);
  return { type: 'placeSettlement', vertex: legal.placeSettlement[0]! };
}

const outcomeOf = (f: Frame) => ({ result: f['result'], reasonCode: f['reasonCode'], seq: f['seq'] });

function errorCount(s: RunningServer, component: string): number {
  const points = s.telemetry.metrics()['catan.errors']?.points ?? [];
  return points.filter((p) => p.attributes['component'] === component).reduce((n, p) => n + (p.value ?? 0), 0);
}

function errorLogs(s: RunningServer): Record<string, unknown>[] {
  return s.telemetry
    .logs()
    .map((l) => JSON.parse(String(l.body)) as Record<string, unknown>)
    .filter((b) => b['event'] === 'action.error');
}

function expectNoSecrets(s: RunningServer, g: Started): void {
  const all = s.telemetry.logs().map((l) => String(l.body)).join('\n');
  for (const secret of [g.roomCode, ...g.tokens]) expect(all).not.toContain(secret);
}

describe('engine faults on the commit path (design §5.2 item 6)', () => {
  it('reduce throwing → internal_error to the sender only; state not swapped, seq unchanged, nothing broadcast or persisted', async () => {
    const g = await started();
    const clients = await seated(g);
    inject.reduce = () => {
      throw new Error('handler bug');
    };
    const id = randomUUID();
    const out = await clients[0]!.act(firstAction(g), id);
    expect(outcomeOf(out)).toEqual({ result: 'error', reasonCode: 'internal_error', seq: undefined });
    expect(g.s.stateHash(g.roomCode)).toEqual({ seq: 0, stateHash: stateHash(g.state) });
    expect(g.store.loadGame(g.gameId)!.events).toEqual([]);
    for (const c of clients) expect(c.states()).toEqual([]);
    for (const c of clients.slice(1)) expect(c.frames.some((f) => f.t === 'outcome' && f['actionId'] === id)).toBe(false);

    expect(errorCount(g.s, 'engine')).toBe(1);
    const [log] = errorLogs(g.s);
    expect(log).toMatchObject({ severity_text: 'ERROR', component: 'engine', game_id: g.gameId, seq: 0, state_hash: stateHash(g.state) });
    const span = g.s.telemetry.spans().find((sp) => sp.name === 'catan.action')!;
    expect(log!['trace_id']).toBe(span.spanContext().traceId);
    expectNoSecrets(g.s, g);

    // The fault is not cached: a resend is evaluated again and commits.
    inject.reduce = null;
    clients[0]!.frames.length = 0;
    expect(outcomeOf(await clients[0]!.act(firstAction(g), id))).toMatchObject({ result: 'ok', seq: 1 });
  });

  it('reduce returning internal_error (a handler throw caught by the engine) is counted and logged the same way', async () => {
    const g = await started();
    const clients = await seated(g);
    inject.reduce = () => ({ ok: false, reason: 'internal_error' });
    expect(outcomeOf(await clients[0]!.act(firstAction(g)))).toEqual({ result: 'error', reasonCode: 'internal_error', seq: undefined });
    expect(g.s.stateHash(g.roomCode)?.seq).toBe(0);
    for (const c of clients) expect(c.states()).toEqual([]);
    expect(errorCount(g.s, 'engine')).toBe(1);
    expect(errorLogs(g.s)).toEqual([expect.objectContaining({ component: 'engine', game_id: g.gameId, seq: 0, trace_id: expect.any(String) })]);
  });

  it('a next state that cannot be hashed (a non-integer) is an engine fault caught before the commit', async () => {
    const g = await started();
    const clients = await seated(g);
    inject.reduce = (state) => ({ ok: true, state: { ...(state as GameState), nextTradeId: 0.5 }, events: [] });
    expect(outcomeOf(await clients[0]!.act(firstAction(g)))).toEqual({ result: 'error', reasonCode: 'internal_error', seq: undefined });
    expect(g.s.stateHash(g.roomCode)).toEqual({ seq: 0, stateHash: stateHash(g.state) });
    expect(g.store.loadGame(g.gameId)!.events).toEqual([]);
    for (const c of clients) expect(c.states()).toEqual([]);
    expect(errorCount(g.s, 'engine')).toBe(1);
    expect(errorLogs(g.s)).toEqual([expect.objectContaining({ component: 'engine', seq: 0 })]);
  });

  it('view throwing during the broadcast: the command stands (like a lost ack), the sender gets internal_error, a resend gets ok + seq', async () => {
    const g = await started();
    const clients = await seated(g);
    inject.viewThrows = () => true;
    const id = randomUUID();
    expect(outcomeOf(await clients[0]!.act(firstAction(g), id))).toEqual({ result: 'error', reasonCode: 'internal_error', seq: undefined });
    expect(g.store.loadGame(g.gameId)!.events.map((e) => e.seq)).toEqual([1]);
    expect(g.s.stateHash(g.roomCode)?.seq).toBe(1);
    expect(errorCount(g.s, 'engine')).toBe(1);
    expect(errorLogs(g.s)).toEqual([expect.objectContaining({ component: 'engine', game_id: g.gameId, seq: 1 })]);
    inject.viewThrows = null;
    clients[0]!.frames.length = 0;
    expect(outcomeOf(await clients[0]!.act(firstAction(g), id))).toEqual({ result: 'ok', reasonCode: undefined, seq: 1 });
  });
});

describe('broadcast isolation (bug a626f1e9)', () => {
  it('one seat whose send throws does not stop the others; the fault is counted once', async () => {
    const g = await started(4);
    const clients = await seated(g);
    inject.viewThrows = (seat) => seat === 1;
    expect(outcomeOf(await clients[0]!.act(firstAction(g)))).toEqual({ result: 'error', reasonCode: 'internal_error', seq: undefined });
    for (const seat of [0, 2, 3]) await clients[seat]!.until((f) => f.t === 'state' && f['seq'] === 1);
    expect(clients[1]!.states()).toEqual([]);
    expect(errorCount(g.s, 'engine')).toBe(1);
    expect(errorLogs(g.s)).toEqual([expect.objectContaining({ component: 'engine', game_id: g.gameId, seq: 1 })]);
  });
});

describe('gateway handlerError', () => {
  it('a throw escaping the action handler → internal_error, catan.errors{component=ws}, action.error with the game head', async () => {
    const g = await started();
    const clients = await seated(g);
    // actionGroup runs while annotating the span, after the room has committed the action.
    inject.actionGroup = () => {
      throw new TypeError('annotate bug');
    };
    expect(outcomeOf(await clients[0]!.act(firstAction(g)))).toEqual({ result: 'error', reasonCode: 'internal_error', seq: undefined });
    expect(errorCount(g.s, 'ws')).toBe(1);
    const head = g.s.stateHash(g.roomCode)!;
    expect(errorLogs(g.s)).toEqual([
      expect.objectContaining({ component: 'ws', kind: 'action', error: 'TypeError', game_id: g.gameId, seq: head.seq, state_hash: head.stateHash }),
    ]);
    expect(JSON.stringify(errorLogs(g.s))).not.toContain('annotate bug');
    expectNoSecrets(g.s, g);
  });
});

describe('restore failures (the bug b54c6154 repro)', () => {
  it('a stored log that does not replay → hello gets internal_error, counted once as persist, logged with game_id', async () => {
    const g = await started();
    g.store.appendEvent({
      gameId: g.gameId,
      seq: 1,
      actionId: 'a',
      payloadHash: 'h',
      by: 0,
      command: { by: 0, action: firstAction(g) },
      hashAfter: 'deadbeef',
      at: 1,
    });
    const c = new Client(g.s.port);
    await c.opened();
    expect(outcomeOf(await c.hello(g.roomCode, g.tokens[0]!))).toEqual({ result: 'error', reasonCode: 'internal_error', seq: undefined });
    expect(errorCount(g.s, 'persist')).toBe(1);
    expect(errorCount(g.s, 'ws')).toBe(0);
    expect(errorLogs(g.s)).toEqual([expect.objectContaining({ severity_text: 'ERROR', component: 'persist', game_id: g.gameId, seq: 1, error: 'Error' })]);
    expectNoSecrets(g.s, g);
  });
});
