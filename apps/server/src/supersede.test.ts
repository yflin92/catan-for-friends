import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { FakeClock } from './testing';
import { startServer, type RunningServer } from './server';
import { openGameStore } from './store/sqlite';

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
let n = 0;
const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

async function boot(): Promise<{ s: RunningServer; db: string }> {
  const dir = mkdtempSync(path.join(tmpdir(), 'hexlands-supersede-'));
  const s = await startServer({ port: 0, dbPath: path.join(dir, 'db'), telemetry: 'memory' });
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => s.close());
  return { s, db: path.join(dir, 'db') };
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

interface Sock {
  ws: WebSocket;
  frames: Record<string, unknown>[];
  closed: Promise<number>;
  outcome(actionId: string): Promise<Record<string, unknown>>;
}
async function open(port: number): Promise<Sock> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  cleanups.push(() => ws.terminate());
  const frames: Record<string, unknown>[] = [];
  const waiters = new Map<string, (m: Record<string, unknown>) => void>();
  ws.on('message', (d) => {
    const m = JSON.parse(String(d)) as Record<string, unknown>;
    frames.push(m);
    if (m['t'] === 'outcome') waiters.get(String(m['actionId']))?.(m);
  });
  const closed = new Promise<number>((r) => ws.on('close', (c) => r(c)));
  await new Promise((r, j) => ws.once('open', r).once('error', j));
  return { ws, frames, closed, outcome: (a) => new Promise((r) => waiters.set(a, r)) };
}
async function hello(sock: Sock, roomCode: string, seatToken: string, lastSeq?: number) {
  const a = id();
  const done = sock.outcome(a);
  sock.ws.send(JSON.stringify({ t: 'hello', v: 1, actionId: a, roomCode, seatToken, ...(lastSeq !== undefined ? { lastSeq } : {}) }));
  return done;
}
const events = (s: RunningServer) => s.telemetry.logs().map((r) => JSON.parse(r.body as string) as Record<string, unknown>);

describe('seat supersede (P6, AC24)', () => {
  it('tells the older socket it was superseded, closes it 4001 and welcomes the newer one; state is unchanged', async () => {
    const { s, db } = await boot();
    const { roomCode, seatToken } = await createRoom(s.port);
    const a = await open(s.port);
    expect(await hello(a, roomCode, seatToken)).toMatchObject({ result: 'ok' });
    const store = openGameStore(db);
    cleanups.push(() => store.close());
    const before = store.findByRoomCode(roomCode)!;
    const b = await open(s.port);
    expect(await hello(b, roomCode, seatToken)).toMatchObject({ result: 'ok' });
    expect(await a.closed).toBe(4001);
    expect(a.frames.at(-1)).toEqual({ t: 'superseded' });
    expect(b.frames.find((f) => f['t'] === 'welcome')).toMatchObject({ seat: 0, isHost: true });
    const after = store.findByRoomCode(roomCode)!;
    expect({ headSeq: after.headSeq, roomRev: after.roomRev, lifecycle: after.lifecycle }).toEqual({
      headSeq: before.headSeq,
      roomRev: before.roomRev,
      lifecycle: before.lifecycle,
    });
    expect(b.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('classifies the dropped socket as superseded (never unplanned) and logs the device switch', async () => {
    const { s } = await boot();
    const { roomCode, seatToken } = await createRoom(s.port);
    const a = await open(s.port);
    await hello(a, roomCode, seatToken);
    const b = await open(s.port);
    await hello(b, roomCode, seatToken);
    await a.closed;
    await new Promise((r) => setTimeout(r, 50));
    const ev = events(s);
    expect(ev).toContainEqual(expect.objectContaining({ event: 'player.reconnected', seat: 0, outcome: 'resumed', gap_s: 0 }));
    const drop = ev.find((e) => e['event'] === 'player.disconnected');
    expect(drop).toMatchObject({ seat: 0, reason: 'superseded' });
    expect(drop).not.toHaveProperty('cause');
  });

  it('logs player.disconnected and then player.reconnected with the gap and seq_behind after a plain drop', async () => {
    const { s } = await boot();
    const { roomCode, seatToken } = await createRoom(s.port);
    const a = await open(s.port);
    await hello(a, roomCode, seatToken);
    a.ws.close(1000);
    await a.closed;
    await new Promise((r) => setTimeout(r, 50));
    const b = await open(s.port);
    await hello(b, roomCode, seatToken, 0);
    const ev = events(s);
    expect(ev).toContainEqual(expect.objectContaining({ event: 'player.disconnected', seat: 0, reason: 'client_closed' }));
    expect(ev).toContainEqual(expect.objectContaining({ event: 'player.reconnected', seat: 0, outcome: 'resumed', seq_behind: 0 }));
  });

  it('a superseded close is not a drop: a later switch measures gap_s 0, not the time since the previous switch', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hexlands-supersede-'));
    const clock = new FakeClock(1_000_000);
    const s = await startServer({ port: 0, dbPath: path.join(dir, 'db'), telemetry: 'memory', clock });
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => s.close());
    const { roomCode, seatToken } = await createRoom(s.port);
    const a = await open(s.port);
    await hello(a, roomCode, seatToken);
    const b = await open(s.port);
    await hello(b, roomCode, seatToken);
    await a.closed;
    await new Promise((r) => setTimeout(r, 50));
    // 20 s: under the 25 s heartbeat timeout, so b stays connected until c supersedes it.
    clock.advance(20_000);
    const c = await open(s.port);
    await hello(c, roomCode, seatToken);
    await b.closed;
    await new Promise((r) => setTimeout(r, 50));
    const switches = events(s).filter((e) => e['event'] === 'player.reconnected');
    expect(switches.map((e) => e['gap_s'])).toEqual([0, 0]);
    expect(events(s).filter((e) => e['event'] === 'player.disconnected').map((e) => e['reason'])).toEqual(['superseded', 'superseded']);
  });

  it('does not log a reconnect for a first connection', async () => {
    const { s } = await boot();
    const { roomCode, seatToken } = await createRoom(s.port);
    await hello(await open(s.port), roomCode, seatToken);
    expect(events(s).map((e) => e['event'])).not.toContain('player.reconnected');
  });
});
