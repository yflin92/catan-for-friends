// Host seat relink (design §5.1(6), Q8; AC24 Q8 slice): control relinkSeat revokes the seat's token, mints a new one
// for the host only, and closes the old socket 4401. Game state never changes.
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { startServer, type RunningServer } from './server';
import { openGameStore, type SqliteGameStore } from './store/sqlite';
import { RecordingSecrets } from './testing';

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
  relink(seat: number) {
    return this.cmd({ t: 'control', op: { kind: 'relinkSeat', seat } });
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

interface Table {
  s: RunningServer;
  store: SqliteGameStore;
  secrets: RecordingSecrets;
  dbPath: string;
  roomCode: string;
  tokens: string[];
  clients: Client[];
  gameId: string;
}

/** A 3-player room (host seat 0 plus two joiners, all connected); started unless `start` is false. */
async function table(opts: { start?: boolean; relinkEnabled?: boolean; dbPath?: string } = {}): Promise<Table> {
  let dbPath = opts.dbPath;
  if (dbPath === undefined) {
    const dir = mkdtempSync(path.join(tmpdir(), 'hexlands-relink-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    dbPath = path.join(dir, 'db');
  }
  const secrets = new RecordingSecrets();
  const s = await startServer({ port: 0, dbPath, telemetry: 'memory', secrets });
  const store = openGameStore(dbPath);
  cleanups.push(() => s.close(), () => store.close());
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
  if (opts.relinkEnabled === false) {
    expect(await host.cmd({ t: 'lobby', op: { kind: 'setConfig', absencePolicy: { seatRelinkEnabled: false } } })).toMatchObject({ result: 'ok' });
  }
  if (opts.start !== false) expect(await host.cmd({ t: 'lobby', op: { kind: 'start' } })).toMatchObject({ result: 'ok' });
  await settle();
  return { s, store, secrets, dbPath, roomCode, tokens, clients, gameId: store.findByRoomCode(roomCode)!.id };
}

describe('control relinkSeat (design §5.1(6))', () => {
  it('mid-game: the new token goes to the host only, the old socket closes 4401, game state and the seat row are unchanged', async () => {
    const t = await table();
    const [host, bo, cy] = t.clients as [Client, Client, Client];
    const before = t.s.stateHash(t.roomCode);
    const seatBefore = t.store.loadGame(t.gameId)!.seats.find((r) => r.seat === 1)!;
    const counts = [host, bo, cy].map((c) => c.frames.length);

    expect(await host.relink(1)).toMatchObject({ result: 'ok' });
    await settle();
    const fresh = host.last('seatToken')!;
    expect(fresh).toMatchObject({ t: 'seatToken', seat: 1, purpose: 'relinked' });
    const newToken = fresh['seatToken'] as string;
    expect(newToken).not.toBe(t.tokens[1]);
    expect(t.secrets.valuesOf('seatToken')).toContain(newToken);
    // Only the host saw the new token; nobody else got any frame carrying it.
    expect(bo.frames.slice(counts[1]).concat(cy.frames.slice(counts[2])).some((f) => JSON.stringify(f).includes(newToken))).toBe(false);
    expect(bo.closeCode).toBe(4401);
    expect(cy.closeCode).toBeNull();

    expect(t.s.stateHash(t.roomCode)).toEqual(before);
    const seatAfter = t.store.loadGame(t.gameId)!.seats.find((r) => r.seat === 1)!;
    expect(seatAfter).toEqual(seatBefore);
    // Logs and metrics never carry either token.
    const out = JSON.stringify({ logs: t.s.telemetry.logs().map((r) => r.body), metrics: t.s.telemetry.metrics() });
    expect(out).not.toContain(newToken);
    expect(out).not.toContain(t.tokens[1]!);

    // The old link is revoked (never bad_seat_token, never accepted); the new one binds the same seat.
    const oldLink = await Client.open(t.s.port);
    expect(await oldLink.hello(t.roomCode, { seatToken: t.tokens[1] })).toMatchObject({ result: 'auth', reasonCode: 'seat_token_revoked' });
    await settle();
    expect(oldLink.closeCode).toBe(4401);
    const newLink = await Client.open(t.s.port);
    expect(await newLink.hello(t.roomCode, { seatToken: newToken })).toMatchObject({ result: 'ok' });
    expect(newLink.last('welcome')).toMatchObject({ seat: 1, isHost: false });
    expect(t.s.stateHash(t.roomCode)).toEqual(before);
  });

  it('a command already in flight on the old socket gets auth/seat_token_revoked', async () => {
    const t = await table();
    const [host, bo] = t.clients as [Client, Client];
    const relinked = host.relink(1);
    const late = bo.cmd({ t: 'action', baseSeq: 0, action: { type: 'endTurn' } });
    await relinked;
    const outcome = await Promise.race([late, settle().then(() => null)]);
    // Either the socket was already closed before the frame was read (no outcome), or the frame was refused.
    if (outcome !== null) expect(outcome).toMatchObject({ result: 'auth', reasonCode: 'seat_token_revoked' });
    expect(t.s.stateHash(t.roomCode)?.seq).toBe(0);
  });

  it('works in the lobby too, and the room view is unchanged', async () => {
    const t = await table({ start: false });
    const [host] = t.clients as [Client];
    expect(await host.relink(2)).toMatchObject({ result: 'ok' });
    await settle();
    expect(t.clients[2]!.closeCode).toBe(4401);
    expect(t.store.loadGame(t.gameId)!.seats.map((r) => [r.seat, r.displayName])).toEqual([[0, 'Ana'], [1, 'Bo'], [2, 'Cy']]);
  });

  it('the revocation survives a restart', async () => {
    const t = await table();
    await t.clients[0]!.relink(1);
    const fresh = t.clients[0]!.last('seatToken')!['seatToken'] as string;
    await t.s.close();
    const s2 = await startServer({ port: 0, dbPath: t.dbPath, telemetry: 'memory' });
    cleanups.push(() => s2.close());
    const old = await Client.open(s2.port);
    expect(await old.hello(t.roomCode, { seatToken: t.tokens[1] })).toMatchObject({ result: 'auth', reasonCode: 'seat_token_revoked' });
    const fresher = await Client.open(s2.port);
    expect(await fresher.hello(t.roomCode, { seatToken: fresh })).toMatchObject({ result: 'ok' });
  });

  it('rejections: non-host → not_host; own seat, an empty seat or relink disabled → malformed_action; nothing changes', async () => {
    const t = await table();
    const [host, bo] = t.clients as [Client, Client];
    expect(await bo.relink(2)).toMatchObject({ result: 'auth', reasonCode: 'not_host' });
    expect(await host.relink(0)).toMatchObject({ result: 'rule', reasonCode: 'malformed_action' });
    expect(await host.relink(3)).toMatchObject({ result: 'rule', reasonCode: 'malformed_action' });
    await settle();
    expect(t.clients.map((c) => c.closeCode)).toEqual([null, null, null]);

    const off = await table({ relinkEnabled: false });
    expect(await off.clients[0]!.relink(1)).toMatchObject({ result: 'rule', reasonCode: 'malformed_action' });
    await settle();
    expect(off.clients[1]!.closeCode).toBeNull();
    const still = await Client.open(off.s.port);
    expect(await still.hello(off.roomCode, { seatToken: off.tokens[1] })).toMatchObject({ result: 'ok' });
  });

  it('an unbound socket → auth/unknown_room', async () => {
    const t = await table();
    const stranger = await Client.open(t.s.port);
    expect(await stranger.relink(1)).toMatchObject({ result: 'auth', reasonCode: 'unknown_room' });
  });
});
