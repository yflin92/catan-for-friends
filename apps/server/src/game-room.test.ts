import { mkdtempSync, rmSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_GAME_CONFIG,
  ENGINE_VERSION,
  canonicalJson,
  createGame,
  serializeState,
  stateHash,
  view,
  type Action,
  type GameState,
  type Seat,
} from '@hexlands/engine';
import { buildState, deepFreeze, forceDice } from '@hexlands/engine/testing';
import { CloseCode, MAX_INBOUND_FRAME_BYTES } from '@hexlands/protocol';
import { isKnownGameEvent } from '@hexlands/protocol';
import { serverMsgSchemaStrict } from '@hexlands/protocol/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { handleAction } from './action-handler';
import { hashSeatToken, mintRoomCode, mintSeatToken } from './codes';
import { ACTION_ID_CACHE_SIZE, GameRoom, SNAPSHOT_EVERY, payloadHashOf } from './game-room';
import type { LifecycleService } from './lifecycle';
import type { RoomManager } from './room-manager';
import { startServer, type RunningServer, type ServerContext, type ServerOptions } from './server';
import { openGameStore, type SqliteGameStore } from './store/sqlite';
import { createTelemetry } from './telemetry';
import { ArmableFaults, FakeClock } from './testing';
import type { Connection } from './ws-gateway';

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

// ── fixtures ─────────────────────────────────────────────────────────────────

interface Booted {
  s: RunningServer;
  store: SqliteGameStore;
  faults: ArmableFaults;
  dbPath: string;
}

async function boot(opts: Partial<ServerOptions> & { dbPath?: string } = {}): Promise<Booted> {
  let dbPath = opts.dbPath;
  if (dbPath === undefined) {
    const dir = mkdtempSync(path.join(tmpdir(), 'hexlands-room-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    dbPath = path.join(dir, 'db');
  }
  const faults = new ArmableFaults();
  const s = await startServer({ port: 0, telemetry: 'memory', faults, buildVersion: 'v-room', ...opts, dbPath });
  const store = openGameStore(dbPath);
  cleanups.push(() => s.close(), () => store.close());
  return { s, store, faults, dbPath };
}

interface StartedGame {
  gameId: string;
  roomCode: string;
  tokens: string[];
  state: GameState;
}

/** Writes a started game straight into the store: seats, the seq-0 snapshot and lifecycle 'active'. */
function startGame(store: SqliteGameStore, state: GameState = created()): StartedGame {
  const gameId = randomUUID();
  const roomCode = mintRoomCode(6);
  const now = Date.now();
  store.createRoom({ id: gameId, roomCode, config: { ...DEFAULT_GAME_CONFIG, rules: state.config }, hostSeat: 0, createdAt: now });
  const tokens = Array.from({ length: state.playerCount }, () => mintSeatToken());
  tokens.forEach((t, seat) => store.upsertSeat(gameId, seat as Seat, `P${seat}`, hashSeatToken(t), now));
  store.writeSnapshot(gameId, 0, serializeState(state), stateHash(state), ENGINE_VERSION, now);
  store.updateMeta(gameId, { lifecycle: 'active', seed: 'test-seed', engineVersion: ENGINE_VERSION, startedAt: now });
  return { gameId, roomCode, tokens, state };
}

function created(playerCount: 3 | 4 = 3, seed = 'room-seed'): GameState {
  const r = createGame({ config: DEFAULT_GAME_CONFIG.rules, playerCount, seed });
  if (!r.ok) throw new Error('createGame failed');
  return r.state;
}

type Frame = Record<string, unknown> & { t: string };

/** A test client that records every frame and can wait for the outcome of a given actionId. */
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

  opened(): Promise<void> {
    return new Promise((r, j) => this.ws.once('open', () => r()).once('error', j));
  }

  sendRaw(data: string): void {
    this.ws.send(data);
  }

  send(msg: Record<string, unknown>): void {
    this.sendRaw(JSON.stringify(msg));
  }

  async hello(roomCode: string, seatToken?: string): Promise<Frame> {
    const actionId = randomUUID();
    this.send({ t: 'hello', v: 1, actionId, roomCode, ...(seatToken !== undefined ? { seatToken } : {}) });
    await this.outcome(actionId);
    return this.frames.find((f) => f.t === 'welcome')!;
  }

  async act(action: Action | Record<string, unknown>, actionId: string = randomUUID(), baseSeq = 0): Promise<Frame> {
    this.send({ t: 'action', actionId, baseSeq, action });
    return this.outcome(actionId);
  }

  outcome(actionId: string | null): Promise<Frame> {
    return this.until(() => this.frames.find((f) => f.t === 'outcome' && f['actionId'] === actionId));
  }

  states(): Frame[] {
    return this.frames.filter((f) => f.t === 'state');
  }

  lastView(): GameViewish {
    const states = this.states();
    const last = states.at(-1) ?? this.frames.find((f) => f.t === 'welcome');
    return last!['view'] as GameViewish;
  }

  until<T>(probe: () => T | undefined, ms = 3000): Promise<T> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const v = probe();
        if (v !== undefined) {
          clearTimeout(timer);
          this.waiters = this.waiters.filter((w) => w !== check);
          resolve(v);
          return true;
        }
        return false;
      };
      const timer = setTimeout(() => reject(new Error('timed out waiting for a frame')), ms);
      if (!check()) this.waiters.push(check);
    });
  }

  private wake(): void {
    for (const w of [...this.waiters]) w();
  }
}

type GameViewish = { legal: { placeSettlement: string[]; placeRoad: string[]; rollDice: boolean; endTurn: boolean }; you: number };

async function seated(port: number, game: StartedGame): Promise<Client[]> {
  const clients: Client[] = [];
  for (const token of game.tokens) {
    const c = new Client(port);
    await c.opened();
    await c.hello(game.roomCode, token);
    clients.push(c);
  }
  return clients;
}

/** Waits until every client holds the state at `seq`. */
async function settle(clients: Client[], seq: number): Promise<void> {
  for (const c of clients) await c.until(() => c.states().find((f) => f['seq'] === seq));
}

/** Plays the first legal action of whichever seat has one; returns its outcome, or null when nobody can act. */
async function playOne(clients: Client[]): Promise<Frame | null> {
  const actor = clients.find((c) => firstLegal(c.lastView()) !== null);
  if (!actor) return null;
  const out = await actor.act(firstLegal(actor.lastView())!);
  if (out['result'] === 'ok') await settle(clients, out['seq'] as number);
  return out;
}

/** The first action legal for the active seat: setup placements, roll, then end turn. */
function firstLegal(v: GameViewish): Action | null {
  if (v.legal.placeSettlement.length > 0) return { type: 'placeSettlement', vertex: v.legal.placeSettlement[0] as never };
  if (v.legal.placeRoad.length > 0) return { type: 'placeRoad', edge: v.legal.placeRoad[0] as never };
  if (v.legal.rollDice) return { type: 'rollDice' };
  if (v.legal.endTurn) return { type: 'endTurn' };
  return null;
}

const outcomeOf = (f: Frame) => ({ result: f['result'], reasonCode: f['reasonCode'], seq: f['seq'] });

// ── WebSocket contract tests ─────────────────────────────────────────────────

describe('GameRoom commit path over WebSocket (design §5.2, AC20, AC21)', () => {
  it('a seated hello in a started game gets its view and the live seq', async () => {
    const { s, store } = await boot();
    const game = startGame(store);
    const [c0] = await seated(s.port, game);
    const welcome = c0!.frames.find((f) => f.t === 'welcome')!;
    expect(welcome['seq']).toBe(0);
    expect((welcome['view'] as { you: number }).you).toBe(0);
    const spectator = new Client(s.port);
    await spectator.opened();
    expect((await spectator.hello(game.roomCode))['view']).toBeNull();
  });

  it('commits a legal action: state{seq} to every seated socket BEFORE the sender’s outcome {ok, seq}', async () => {
    const { s, store } = await boot();
    const game = startGame(store);
    const clients = await seated(s.port, game);
    const action = firstLegal(clients[0]!.lastView())!;
    const out = await clients[0]!.act(action);
    expect(outcomeOf(out)).toEqual({ result: 'ok', reasonCode: undefined, seq: 1 });
    const senderFrames = clients[0]!.frames.map((f) => f.t);
    expect(senderFrames.lastIndexOf('state')).toBeLessThan(senderFrames.lastIndexOf('outcome'));
    for (const [seat, c] of clients.entries()) {
      const st = await c.until(() => c.states().find((f) => f['seq'] === 1));
      expect((st['view'] as { you: number }).you).toBe(seat);
    }
    expect(s.stateHash(game.roomCode)?.seq).toBe(1);
  });

  it('a rejection goes to the sender only: no broadcast, seq unchanged', async () => {
    const { s, store } = await boot();
    const game = startGame(store);
    const clients = await seated(s.port, game);
    const before = s.stateHash(game.roomCode);
    const out = await clients[1]!.act({ type: 'placeSettlement', vertex: 'v:0,0,N' });
    expect(outcomeOf(out)).toEqual({ result: 'turn', reasonCode: 'not_your_turn', seq: undefined });
    await new Promise((r) => setTimeout(r, 50));
    for (const c of clients) expect(c.states()).toEqual([]);
    expect(clients[0]!.frames.filter((f) => f.t === 'outcome').length).toBe(1); // only its own hello outcome
    expect(s.stateHash(game.roomCode)).toEqual(before);
  });

  it('a duplicate actionId with the same payload replays the original outcome; a different payload → action_id_reused', async () => {
    const { s, store } = await boot();
    const game = startGame(store);
    const [c0] = await seated(s.port, game);
    const action = firstLegal(c0!.lastView())!;
    const id = randomUUID();
    expect(outcomeOf(await c0!.act(action, id))).toMatchObject({ result: 'ok', seq: 1 });
    c0!.frames.length = 0;
    expect(outcomeOf(await c0!.act(action, id))).toMatchObject({ result: 'ok', seq: 1 });
    expect(c0!.states()).toEqual([]);
    c0!.frames.length = 0;
    expect(outcomeOf(await c0!.act({ type: 'rollDice' }, id))).toEqual({ result: 'rule', reasonCode: 'action_id_reused', seq: undefined });
    expect(s.stateHash(game.roomCode)?.seq).toBe(1);
  });

  it('a duplicate of a rejected actionId replays the rejection while cached', async () => {
    const { s, store } = await boot();
    const game = startGame(store);
    const [, c1] = await seated(s.port, game);
    const id = randomUUID();
    const action: Action = { type: 'placeSettlement', vertex: 'v:0,0,N' };
    expect(outcomeOf(await c1!.act(action, id))).toMatchObject({ reasonCode: 'not_your_turn' });
    c1!.frames.length = 0;
    expect(outcomeOf(await c1!.act(action, id))).toMatchObject({ reasonCode: 'not_your_turn' });
    c1!.frames.length = 0;
    expect(outcomeOf(await c1!.act({ type: 'rollDice' }, id))).toMatchObject({ reasonCode: 'action_id_reused' });
  });

  it('committed actionIds stay idempotent across a restart (store lookup)', async () => {
    const first = await boot();
    const game = startGame(first.store);
    const [c0] = await seated(first.s.port, game);
    const action = firstLegal(c0!.lastView())!;
    const id = randomUUID();
    expect(outcomeOf(await c0!.act(action, id))).toMatchObject({ result: 'ok', seq: 1 });
    await first.s.close();

    const second = await boot({ dbPath: first.dbPath });
    const [again] = await seated(second.s.port, game);
    expect(outcomeOf(await again!.act(action, id))).toMatchObject({ result: 'ok', seq: 1 });
    again!.frames.length = 0;
    expect(outcomeOf(await again!.act({ type: 'rollDice' }, id))).toMatchObject({ reasonCode: 'action_id_reused' });
    expect(second.s.stateHash(game.roomCode)?.seq).toBe(1);
  });

  it('seq is gap-free: commits advance it by exactly 1, rejections never do', async () => {
    const { s, store } = await boot();
    const game = startGame(store);
    const clients = await seated(s.port, game);
    for (let i = 0; i < 6; i++) {
      // The seat whose view offers an action is the active one; the same action from the next seat is rejected first.
      const actor = clients.find((c) => firstLegal(c.lastView()) !== null)!;
      const a = firstLegal(actor.lastView())!;
      const other = clients[(actor.lastView().you + 1) % 3]!;
      expect(outcomeOf(await other.act(a))).toMatchObject({ reasonCode: 'not_your_turn' });
      expect(outcomeOf(await actor.act(a))).toMatchObject({ result: 'ok', seq: i + 1 });
      await settle(clients, i + 1);
    }
    const events = store.loadGame(game.gameId)!.events.map((e) => e.seq);
    expect(events).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('a persist failure (appendEvent never runs) → error/internal_error, state NOT swapped, nothing broadcast; a resend commits', async () => {
    const { s, store, faults } = await boot();
    const game = startGame(store);
    const clients = await seated(s.port, game);
    faults.arm('beforePersist', 'throw', { gameId: game.gameId });
    const action = firstLegal(clients[0]!.lastView())!;
    const id = randomUUID();
    expect(outcomeOf(await clients[0]!.act(action, id))).toEqual({ result: 'error', reasonCode: 'internal_error', seq: undefined });
    expect(s.stateHash(game.roomCode)?.seq).toBe(0);
    expect(store.loadGame(game.gameId)!.events).toEqual([]);
    for (const c of clients) expect(c.states()).toEqual([]);
    const errors = s.telemetry.metrics()['catan.errors']?.points ?? [];
    expect(errors).toContainEqual(expect.objectContaining({ value: 1, attributes: { component: 'persist' } }));
    expect(s.telemetry.logs().some((l) => String(l.body).includes('action.error'))).toBe(true);
    clients[0]!.frames.length = 0;
    expect(outcomeOf(await clients[0]!.act(action, id))).toMatchObject({ result: 'ok', seq: 1 });
  });

  it('a fault after the commit (ack lost) → internal_error to the sender, but the command stands; a resend gets ok + the original seq', async () => {
    const { s, store, faults } = await boot();
    const game = startGame(store);
    const clients = await seated(s.port, game);
    faults.arm('afterPersistBeforeAck', 'throw', { gameId: game.gameId });
    const action = firstLegal(clients[0]!.lastView())!;
    const id = randomUUID();
    expect(outcomeOf(await clients[0]!.act(action, id))).toMatchObject({ result: 'error', reasonCode: 'internal_error' });
    expect(store.loadGame(game.gameId)!.events.map((e) => e.seq)).toEqual([1]);
    expect(s.stateHash(game.roomCode)?.seq).toBe(1);
    await clients[1]!.until(() => clients[1]!.states().find((f) => f['seq'] === 1));
    clients[0]!.frames.length = 0;
    expect(outcomeOf(await clients[0]!.act(action, id))).toMatchObject({ result: 'ok', seq: 1 });
    expect(clients[0]!.states()).toEqual([]);
  });

  it('D14: a non-integer number in an action → rule/malformed_action end to end, nothing committed', async () => {
    const { s, store } = await boot();
    const game = startGame(store);
    const [c0] = await seated(s.port, game);
    const out = await c0!.act({ type: 'maritimeTrade', give: 'ore', receive: 'wool', count: 1.5 });
    expect(outcomeOf(out)).toEqual({ result: 'rule', reasonCode: 'malformed_action', seq: undefined });
    expect(s.stateHash(game.roomCode)?.seq).toBe(0);
  });

  it('bounds input depth before reduce: deep nesting is malformed or closed 1009, never internal_error', async () => {
    const { s, store } = await boot();
    const game = startGame(store);
    const [c0] = await seated(s.port, game);
    // Fits the 16 KiB frame cap: 2,500 levels of nesting inside an action field fail the strict schema.
    const deep = '{"a":'.repeat(2500) + '1' + '}'.repeat(2500);
    const id = randomUUID();
    c0!.sendRaw(`{"t":"action","actionId":"${id}","baseSeq":0,"action":{"type":"discard","cards":${deep}}}`);
    expect(outcomeOf(await c0!.outcome(id))).toEqual({ result: 'rule', reasonCode: 'malformed_action', seq: undefined });
    // Nested arrays as the whole frame: unparseable as a message, malformed with no actionId.
    c0!.sendRaw('['.repeat(5000) + ']'.repeat(5000));
    expect(outcomeOf(await c0!.outcome(null))).toMatchObject({ result: 'rule', reasonCode: 'malformed_action' });
    expect(c0!.closeCode).toBeNull();
    // Over the frame cap: the socket is closed with 1009.
    c0!.sendRaw('['.repeat(MAX_INBOUND_FRAME_BYTES) + ']'.repeat(MAX_INBOUND_FRAME_BYTES));
    await c0!.until(() => (c0!.closeCode === null ? undefined : true));
    expect(c0!.closeCode).toBe(CloseCode.TOO_BIG);
    // Zero-initialised at start: every component stays at 0.
    expect((s.telemetry.metrics()['catan.errors']?.points ?? []).every((p) => p.value === 0)).toBe(true);
  });

  it('emits exactly one catan.action span per action with the timing attributes (design §9.3)', async () => {
    const { s, store } = await boot();
    const game = startGame(store);
    const [c0] = await seated(s.port, game);
    await c0!.act(firstLegal(c0!.lastView())!, randomUUID(), 0);
    await c0!.act({ type: 'rollDice' });
    const spans = s.telemetry.spans().filter((x) => x.name === 'catan.action');
    expect(spans).toHaveLength(2);
    const [ok, rejected] = spans;
    expect(ok!.attributes).toMatchObject({
      'catan.action.type': 'placeSettlement',
      'catan.action.group': 'setup',
      'catan.result': 'ok',
      'catan.seq': 1,
      'catan.seat': 0,
      'catan.game.id': game.gameId,
      'catan.base_seq_lag': 0,
    });
    for (const k of ['catan.reduce_ms', 'catan.persist_ms', 'catan.broadcast_ms']) expect(typeof ok!.attributes[k]).toBe('number');
    expect(rejected!.attributes).toMatchObject({ 'catan.result': 'turn', 'catan.reason_code': 'wrong_phase' });
    expect(s.telemetry.spans().every((x) => x.parentSpanContext === undefined || x.name !== 'catan.action')).toBe(true);
  });

  it('D6 drift: every real welcome and state frame parses with serverMsgSchemaStrict, and every log event kind is known', async () => {
    const { s, store } = await boot();
    // Dice scripted to avoid 7s, so the seeded game plays through setup and the first turns.
    const state = forceDice(created(3, 'drift-seed'), Array.from({ length: 20 }, () => [3, 5] as const));
    const game = startGame(store, state);
    const clients = await seated(s.port, game);
    let moves = 0;
    while (moves < 24) {
      const out = await playOne(clients);
      if (!out) break;
      expect(outcomeOf(out)).toMatchObject({ result: 'ok' });
      moves++;
    }
    expect(moves).toBe(24); // 12 setup placements (3 players) + 6 turns of roll + endTurn
    for (const c of clients) {
      for (const f of c.frames.filter((x) => x.t === 'welcome' || x.t === 'state')) {
        const parsed = serverMsgSchemaStrict.safeParse(f);
        expect(parsed.success, JSON.stringify(parsed.error?.issues?.slice(0, 2))).toBe(true);
        const log = (f['view'] as { log: { event: Parameters<typeof isKnownGameEvent>[0] }[] }).log;
        for (const e of log) expect(isKnownGameEvent(e.event), e.event.kind).toBe(true);
      }
    }
  });
});

describe('D19: actionIds bind their actor (design §4, §5.2)', () => {
  /** No outcome among `frames` is ok or carries a seq. */
  const noLeak = (frames: Frame[]) =>
    frames.filter((f) => f.t === 'outcome').every((f) => f['result'] !== 'ok' && f['seq'] === undefined);

  it('payload_hash = SHA-256(canonicalJson({by, action})): the same action hashes differently per seat', () => {
    const action: Action = { type: 'rollDice' };
    const expected = createHash('sha256').update(canonicalJson({ by: 1, action }), 'utf8').digest('hex');
    expect(payloadHashOf({ by: 1, action })).toBe(expected);
    expect(payloadHashOf({ by: 0, action })).not.toBe(expected);
  });

  it('cache path: seat B resending seat A’s committed actionId → action_id_reused with no outcome or seq of A’s; A’s resend replays', async () => {
    const { s, store } = await boot();
    const game = startGame(store);
    const [a, b] = await seated(s.port, game);
    const action = firstLegal(a!.lastView())!;
    const id = randomUUID();
    expect(outcomeOf(await a!.act(action, id))).toEqual({ result: 'ok', reasonCode: undefined, seq: 1 });
    await settle([a!, b!], 1);
    a!.frames.length = 0;
    b!.frames.length = 0;

    expect(outcomeOf(await b!.act(action, id))).toEqual({ result: 'rule', reasonCode: 'action_id_reused', seq: undefined });
    expect(noLeak(b!.frames)).toBe(true);
    expect(b!.states()).toEqual([]);
    expect(a!.frames).toEqual([]);

    expect(outcomeOf(await a!.act(action, id))).toEqual({ result: 'ok', reasonCode: undefined, seq: 1 });
    expect(a!.states()).toEqual([]);
    expect(s.stateHash(game.roomCode)?.seq).toBe(1);
    const events = store.loadGame(game.gameId)!.events;
    expect(events.map((e) => ({ seq: e.seq, actionId: e.actionId, by: e.by, payloadHash: e.payloadHash }))).toEqual([
      { seq: 1, actionId: id, by: 0, payloadHash: payloadHashOf({ by: 0, action }) },
    ]);
  });

  it('store path after a restart: B → action_id_reused with no leak, then A → ok and the original seq', async () => {
    const first = await boot();
    const game = startGame(first.store);
    const [a0] = await seated(first.s.port, game);
    const action = firstLegal(a0!.lastView())!;
    const id = randomUUID();
    expect(outcomeOf(await a0!.act(action, id))).toMatchObject({ result: 'ok', seq: 1 });
    await first.s.close();

    const second = await boot({ dbPath: first.dbPath });
    const [a, b] = await seated(second.s.port, game);
    b!.frames.length = 0;
    expect(outcomeOf(await b!.act(action, id))).toEqual({ result: 'rule', reasonCode: 'action_id_reused', seq: undefined });
    expect(noLeak(b!.frames)).toBe(true);
    expect(outcomeOf(await a!.act(action, id))).toEqual({ result: 'ok', reasonCode: undefined, seq: 1 });
    expect(second.s.stateHash(game.roomCode)?.seq).toBe(1);
  });

  it('a cached rejection is replayed to its own seat only; another seat reusing the actionId → action_id_reused', async () => {
    const { s, store } = await boot();
    const game = startGame(store);
    const [, b, c] = await seated(s.port, game);
    const id = randomUUID();
    const action: Action = { type: 'placeSettlement', vertex: 'v:0,0,N' };
    expect(outcomeOf(await b!.act(action, id))).toMatchObject({ result: 'turn', reasonCode: 'not_your_turn' });
    expect(outcomeOf(await c!.act(action, id))).toEqual({ result: 'rule', reasonCode: 'action_id_reused', seq: undefined });
    expect(outcomeOf(await b!.act(action, id))).toMatchObject({ result: 'turn', reasonCode: 'not_your_turn' });
    expect(s.stateHash(game.roomCode)?.seq).toBe(0);
  });

  it('an unseated socket never reaches the seat cache: reusing a committed actionId → turn/not_your_turn, no seq', async () => {
    const { s, store } = await boot();
    const game = startGame(store);
    const [a] = await seated(s.port, game);
    const action = firstLegal(a!.lastView())!;
    const id = randomUUID();
    expect(outcomeOf(await a!.act(action, id))).toMatchObject({ result: 'ok', seq: 1 });
    const visitor = new Client(s.port);
    await visitor.opened();
    await visitor.hello(game.roomCode);
    visitor.frames.length = 0;
    expect(outcomeOf(await visitor.act(action, id))).toEqual({ result: 'turn', reasonCode: 'not_your_turn', seq: undefined });
    expect(noLeak(visitor.frames)).toBe(true);
  });
});

describe('RunningServer.stateHash(roomCode)', () => {
  it('reads the live room, else the store head without loading the game, else null', async () => {
    const first = await boot();
    const game = startGame(first.store);
    const [c0] = await seated(first.s.port, game);
    await c0!.act(firstLegal(c0!.lastView())!);
    const live = first.s.stateHash(game.roomCode)!;
    expect(live.seq).toBe(1);
    await first.s.close();

    // Corrupt the snapshot: loading the game would now fail, so a correct answer proves it was not loaded.
    const second = await boot({ dbPath: first.dbPath });
    second.store.writeSnapshot(game.gameId, 0, '{"broken":true}', 'x', ENGINE_VERSION, Date.now());
    expect(second.s.stateHash(game.roomCode)).toEqual(live);
    expect(second.s.stateHash(game.roomCode.toLowerCase())).toEqual(live);
    expect(second.s.stateHash('ZZZZZZ')).toBeNull();
  });

  it('returns the seq-0 snapshot hash for a started game with no events', async () => {
    const { s, store } = await boot();
    const game = startGame(store);
    expect(s.stateHash(game.roomCode)).toEqual({ seq: 0, stateHash: stateHash(game.state) });
  });
});

// ── GameRoom unit tests ──────────────────────────────────────────────────────

function unitCtx(store: SqliteGameStore = openGameStore(':memory:'), faults = new ArmableFaults()): ServerContext {
  return {
    store,
    faults,
    clock: new FakeClock(1_000),
    telemetry: createTelemetry({ mode: 'memory', environment: 'dev', serviceVersion: 'unit' }),
  } as unknown as ServerContext;
}

/** A gateway stand-in that records what each seat's connection is sent. */
function recordingGateway(seats: number) {
  const sent: string[][] = Array.from({ length: seats }, () => []);
  const conns = sent.map(
    (frames) =>
      ({
        send: (m: unknown) => frames.push(JSON.stringify(m)),
      }) as unknown as Connection,
  );
  return { sent, gateway: () => ({ connectionOf: (_g: string, seat: Seat) => conns[seat] ?? null }) as never };
}

describe('GameRoom (unit)', () => {
  it('writes a snapshot every SNAPSHOT_EVERY commits and restores to the same head', () => {
    const ctx = unitCtx();
    const state = forceDice(buildState({ phase: { name: 'preRoll' }, playerCount: 3 }), Array.from({ length: 30 }, () => [2, 3] as const));
    const g = startGame(ctx.store as SqliteGameStore, state);
    const { gateway } = recordingGateway(3);
    const room = new GameRoom({ ctx, gateway }, g.gameId, state, 0);
    const t = { reduceMs: 0, persistMs: 0, broadcastMs: 0 };
    while (room.seq < SNAPSHOT_EVERY + 1) {
      const active = room.state.turn.active;
      const action: Action = room.state.phase.name === 'preRoll' ? { type: 'rollDice' } : { type: 'endTurn' };
      const res = room.commit({ by: active, action }, randomUUID(), 'h', t);
      expect(res).toEqual({ result: 'ok', seq: expect.any(Number) });
    }
    const loaded = (ctx.store as SqliteGameStore).loadGame(g.gameId)!;
    expect(loaded.snapshot?.seq).toBe(SNAPSHOT_EVERY);
    expect(loaded.events.map((e) => e.seq)).toEqual([SNAPSHOT_EVERY + 1]);
    expect(GameRoom.restore({ ctx, gateway }, loaded).head()).toEqual(room.head());
  });

  it('restore refuses a log that does not replay to its stored hashes', () => {
    const ctx = unitCtx();
    const g = startGame(ctx.store as SqliteGameStore, buildState({ phase: { name: 'main' }, playerCount: 3 }));
    (ctx.store as SqliteGameStore).appendEvent({
      gameId: g.gameId, seq: 1, actionId: 'a', payloadHash: 'h', by: 0,
      command: { by: 0, action: { type: 'endTurn' } }, hashAfter: 'not-the-hash', at: 1,
    });
    expect(() => GameRoom.restore({ ctx, gateway: recordingGateway(3).gateway }, (ctx.store as SqliteGameStore).loadGame(g.gameId)!)).toThrow(
      /does not replay/,
    );
  });

  it('evicts the oldest cached outcome beyond ACTION_ID_CACHE_SIZE (rejections are then re-evaluated)', () => {
    const ctx = unitCtx();
    const state = buildState({ phase: { name: 'main' }, playerCount: 3 });
    const g = startGame(ctx.store as SqliteGameStore, state);
    const room = new GameRoom({ ctx, gateway: recordingGateway(3).gateway }, g.gameId, state, 0);
    const t = { reduceMs: 0, persistMs: 0, broadcastMs: 0 };
    const reject: Action = { type: 'rollDice' }; // wrong_phase in main
    room.submit(1, 'first', reject, payloadHashOf({ by: 1, action: reject }), t);
    for (let i = 0; i < ACTION_ID_CACHE_SIZE; i++) room.submit(1, `id-${i}`, reject, payloadHashOf({ by: 1, action: reject }), t);
    // 'first' was evicted, so a different payload under it is evaluated afresh instead of action_id_reused.
    const other: Action = { type: 'endTurn' };
    expect(room.submit(1, 'first', other, payloadHashOf({ by: 1, action: other }), t)).toEqual({ result: 'turn', reasonCode: 'not_your_turn' });
    expect(room.submit(1, 'id-5', other, payloadHashOf({ by: 1, action: other }), t)).toEqual({ result: 'rule', reasonCode: 'action_id_reused' });
  });

  it('views are read-only: a deep-frozen state goes through view() and the send path for every seat unchanged', () => {
    const ctx = unitCtx();
    const state = deepFreeze(JSON.parse(JSON.stringify(created(4))) as GameState);
    const before = stateHash(state);
    const g = startGame(ctx.store as SqliteGameStore, state);
    const { sent, gateway } = recordingGateway(4);
    const room = new GameRoom({ ctx, gateway }, g.gameId, state, 0);
    expect(() => room.broadcast()).not.toThrow();
    expect(stateHash(state)).toBe(before);
    sent.forEach((frames, seat) => {
      expect(frames).toHaveLength(1);
      const msg = JSON.parse(frames[0]!) as Frame;
      expect(serverMsgSchemaStrict.safeParse(msg).success).toBe(true);
      expect(msg['view']).toEqual(JSON.parse(JSON.stringify(view(state, seat as Seat))));
    });
  });
});

describe('handleAction routing (design §5.2)', () => {
  const msg = { t: 'action', actionId: randomUUID(), baseSeq: 0, action: { type: 'endTurn' } } as const;
  const conn = (binding: Connection['binding']) => ({ binding }) as Connection;
  // A lifecycle that knows no game, so routing falls through to the room manager stub.
  const lifecycle = { current: () => null, contact: () => null, finish: () => undefined } as unknown as LifecycleService;
  const deps = (rooms: Partial<RoomManager>) => ({ ctx: unitCtx(), rooms: { draining: false, ...rooms } as RoomManager, lifecycle });

  it('draining → error/server_draining before anything else', () => {
    expect(handleAction(deps({ draining: true }), conn(null), msg)).toEqual({ result: 'error', reasonCode: 'server_draining' });
  });

  it('unbound → auth/unknown_room; seatless → turn/not_your_turn; not started → wrong_phase; expired → game_expired', () => {
    expect(handleAction(deps({}), conn(null), msg)).toEqual({ result: 'auth', reasonCode: 'unknown_room' });
    expect(handleAction(deps({}), conn({ gameId: 'g', seat: null }), msg)).toEqual({ result: 'turn', reasonCode: 'not_your_turn' });
    expect(handleAction(deps({ room: () => 'not_started' }), conn({ gameId: 'g', seat: 0 }), msg)).toEqual({
      result: 'turn',
      reasonCode: 'wrong_phase',
    });
    expect(handleAction(deps({ room: () => 'expired' }), conn({ gameId: 'g', seat: 0 }), msg)).toEqual({
      result: 'rule',
      reasonCode: 'game_expired',
    });
  });
});
