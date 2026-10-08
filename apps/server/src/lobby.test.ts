import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createGame, deserializeState, stateHash, type GameState } from '@hexlands/engine';
import { serverMsgSchemaStrict } from '@hexlands/protocol/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { startServer, type RunningServer, type ServerOptions } from './server';
import { openGameStore, type SqliteGameStore } from './store/sqlite';
import { RecordingSecrets } from './testing';

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

let idCounter = 0;
const nextId = () => `00000000-0000-4000-8000-${String(++idCounter).padStart(12, '0')}`;

async function boot(opts: Partial<ServerOptions> = {}): Promise<{ s: RunningServer; store: SqliteGameStore; secrets: RecordingSecrets }> {
  const dir = mkdtempSync(path.join(tmpdir(), 'hexlands-lobby-'));
  const secrets = new RecordingSecrets();
  const s = await startServer({ port: 0, dbPath: path.join(dir, 'db'), telemetry: 'memory', secrets, buildVersion: 'v-l2', ...opts });
  const store = openGameStore(path.join(dir, 'db'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => s.close(), () => store.close());
  return { s, store, secrets };
}

function createRoom(port: number, displayName = 'Ana'): Promise<{ roomCode: string; seatToken: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path: '/api/rooms', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as { roomCode: string; seatToken: string }));
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify({ displayName }));
  });
}

type Msg = Record<string, unknown>;
class Client {
  readonly frames: Msg[] = [];
  closeCode: number | null = null;
  private waiters: { pred: (m: Msg) => boolean; resolve: (m: Msg) => void }[] = [];
  private constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as Msg;
      this.frames.push(m);
      const i = this.waiters.findIndex((w) => w.pred(m));
      if (i >= 0) this.waiters.splice(i, 1)[0]!.resolve(m);
    });
    ws.on('close', (code) => (this.closeCode = code));
  }
  static async open(port: number): Promise<Client> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    cleanups.push(() => ws.terminate());
    await new Promise((r, j) => ws.once('open', r).once('error', j));
    return new Client(ws);
  }
  /** Sends a command and resolves with its outcome. */
  async cmd(msg: Msg): Promise<Msg> {
    const actionId = nextId();
    const done = new Promise<Msg>((resolve) => this.waiters.push({ pred: (m) => m['t'] === 'outcome' && m['actionId'] === actionId, resolve }));
    this.ws.send(JSON.stringify({ ...msg, actionId }));
    return done;
  }
  hello(roomCode: string, seatToken?: string) {
    return this.cmd({ t: 'hello', v: 1, roomCode, ...(seatToken ? { seatToken } : {}) });
  }
  lobby(op: Msg) {
    return this.cmd({ t: 'lobby', op });
  }
  last(t: string): Msg | undefined {
    return [...this.frames].reverse().find((f) => f['t'] === t);
  }
  all(t: string): Msg[] {
    return this.frames.filter((f) => f['t'] === t);
  }
}

const settle = () => new Promise((r) => setTimeout(r, 50));

/** A room with the host connected, plus `extra` joined players (Bo, Cy, Di). */
async function lobbyWith(extra: number, opts: Partial<ServerOptions> = {}) {
  const env = await boot(opts);
  const { roomCode, seatToken } = await createRoom(env.s.port);
  const host = await Client.open(env.s.port);
  expect(await host.hello(roomCode, seatToken)).toMatchObject({ result: 'ok' });
  const players: Client[] = [];
  const tokens: string[] = [seatToken];
  for (const name of ['Bo', 'Cy', 'Di'].slice(0, extra)) {
    const p = await Client.open(env.s.port);
    await p.hello(roomCode);
    expect(await p.lobby({ kind: 'join', displayName: name })).toMatchObject({ result: 'ok' });
    tokens.push(p.last('seatToken')!['seatToken'] as string);
    players.push(p);
  }
  const gameId = env.store.findByRoomCode(roomCode)!.id;
  return { ...env, roomCode, host, players, tokens, gameId };
}

const seatsOf = (store: SqliteGameStore, gameId: string) =>
  store.loadGame(gameId)!.seats.map((s) => [s.seat, s.displayName] as const);

describe('join and rename (design §5.1(3), AC2)', () => {
  it('seats a joiner at the lowest free seat, gives only them the token, and broadcasts the room with yourSeat', async () => {
    const { s, roomCode, host, store, secrets, gameId } = await lobbyWith(0);
    const bo = await Client.open(s.port);
    await bo.hello(roomCode);
    expect(await bo.lobby({ kind: 'join', displayName: ' Bo ' })).toEqual(expect.objectContaining({ result: 'ok' }));
    const token = bo.last('seatToken');
    expect(token).toMatchObject({ t: 'seatToken', seat: 1, purpose: 'joined' });
    expect(host.all('seatToken')).toEqual([]);
    await settle();
    expect(host.last('room')).toMatchObject({ t: 'room', rev: 1, yourSeat: 0 });
    expect(bo.last('room')).toMatchObject({ t: 'room', rev: 1, yourSeat: 1 });
    expect((bo.last('room')!['room'] as { seats: unknown[] }).seats[1]).toEqual({ seat: 1, name: 'Bo', connected: true });
    for (const f of [...host.frames, ...bo.frames]) expect(serverMsgSchemaStrict.safeParse(f).success).toBe(true);
    expect(seatsOf(store, gameId)).toEqual([[0, 'Ana'], [1, 'Bo']]);
    expect(secrets.valuesOf('seatToken')).toContain(token!['seatToken']);
    const again = await Client.open(s.port);
    expect(await again.hello(roomCode, token!['seatToken'] as string)).toMatchObject({ result: 'ok' });
    expect(again.last('welcome')).toMatchObject({ seat: 1, isHost: false });
  });

  it.each([
    ['', 'invalid_name'],
    ['x'.repeat(21), 'invalid_name'],
    ['ANA', 'name_taken'],
  ])('rejects join %j with %s', async (name, code) => {
    const { s, roomCode } = await lobbyWith(0);
    const c = await Client.open(s.port);
    await c.hello(roomCode);
    expect(await c.lobby({ kind: 'join', displayName: name })).toMatchObject({ result: 'rule', reasonCode: code });
  });

  it('rejects a fifth player with room_full and joins after start with game_already_started', async () => {
    const { s, roomCode, host } = await lobbyWith(3);
    const fifth = await Client.open(s.port);
    await fifth.hello(roomCode);
    expect(await fifth.lobby({ kind: 'join', displayName: 'Ed' })).toMatchObject({ reasonCode: 'room_full' });
    const r = await lobbyWith(2);
    expect(await r.host.lobby({ kind: 'start' })).toMatchObject({ result: 'ok' });
    const late = await Client.open(r.s.port);
    await late.hello(r.roomCode);
    expect(await late.lobby({ kind: 'join', displayName: 'Ed' })).toMatchObject({ reasonCode: 'game_already_started' });
    void host;
  });

  it('renames a seated player, keeping names unique case-insensitively', async () => {
    const { players, store, gameId } = await lobbyWith(1);
    const bo = players[0]!;
    expect(await bo.lobby({ kind: 'rename', displayName: 'ana' })).toMatchObject({ reasonCode: 'name_taken' });
    expect(await bo.lobby({ kind: 'rename', displayName: 'Bob' })).toMatchObject({ result: 'ok' });
    expect(seatsOf(store, gameId)).toEqual([[0, 'Ana'], [1, 'Bob']]);
  });

  it('answers lobby ops from a socket without a room with auth/unknown_room', async () => {
    const { s } = await boot();
    const c = await Client.open(s.port);
    expect(await c.lobby({ kind: 'start' })).toMatchObject({ result: 'auth', reasonCode: 'unknown_room' });
  });
});

describe('host seat operations (design §5.1(4), D9)', () => {
  it('refuses host-only ops from others with auth/not_host', async () => {
    const { players } = await lobbyWith(1);
    for (const op of [{ kind: 'reorderSeats', order: [1, 0, 2, 3] }, { kind: 'shuffleSeats' }, { kind: 'removeSeat', seat: 0 }, { kind: 'setConfig' }, { kind: 'start' }]) {
      expect(await players[0]!.lobby(op)).toMatchObject({ result: 'auth', reasonCode: 'not_host' });
    }
  });

  it('reorders by permutation: occupants, tokens and the host move together; sockets learn their new index', async () => {
    const { s, roomCode, host, players, tokens, store, gameId } = await lobbyWith(2);
    expect(await host.lobby({ kind: 'reorderSeats', order: [2, 0, 1, 3] })).toMatchObject({ result: 'ok' });
    expect(seatsOf(store, gameId)).toEqual([[0, 'Cy'], [1, 'Ana'], [2, 'Bo']]);
    expect(store.loadGame(gameId)!.meta.hostSeat).toBe(1);
    await settle();
    expect(host.last('room')).toMatchObject({ yourSeat: 1 });
    expect((host.last('room')!['room'] as { hostSeat: number }).hostSeat).toBe(1);
    expect(players[0]!.last('room')).toMatchObject({ yourSeat: 2 });
    expect(players[1]!.last('room')).toMatchObject({ yourSeat: 0 });
    expect(host.ws.readyState).toBe(WebSocket.OPEN);
    const rejoin = await Client.open(s.port);
    await rejoin.hello(roomCode, tokens[1]);
    expect(rejoin.last('welcome')).toMatchObject({ seat: 2 });
    expect(await host.lobby({ kind: 'removeSeat', seat: 2 })).toMatchObject({ result: 'ok' });
  });

  it('applies D9 precedence: a non-permutation is malformed_action and the identity is a no-op', async () => {
    const { host, store, gameId } = await lobbyWith(1);
    const rev = store.loadGame(gameId)!.meta.roomRev;
    expect(await host.lobby({ kind: 'reorderSeats', order: [0, 1, 2, 3] })).toMatchObject({ result: 'ok' });
    expect(store.loadGame(gameId)!.meta.roomRev).toBe(rev);
    for (const order of [[0, 1, 2], [0, 0, 1, 2], [3, 2, 1, 0, 0]]) {
      expect(await host.lobby({ kind: 'reorderSeats', order })).toMatchObject({ result: 'rule', reasonCode: 'malformed_action' });
    }
  });

  it('shuffles with a permutation that keeps every token valid', async () => {
    const { s, roomCode, host, tokens, store, gameId } = await lobbyWith(3);
    expect(await host.lobby({ kind: 'shuffleSeats' })).toMatchObject({ result: 'ok' });
    expect(seatsOf(store, gameId).map(([, n]) => n).sort()).toEqual(['Ana', 'Bo', 'Cy', 'Di']);
    for (const t of tokens) {
      const c = await Client.open(s.port);
      expect(await c.hello(roomCode, t)).toMatchObject({ result: 'ok' });
    }
    expect(store.loadGame(gameId)!.seats.find((x) => x.displayName === 'Ana')!.seat).toBe(store.loadGame(gameId)!.meta.hostSeat);
  });

  it('removes a seat: the token is revoked, its socket closed 4401, the seat freed', async () => {
    const { s, roomCode, host, players, tokens, store, gameId } = await lobbyWith(2);
    expect(await host.lobby({ kind: 'removeSeat', seat: 1 })).toMatchObject({ result: 'ok' });
    await settle();
    expect(players[0]!.closeCode).toBe(4401);
    expect(seatsOf(store, gameId)).toEqual([[0, 'Ana'], [2, 'Cy']]);
    const c = await Client.open(s.port);
    expect(await c.hello(roomCode, tokens[1])).toMatchObject({ result: 'auth', reasonCode: 'seat_token_revoked' });
    expect(await host.lobby({ kind: 'removeSeat', seat: 0 })).toMatchObject({ reasonCode: 'malformed_action' });
    expect(await host.lobby({ kind: 'removeSeat', seat: 3 })).toMatchObject({ reasonCode: 'malformed_action' });
  });

  it('keeps a removed seat\'s token revoked across a server restart', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hexlands-lobby-restart-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const dbPath = path.join(dir, 'db');
    const first = await startServer({ port: 0, dbPath, telemetry: 'off' });
    const { roomCode, seatToken } = await createRoom(first.port);
    const host = await Client.open(first.port);
    await host.hello(roomCode, seatToken);
    const bo = await Client.open(first.port);
    await bo.hello(roomCode);
    await bo.lobby({ kind: 'join', displayName: 'Bo' });
    const boToken = bo.last('seatToken')!['seatToken'] as string;
    expect(await host.lobby({ kind: 'removeSeat', seat: 1 })).toMatchObject({ result: 'ok' });
    await first.close();
    const second = await startServer({ port: 0, dbPath, telemetry: 'off' });
    cleanups.push(() => second.close());
    const c = await Client.open(second.port);
    expect(await c.hello(roomCode, boToken)).toMatchObject({ result: 'auth', reasonCode: 'seat_token_revoked' });
  });

  it('setConfig validates the merged config and broadcasts it', async () => {
    const { host, store, gameId } = await lobbyWith(0);
    expect(await host.lobby({ kind: 'setConfig', rules: { vpTarget: 12 }, absencePolicy: { skipAfterSec: 90 } })).toMatchObject({ result: 'ok' });
    expect(store.loadGame(gameId)!.meta.config.rules.vpTarget).toBe(12);
    await settle();
    expect((host.last('room')!['room'] as { config: { rules: { vpTarget: number } } }).config.rules.vpTarget).toBe(12);
    expect(await host.lobby({ kind: 'setConfig', rules: { vpTarget: 99 } })).toMatchObject({ result: 'rule', reasonCode: 'malformed_action' });
    expect(store.loadGame(gameId)!.meta.config.rules.vpTarget).toBe(12);
  });
});

describe('start (design §5.1(5), D9 §4, G-A)', () => {
  it('needs 3 seated players', async () => {
    const { host } = await lobbyWith(1);
    expect(await host.lobby({ kind: 'start' })).toMatchObject({ result: 'rule', reasonCode: 'not_enough_players' });
  });

  it('compacts seats, creates the game, persists the seq-0 snapshot, goes active, then sends room{yourSeat} and state{seq:0}', async () => {
    const { s, roomCode, host, players, store, gameId } = await lobbyWith(3);
    expect(await host.lobby({ kind: 'removeSeat', seat: 1 })).toMatchObject({ result: 'ok' });
    expect(await host.lobby({ kind: 'start' })).toMatchObject({ result: 'ok' });
    expect(seatsOf(store, gameId)).toEqual([[0, 'Ana'], [1, 'Cy'], [2, 'Di']]);
    const g = store.loadGame(gameId)!;
    expect(g.meta).toMatchObject({ lifecycle: 'active', engineVersion: expect.any(String), headSeq: 0 });
    expect(g.meta.seed).toMatch(/^[0-9a-f]{32}$/);
    expect(g.snapshot?.seq).toBe(0);
    const state = deserializeState(g.snapshot!.stateJson);
    expect(state.ok && state.state.playerCount).toBe(3);
    expect(state.ok && stateHash(state.state)).toBe(g.snapshot!.stateHash);
    expect(g.events).toEqual([]);
    await settle();
    expect(players[1]!.last('room')).toMatchObject({ yourSeat: 1, room: expect.objectContaining({ lifecycle: 'active' }) });
    expect(players[2]!.last('room')).toMatchObject({ yourSeat: 2 });
    // Each seat gets room{yourSeat} with its final index BEFORE state{seq: 0} with its own view (D9 §4).
    for (const [client, seat] of [[host, 0], [players[1]!, 1], [players[2]!, 2]] as const) {
      const kinds = client.frames.map((f) => f['t']);
      const stateAt = kinds.lastIndexOf('state');
      expect(stateAt).toBeGreaterThan(kinds.lastIndexOf('room'));
      expect(client.frames[stateAt]).toMatchObject({ t: 'state', seq: 0, view: expect.objectContaining({ you: seat }) });
      for (const f of client.frames) expect(serverMsgSchemaStrict.safeParse(f).success).toBe(true);
    }
    expect(players[0]!.all('state')).toEqual([]);
    expect(s.stateHash(roomCode)).toEqual({ seq: 0, stateHash: g.snapshot!.stateHash });
    const events = s.telemetry.logs().map((r) => JSON.parse(r.body as string) as Record<string, unknown>);
    expect(events).toContainEqual(expect.objectContaining({ event: 'game.started', game_id: gameId, player_count: 3, board_hash: expect.any(String) }));
    expect(await host.lobby({ kind: 'start' })).toMatchObject({ reasonCode: 'game_already_started' });
    expect(await host.lobby({ kind: 'reorderSeats', order: [1, 0, 2, 3] })).toMatchObject({ reasonCode: 'game_already_started' });
  });

  it('takes the seed from testHooks.seedFor and an injected seq-0 state from testHooks.initialState', async () => {
    let injected: GameState | undefined;
    const { host, store, gameId } = await lobbyWith(2, {
      testHooks: {
        seedFor: () => ({ seed: 'ab'.repeat(16) }),
        initialState: (_code, created) => (injected = { ...created, nextTradeId: created.nextTradeId }),
      },
    });
    expect(await host.lobby({ kind: 'start' })).toMatchObject({ result: 'ok' });
    const g = store.loadGame(gameId)!;
    expect(g.meta.seed).toBe('ab'.repeat(16));
    const expected = createGame({ config: g.meta.config.rules, playerCount: 3, seed: 'ab'.repeat(16) });
    expect(expected.ok && stateHash(expected.state)).toBe(g.snapshot!.stateHash);
    expect(injected).toBeDefined();
  });

  it('gives the same seq-0 stateHash for the same seedFor seed on repeat runs', async () => {
    const hashes: string[] = [];
    for (let i = 0; i < 2; i++) {
      const { host, store, gameId } = await lobbyWith(2, { testHooks: { seedFor: () => ({ seed: 'cd'.repeat(16) }) } });
      expect(await host.lobby({ kind: 'start' })).toMatchObject({ result: 'ok' });
      hashes.push(store.loadGame(gameId)!.snapshot!.stateHash);
    }
    expect(hashes[0]).toBe(hashes[1]);
  });

  it('ignores testHooks outside the test gate', async () => {
    const saved = { NODE_ENV: process.env['NODE_ENV'], HEXLANDS_TEST_HOOKS: process.env['HEXLANDS_TEST_HOOKS'] };
    process.env['NODE_ENV'] = 'production';
    delete process.env['HEXLANDS_TEST_HOOKS'];
    try {
      const { host, store, gameId } = await lobbyWith(2, { testHooks: { seedFor: () => ({ seed: 'ef'.repeat(16) }) } });
      expect(await host.lobby({ kind: 'start' })).toMatchObject({ result: 'ok' });
      expect(store.loadGame(gameId)!.meta.seed).not.toBe('ef'.repeat(16));
    } finally {
      process.env['NODE_ENV'] = saved.NODE_ENV;
      if (saved.HEXLANDS_TEST_HOOKS !== undefined) process.env['HEXLANDS_TEST_HOOKS'] = saved.HEXLANDS_TEST_HOOKS;
    }
  });

  it('refuses an injected state that fails the server checks with error/internal_error', async () => {
    const { host, store, gameId, s } = await lobbyWith(3, {
      testHooks: { initialState: (_code, created) => ({ ...created, playerCount: 4 }) },
    });
    expect(await host.lobby({ kind: 'removeSeat', seat: 1 })).toMatchObject({ result: 'ok' });
    const before = seatsOf(store, gameId);
    expect(await host.lobby({ kind: 'start' })).toMatchObject({ result: 'error', reasonCode: 'internal_error' });
    expect(store.loadGame(gameId)!.meta.lifecycle).toBe('lobby');
    // Nothing was compacted (bug 6b69209209329369d70d7d16): the seat order clients last saw still holds.
    expect(seatsOf(store, gameId)).toEqual(before);
    expect(store.loadGame(gameId)!.snapshot).toBeNull();
    expect(s.telemetry.metrics()['catan.errors']?.points).toContainEqual({ attributes: { component: 'engine' }, value: 1 });
  });
});
