import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deserializeState, view, type Seat } from '@hexlands/engine';
import { serverMsgSchemaStrict } from '@hexlands/protocol/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { startServer, type RunningServer } from './server';
import { openGameStore, type SqliteGameStore } from './store/sqlite';

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
let n = 0;
const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const settle = () => new Promise((r) => setTimeout(r, 60));
type Msg = Record<string, unknown>;

class Client {
  readonly frames: Msg[] = [];
  closeCode: number | null = null;
  private waiters = new Map<string, (m: Msg) => void>();
  private constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as Msg;
      this.frames.push(m);
      if (m['t'] === 'outcome') this.waiters.get(String(m['actionId']))?.(m);
    });
    ws.on('close', (c) => (this.closeCode = c));
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

/** A started 3-player game: the host (seat 0) and two joiners, all connected. */
async function startedGame(): Promise<{
  s: RunningServer;
  store: SqliteGameStore;
  roomCode: string;
  tokens: string[];
  clients: Client[];
  gameId: string;
  dbPath: string;
}> {
  const dir = mkdtempSync(path.join(tmpdir(), 'hexlands-resync-'));
  const s = await startServer({ port: 0, dbPath: path.join(dir, 'db'), telemetry: 'memory' });
  const store = openGameStore(path.join(dir, 'db'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => s.close(), () => store.close());
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
  await settle();
  return { s, store, roomCode, tokens, clients, gameId: store.findByRoomCode(roomCode)!.id, dbPath: path.join(dir, 'db') };
}

function engineView(store: SqliteGameStore, gameId: string, seat: Seat): unknown {
  const snap = store.loadGame(gameId)!.snapshot!;
  const parsed = deserializeState(snap.stateJson);
  if (!parsed.ok) throw new Error('bad snapshot');
  return JSON.parse(JSON.stringify(view(parsed.state, seat)));
}

describe('reconnect hello (design §5.5, AC22)', () => {
  it.each([
    ['0', 0],
    ['a random seq', 17],
    ['the head', 0],
    ['beyond the head', 999],
    ['negative', -3],
    ['absent', undefined],
  ])('welcomes with the full current view for lastSeq %s, never an error, and changes nothing', async (_n, lastSeq) => {
    const { s, store, roomCode, tokens, gameId } = await startedGame();
    const before = s.stateHash(roomCode);
    const c = await Client.open(s.port);
    const outcome = await c.hello(roomCode, { seatToken: tokens[1], ...(lastSeq !== undefined ? { lastSeq } : {}) });
    expect(outcome).toMatchObject({ result: 'ok' });
    const welcome = c.last('welcome')!;
    expect(welcome).toMatchObject({ seat: 1, seq: 0 });
    expect(welcome['view']).toEqual(engineView(store, gameId, 1));
    expect(serverMsgSchemaStrict.safeParse(welcome).success).toBe(true);
    expect(s.stateHash(roomCode)).toEqual(before);
  });

});

/** catan.ws.reconnects by outcome. */
function reconnects(s: RunningServer): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of s.telemetry.metrics()['catan.ws.reconnects']?.points ?? []) out[p.attributes['outcome']!] = p.value ?? 0;
  return out;
}

/** The change in each catan.ws.reconnects outcome across `run`; outcomes that did not move are omitted. */
async function reconnectDelta(s: RunningServer, run: () => Promise<unknown>): Promise<Record<string, number>> {
  const before = reconnects(s);
  await run();
  const after = reconnects(s);
  const delta: Record<string, number> = {};
  for (const [k, v] of Object.entries(after)) if (v !== (before[k] ?? 0)) delta[k] = v - (before[k] ?? 0);
  return delta;
}

function reconnectedEvents(s: RunningServer): Record<string, unknown>[] {
  return s.telemetry
    .logs()
    .map((r) => JSON.parse(r.body as string) as Record<string, unknown>)
    .filter((e) => e['event'] === 'player.reconnected');
}

const BAD_TOKEN = 'z'.repeat(43);

describe('catan.ws.reconnects: one outcome per hello with a seat token, none for any other hello (design §5.5, §9.2)', () => {
  it.each([
    ['token + lastSeq', (t: string) => ({ seatToken: t, lastSeq: 0 }), { resumed: 1 }],
    ['token only', (t: string) => ({ seatToken: t }), { resumed: 1 }],
    ['visitor (no token)', () => ({}), {}],
    ['visitor with lastSeq', () => ({ lastSeq: 3 }), {}],
    ['bad token', () => ({ seatToken: BAD_TOKEN, lastSeq: 0 }), { failed_auth: 1 }],
  ])('live game, %s', async (_n, extra, expected) => {
    const { s, roomCode, tokens } = await startedGame();
    const delta = await reconnectDelta(s, async () => (await Client.open(s.port)).hello(roomCode, extra(tokens[2]!)));
    expect(delta).toEqual(expected);
  });

  it('an unknown room code counts failed_auth only when the hello carries a token', async () => {
    const { s } = await startedGame();
    expect(await reconnectDelta(s, async () => (await Client.open(s.port)).hello('ZZZZZZ'))).toEqual({});
    expect(await reconnectDelta(s, async () => (await Client.open(s.port)).hello('ZZZZZZ', { seatToken: BAD_TOKEN }))).toEqual({
      failed_auth: 1,
    });
  });

  it.each([
    ['token + lastSeq', (t: string) => ({ seatToken: t, lastSeq: 0 })],
    ['token only', (t: string) => ({ seatToken: t })],
  ])('expired game, %s: game_expired + 4410, failed_gone and player.reconnected with the seat', async (_n, extra) => {
    const { s, store, roomCode, tokens, gameId } = await startedGame();
    store.updateMeta(gameId, { lifecycle: 'expired' });
    const c = await Client.open(s.port);
    let outcome: Msg = {};
    const delta = await reconnectDelta(s, async () => (outcome = await c.hello(roomCode, extra(tokens[2]!))));
    expect(outcome).toMatchObject({ result: 'rule', reasonCode: 'game_expired' });
    await settle();
    expect(c.closeCode).toBe(4410);
    expect(delta).toEqual({ failed_gone: 1 });
    expect(reconnectedEvents(s)).toEqual([expect.objectContaining({ game_id: gameId, seat: 2, outcome: 'failed_gone' })]);
  });

  it('expired game, visitor: game_expired + 4410, not a reconnect', async () => {
    const { s, store, roomCode, gameId } = await startedGame();
    store.updateMeta(gameId, { lifecycle: 'expired' });
    const c = await Client.open(s.port);
    let outcome: Msg = {};
    expect(await reconnectDelta(s, async () => (outcome = await c.hello(roomCode, { lastSeq: 0 })))).toEqual({});
    expect(outcome).toMatchObject({ result: 'rule', reasonCode: 'game_expired' });
    await settle();
    expect(c.closeCode).toBe(4410);
    expect(reconnectedEvents(s)).toEqual([]);
  });

  it('expired game, bad token: authenticated first, so auth/bad_seat_token + 4401 and failed_auth, never failed_gone', async () => {
    const { s, store, roomCode, gameId } = await startedGame();
    store.updateMeta(gameId, { lifecycle: 'expired' });
    const c = await Client.open(s.port);
    let outcome: Msg = {};
    expect(await reconnectDelta(s, async () => (outcome = await c.hello(roomCode, { seatToken: BAD_TOKEN, lastSeq: 0 })))).toEqual({
      failed_auth: 1,
    });
    expect(outcome).toMatchObject({ result: 'auth', reasonCode: 'bad_seat_token' });
    await settle();
    expect(c.closeCode).toBe(4401);
    expect(reconnectedEvents(s)).toEqual([]);
  });

  it('a hello whose handler throws counts failed_error only when it carries a token', async () => {
    const { s, store, roomCode, tokens, gameId, dbPath } = await startedGame();
    await s.close();
    // A finished game with an unreadable snapshot makes the room load throw inside the hello handler of a fresh server
    // (active and abandoned games take the lost path instead).
    store.updateMeta(gameId, { lifecycle: 'finished' });
    store.writeSnapshot(gameId, 0, 'not json', 'x'.repeat(64), 'test', Date.now());
    const s2 = await startServer({ port: 0, dbPath, telemetry: 'memory' });
    cleanups.push(() => s2.close());
    const hello = async (extra: Msg) => (await Client.open(s2.port)).hello(roomCode, extra);
    for (const extra of [{}, { lastSeq: 0 }]) {
      let outcome: Msg = {};
      expect(await reconnectDelta(s2, async () => (outcome = await hello(extra)))).toEqual({});
      expect(outcome).toMatchObject({ result: 'error', reasonCode: 'internal_error' });
    }
    for (const extra of [{ seatToken: tokens[1] }, { seatToken: tokens[1], lastSeq: 0 }]) {
      let outcome: Msg = {};
      expect(await reconnectDelta(s2, async () => (outcome = await hello(extra)))).toEqual({ failed_error: 1 });
      expect(outcome).toMatchObject({ result: 'error', reasonCode: 'internal_error' });
    }
  });
});

describe('D21: a seat’s first bind is not a reconnect (design §9.2, NFR6)', () => {
  async function bootFresh(dbPath?: string): Promise<{ s: RunningServer; dbPath: string }> {
    let p = dbPath;
    if (p === undefined) {
      const dir = mkdtempSync(path.join(tmpdir(), 'hexlands-d21-'));
      cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
      p = path.join(dir, 'db');
    }
    const s = await startServer({ port: 0, dbPath: p, telemetry: 'memory' });
    cleanups.push(() => s.close());
    return { s, dbPath: p };
  }

  it('the host’s first hello records nothing; the second counts resumed; after a restart it still counts', async () => {
    const { s, dbPath } = await bootFresh();
    const { roomCode, seatToken } = await createRoom(s.port);
    const first = await reconnectDelta(s, async () => (await Client.open(s.port)).hello(roomCode, { seatToken }));
    expect(first).toEqual({});
    expect(reconnectedEvents(s)).toEqual([]);
    expect(await reconnectDelta(s, async () => (await Client.open(s.port)).hello(roomCode, { seatToken, lastSeq: 0 }))).toEqual({ resumed: 1 });
    await s.close();

    const { s: s2 } = await bootFresh(dbPath);
    expect(await reconnectDelta(s2, async () => (await Client.open(s2.port)).hello(roomCode, { seatToken }))).toEqual({ resumed: 1 });
  });

  it('a joiner is bound by its lobby join, so its first token hello is a reconnect', async () => {
    const { s } = await bootFresh();
    const { roomCode } = await createRoom(s.port);
    const joiner = await Client.open(s.port);
    const joined = await reconnectDelta(s, async () => {
      await joiner.hello(roomCode);
      await joiner.cmd({ t: 'lobby', op: { kind: 'join', displayName: 'Bo' } });
    });
    expect(joined).toEqual({});
    const token = joiner.last('seatToken')!['seatToken'] as string;
    expect(await reconnectDelta(s, async () => (await Client.open(s.port)).hello(roomCode, { seatToken: token }))).toEqual({ resumed: 1 });
  });

  it('first_bound_at moves with the player on a D9 reorder', async () => {
    const { s } = await bootFresh();
    const { roomCode, seatToken } = await createRoom(s.port);
    const host = await Client.open(s.port);
    await host.hello(roomCode, { seatToken });
    const joiner = await Client.open(s.port);
    await joiner.hello(roomCode);
    await joiner.cmd({ t: 'lobby', op: { kind: 'join', displayName: 'Bo' } });
    const token = joiner.last('seatToken')!['seatToken'] as string;
    expect(await host.cmd({ t: 'lobby', op: { kind: 'reorderSeats', order: [1, 0, 2, 3] } })).toMatchObject({ result: 'ok' });
    const delta = await reconnectDelta(s, async () => {
      const c = await Client.open(s.port);
      await c.hello(roomCode, { seatToken: token });
      expect(c.last('welcome')).toMatchObject({ seat: 0 });
    });
    expect(delta).toEqual({ resumed: 1 });
  });

  it('failed classes are unchanged by D21', async () => {
    const { s } = await bootFresh();
    const { roomCode } = await createRoom(s.port);
    expect(await reconnectDelta(s, async () => (await Client.open(s.port)).hello(roomCode, { seatToken: BAD_TOKEN }))).toEqual({ failed_auth: 1 });
  });
});

describe('resync signal (design §5.5)', () => {
  it('sends state{seq: head, view} to the asking socket only and changes nothing', async () => {
    const { s, store, roomCode, clients, gameId } = await startedGame();
    const before = s.stateHash(roomCode);
    const counts = clients.map((c) => c.frames.length);
    clients[1]!.ws.send(JSON.stringify({ t: 'resync' }));
    await settle();
    const got = clients[1]!.frames.slice(counts[1]);
    expect(got).toHaveLength(1);
    expect(got[0]).toEqual({ t: 'state', seq: 0, view: engineView(store, gameId, 1) });
    expect(clients[0]!.frames.length).toBe(counts[0]);
    expect(clients[2]!.frames.length).toBe(counts[2]);
    expect(s.stateHash(roomCode)).toEqual(before);
  });

  it('ignores a resync from a socket without a seat or before the game starts', async () => {
    const { s, roomCode } = await startedGame();
    const visitor = await Client.open(s.port);
    await visitor.hello(roomCode);
    const seen = visitor.frames.length;
    visitor.ws.send(JSON.stringify({ t: 'resync' }));
    const lobby = await createRoom(s.port);
    const host = await Client.open(s.port);
    await host.hello(lobby.roomCode, { seatToken: lobby.seatToken });
    const hostSeen = host.frames.length;
    host.ws.send(JSON.stringify({ t: 'resync' }));
    await settle();
    expect(visitor.frames.length).toBe(seen);
    expect(host.frames.length).toBe(hostSeen);
  });
});
