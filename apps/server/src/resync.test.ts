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
  return { s, store, roomCode, tokens, clients, gameId: store.findByRoomCode(roomCode)!.id };
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

  it('counts a rejoin (token + lastSeq) as catan.ws.reconnects{resumed}, and a first connection not at all', async () => {
    const { s, roomCode, tokens } = await startedGame();
    const resumed = () => s.telemetry.metrics()['catan.ws.reconnects']?.points.find((p) => p.attributes['outcome'] === 'resumed')?.value ?? 0;
    const base = resumed();
    await (await Client.open(s.port)).hello(roomCode, { seatToken: tokens[2] });
    expect(resumed()).toBe(base);
    await (await Client.open(s.port)).hello(roomCode, { seatToken: tokens[2], lastSeq: 0 });
    expect(resumed()).toBe(base + 1);
  });

  it('answers a reconnect to an expired game with game_expired + 4410, counts failed_gone and logs player.reconnected', async () => {
    const { s, store, roomCode, tokens, gameId } = await startedGame();
    store.updateMeta(gameId, { lifecycle: 'expired' });
    const c = await Client.open(s.port);
    expect(await c.hello(roomCode, { seatToken: tokens[2], lastSeq: 0 })).toEqual(
      expect.objectContaining({ result: 'rule', reasonCode: 'game_expired' }),
    );
    await settle();
    expect(c.closeCode).toBe(4410);
    expect(s.telemetry.metrics()['catan.ws.reconnects']?.points).toContainEqual({ attributes: { outcome: 'failed_gone' }, value: 1 });
    const events = s.telemetry.logs().map((r) => JSON.parse(r.body as string) as Record<string, unknown>);
    expect(events).toContainEqual(expect.objectContaining({ event: 'player.reconnected', game_id: gameId, seat: 2, outcome: 'failed_gone' }));
  });

  it('counts a reconnect with a bad token as failed_auth', async () => {
    const { s, roomCode } = await startedGame();
    await (await Client.open(s.port)).hello(roomCode, { seatToken: 'z'.repeat(43), lastSeq: 0 });
    expect(s.telemetry.metrics()['catan.ws.reconnects']?.points).toContainEqual({ attributes: { outcome: 'failed_auth' }, value: 1 });
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
