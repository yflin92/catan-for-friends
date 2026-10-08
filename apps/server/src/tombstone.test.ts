import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_GAME_CONFIG, type GameConfig, type Seat } from '@hexlands/engine';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { hashRoomCode, hashSeatToken, mintRoomCode, mintSeatToken } from './codes';
import type * as CodesModule from './codes';
import { startServer, type RunningServer, type ServerOptions } from './server';
import { openGameStore, type SqliteGameStore } from './store/sqlite';
import { FakeClock } from './testing';

// Room codes handed out by mintRoomCode before it falls back to random ones (the minting test queues a tombstoned code).
const minted = vi.hoisted(() => ({ queue: [] as string[] }));
vi.mock('./codes', async (importOriginal) => {
  const actual = await importOriginal<typeof CodesModule>();
  return { ...actual, mintRoomCode: (length: number) => minted.queue.shift() ?? actual.mintRoomCode(length) };
});

const DAY = 24 * 60 * 60_000;
const T0 = Date.UTC(2026, 9, 8, 12, 0, 0);

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  minted.queue.length = 0;
  for (const c of cleanups.splice(0).reverse()) await c();
});

interface Booted {
  s: RunningServer;
  store: SqliteGameStore;
  clock: FakeClock;
}

async function boot(opts: Partial<ServerOptions> = {}): Promise<Booted> {
  const dir = mkdtempSync(path.join(tmpdir(), 'hexlands-tomb-'));
  const clock = new FakeClock(T0);
  const s = await startServer({ port: 0, dbPath: path.join(dir, 'db'), telemetry: 'memory', clock, buildVersion: 'v-tomb', ...opts });
  const store = openGameStore(path.join(dir, 'db'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => s.close(), () => store.close());
  return { s, store, clock };
}

interface Game {
  gameId: string;
  roomCode: string;
  tokens: string[];
}

/** A game row with two seated players, in `lifecycle`, created at clock time. */
function game(b: Booted, patch: Parameters<SqliteGameStore['updateMeta']>[1], config: GameConfig = DEFAULT_GAME_CONFIG): Game {
  const gameId = randomUUID();
  const roomCode = mintRoomCode(6);
  const now = b.clock.now();
  b.store.createRoom({ id: gameId, roomCode, config, hostSeat: 0, createdAt: now });
  const tokens = [mintSeatToken(), mintSeatToken()];
  tokens.forEach((t, seat) => b.store.upsertSeat(gameId, seat as Seat, `Player ${seat}`, hashSeatToken(t), now));
  b.store.updateMeta(gameId, patch);
  return { gameId, roomCode, tokens };
}

/** An expired game purged by the job into a tombstone. */
function tombstoned(b: Booted, config?: GameConfig): Game {
  const g = game(b, { lifecycle: 'expired', endReason: 'abandoned_expired', endedAt: b.clock.now(), seed: 'seed-g' }, config);
  b.s.runAbandonmentJob();
  expect(b.store.findGame(g.gameId)).toMatchObject({ roomCode: null, seed: null });
  return g;
}

interface Session {
  outcome: Record<string, unknown>;
  code: number | null;
}

async function hello(port: number, roomCode: string, seatToken?: string): Promise<Session> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  cleanups.push(() => ws.terminate());
  let code: number | null = null;
  const closed = new Promise<void>((r) => ws.on('close', (c) => ((code = c), r())));
  await new Promise((r, j) => ws.once('open', r).once('error', j));
  const outcome = new Promise<Record<string, unknown>>((r) =>
    ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as Record<string, unknown>;
      if (m['t'] === 'outcome') r(m);
    }),
  );
  ws.send(JSON.stringify({ t: 'hello', v: 1, actionId: randomUUID(), roomCode, ...(seatToken !== undefined ? { seatToken } : {}) }));
  const o = await outcome;
  await Promise.race([closed, new Promise((r) => setTimeout(r, 100))]);
  return { outcome: o, code };
}

function createRoom(port: number): Promise<{ roomCode: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path: '/api/rooms', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as { roomCode: string }));
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify({ displayName: 'Ana' }));
  });
}

const expired = { outcome: expect.objectContaining({ result: 'rule', reasonCode: 'game_expired' }), code: 4410 };

describe('room tombstones (design D26, AC29)', () => {
  it('a rejoin link to a purged room answers game_expired + 4410, and tombstone hits never count toward the code limiter', async () => {
    const b = await boot({ config: { rooms: { failedCodeAttemptsPerIpPerMin: 2 } } });
    const g = tombstoned(b);
    for (let i = 0; i < 3; i++) expect(await hello(b.s.port, g.roomCode, g.tokens[i % 2])).toEqual(expired);
    // The limiter is untouched: two unknown codes are still answered, the third attempt is limited.
    expect((await hello(b.s.port, 'ZZZZZZ')).outcome).toMatchObject({ reasonCode: 'unknown_room' });
    expect((await hello(b.s.port, 'ZZZZZY')).outcome).toMatchObject({ reasonCode: 'unknown_room' });
    expect((await hello(b.s.port, g.roomCode, g.tokens[0])).outcome).toMatchObject({ reasonCode: 'rate_limited_auth' });
  });

  it('a visitor (no token) with a tombstoned code gets game_expired + 4410; the code is matched case- and dash-insensitively', async () => {
    const b = await boot();
    const g = tombstoned(b);
    expect(await hello(b.s.port, g.roomCode)).toEqual(expired);
    expect(await hello(b.s.port, `${g.roomCode.slice(0, 3)}-${g.roomCode.slice(3)}`.toLowerCase())).toEqual(expired);
  });

  it('token checks consult the tombstone: an unknown token → bad_seat_token, another game’s → token_room_mismatch (4401)', async () => {
    const b = await boot();
    const g = tombstoned(b);
    const other = tombstoned(b);
    const live = game(b, { lifecycle: 'active', startedAt: b.clock.now(), lastActionAt: b.clock.now() });
    const bad = await hello(b.s.port, g.roomCode, mintSeatToken());
    expect(bad).toEqual({ outcome: expect.objectContaining({ result: 'auth', reasonCode: 'bad_seat_token' }), code: 4401 });
    expect((await hello(b.s.port, g.roomCode, other.tokens[0])).outcome).toMatchObject({ reasonCode: 'token_room_mismatch' });
    expect((await hello(b.s.port, g.roomCode, live.tokens[0])).outcome).toMatchObject({ reasonCode: 'token_room_mismatch' });
  });

  it('after tombstoneDays the job clears the tombstone: the code is unknown_room and no tombstone rows remain', async () => {
    const config: GameConfig = { ...DEFAULT_GAME_CONFIG, lifecycle: { ...DEFAULT_GAME_CONFIG.lifecycle, tombstoneDays: 2 } };
    const b = await boot({ config: { lifecycle: { checkIntervalSec: 3600 } } });
    const g = tombstoned(b, config);
    expect(b.store.findGame(g.gameId)!.tombstoneUntil).toBe(T0 + 2 * DAY);
    b.clock.advance(2 * DAY - 1);
    b.s.runAbandonmentJob();
    expect(await hello(b.s.port, g.roomCode, g.tokens[0])).toEqual(expired);
    b.clock.advance(1);
    b.s.runAbandonmentJob();
    // The room step comes first (D21 precedence), so the link and the bare code are both unknown now.
    expect((await hello(b.s.port, g.roomCode, g.tokens[0])).outcome).toMatchObject({ result: 'auth', reasonCode: 'unknown_room' });
    expect((await hello(b.s.port, g.roomCode)).outcome).toMatchObject({ result: 'auth', reasonCode: 'unknown_room' });
    expect(b.store.findGame(g.gameId)).toMatchObject({ tombstoneUntil: null, roomCode: null });
    expect(b.store.hasTombstone(hashRoomCode(g.roomCode))).toBe(false);
    expect(g.tokens.map((t) => b.store.tombstoneOfToken(hashSeatToken(t)))).toEqual([null, null]);
  });

  it('minting never reuses a tombstoned code; it draws again', async () => {
    const b = await boot();
    const g = tombstoned(b);
    minted.queue.push(g.roomCode, 'QRSTUV');
    expect(await createRoom(b.s.port)).toMatchObject({ roomCode: 'QRSTUV' });
  });

  it('lost, lobby-expired and finished-past-retention games are tombstoned too, with the seed purged', async () => {
    const b = await boot();
    const lost = game(b, { lifecycle: 'expired', endReason: 'lost', endedAt: b.clock.now(), seed: 'seed-lost' });
    const done = game(b, { lifecycle: 'finished', endReason: 'won', endedAt: b.clock.now() - 7 * DAY, seed: 'seed-done' });
    const lobby = game(b, { lifecycle: 'expired', endReason: 'lobby_expired', endedAt: b.clock.now() });
    const recent = game(b, { lifecycle: 'finished', endReason: 'won', endedAt: b.clock.now() - 7 * DAY + 1 });
    b.s.runAbandonmentJob();
    for (const g of [lost, done, lobby]) {
      expect(b.store.findGame(g.gameId)).toMatchObject({ roomCode: null, seed: null, tombstoneUntil: T0 + 30 * DAY });
      expect(await hello(b.s.port, g.roomCode, g.tokens[1])).toEqual(expired);
    }
    expect(b.store.findGame(recent.gameId)).toMatchObject({ roomCode: recent.roomCode, tombstoneUntil: null });
  });
});
