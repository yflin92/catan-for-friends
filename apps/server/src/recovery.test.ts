// Restart recovery (design §5.9, §7 F6/F7; AC27, Evolve G3): the shutdown marker, eager restore of active games, lazy
// restore of abandoned games, presence at boot, and the lost path.
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_GAME_CONFIG, ENGINE_VERSION, createGame, reduce, serializeState, stateHash, type GameState, type Seat } from '@hexlands/engine';
import { sampleLegalAction } from '@hexlands/engine/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { hashSeatToken, mintRoomCode, mintSeatToken } from './codes';
import { payloadHashOf } from './game-room';
import { startServer, type RunningServer } from './server';
import type { Lifecycle } from './store/game-store';
import { openGameStore, type SqliteGameStore } from './store/sqlite';
import { FakeClock } from './testing';

const BOOT_AT = Date.UTC(2026, 9, 8, 12);

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function tempDb(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'hexlands-recovery-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'hexlands.db');
}

async function boot(dbPath: string): Promise<RunningServer> {
  const s = await startServer({ port: 0, dbPath, telemetry: 'memory', clock: new FakeClock(BOOT_AT) });
  cleanups.push(() => s.close());
  return s;
}

function store(dbPath: string): SqliteGameStore {
  const st = openGameStore(dbPath);
  cleanups.push(() => st.close());
  return st;
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

interface Seeded {
  gameId: string;
  roomCode: string;
  tokens: string[];
  state: GameState;
  /** hash_after of each written event, in seq order. */
  hashes: string[];
}

/** A started 3-seat game with `moves` committed events after its seq-0 snapshot. */
function seed(st: SqliteGameStore, lifecycle: Lifecycle, moves = 3, patch: Parameters<SqliteGameStore['updateMeta']>[1] = {}): Seeded {
  const r = createGame({ config: DEFAULT_GAME_CONFIG.rules, playerCount: 3, seed: randomUUID() });
  if (!r.ok) throw new Error('createGame failed');
  const gameId = randomUUID();
  const roomCode = mintRoomCode(6);
  const startedAt = BOOT_AT - 3_600_000;
  st.createRoom({ id: gameId, roomCode, config: { ...DEFAULT_GAME_CONFIG, rules: r.state.config }, hostSeat: 0, createdAt: startedAt });
  const tokens = [0, 1, 2].map(() => mintSeatToken());
  tokens.forEach((t, seat) => st.upsertSeat(gameId, seat as Seat, `P${seat}`, hashSeatToken(t), startedAt));
  st.writeSnapshot(gameId, 0, serializeState(r.state), stateHash(r.state), ENGINE_VERSION, startedAt);
  let state = r.state;
  const hashes: string[] = [];
  let n = 1;
  const rand = () => ((n = (n * 1103515245 + 12345) >>> 0) / 2 ** 32);
  for (let seq = 1; seq <= moves; seq++) {
    const by = state.turn.active;
    const action = sampleLegalAction(state, by, rand)!;
    const res = reduce(state, { by, action });
    if (!res.ok) throw new Error('seed move rejected');
    state = res.state;
    hashes.push(stateHash(state));
    st.appendEvent({
      gameId, seq, actionId: randomUUID(), payloadHash: payloadHashOf({ by, action }), by,
      command: { by, action }, hashAfter: stateHash(state), at: startedAt + seq,
    });
  }
  st.updateMeta(gameId, { lifecycle, seed: 'secret-seed', engineVersion: ENGINE_VERSION, startedAt, activePlayMs: 90_000, ...patch });
  return { gameId, roomCode, tokens, state, hashes };
}

/** Rewrites one event's stored hash_after so that replay no longer reproduces it. */
function corruptEvent(dbPath: string, gameId: string, seq: number): void {
  const st = openGameStore(dbPath);
  (st as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): void } } }).db
    .prepare('UPDATE events SET hash_after = ? WHERE game_id = ? AND seq = ?')
    .run('f'.repeat(64), gameId, seq);
  st.close();
}

async function hello(port: number, roomCode: string, seatToken: string): Promise<{ outcome: Record<string, unknown>; close: number }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  cleanups.push(() => ws.terminate());
  await new Promise((r, j) => ws.once('open', r).once('error', j));
  const actionId = randomUUID();
  const closed = new Promise<number>((r) => ws.once('close', r));
  const outcome = await new Promise<Record<string, unknown>>((resolve) => {
    ws.on('message', (d) => {
      const f = JSON.parse(String(d)) as Record<string, unknown>;
      if (f['t'] === 'outcome' && f['actionId'] === actionId) resolve(f);
    });
    ws.send(JSON.stringify({ t: 'hello', v: 1, actionId, roomCode, seatToken }));
  });
  const close = outcome['result'] === 'ok' ? 0 : await closed;
  return { outcome, close };
}

describe('boot: shutdown marker (design §5.9 step 1)', () => {
  it('a fresh database starts unclean; a drained one starts clean, once (the marker is consumed)', async () => {
    const dbPath = tempDb();
    const s1 = await boot(dbPath);
    expect(counter(s1, 'catan.server.starts', { shutdown: 'unclean' })).toBe(1);
    await s1.drain();
    const s2 = await boot(dbPath);
    expect(counter(s2, 'catan.server.starts', { shutdown: 'clean' })).toBe(1);
    expect(events(s2, 'server.started')).toEqual([expect.objectContaining({ previous_shutdown: 'clean', games_restored: 0, lost_on_restart: 0 })]);
    await s2.close();
    const s3 = await boot(dbPath);
    expect(counter(s3, 'catan.server.starts', { shutdown: 'unclean' })).toBe(1);
  });
});

describe('boot: restore (design §5.9 step 2)', () => {
  it('restores every active game eagerly from snapshot + replay; presence starts all-disconnected', async () => {
    const dbPath = tempDb();
    const st = store(dbPath);
    const a = seed(st, 'active', 4);
    const kept = seed(st, 'active', 2, { allDisconnectedSince: BOOT_AT - 120_000 });
    const s = await boot(dbPath);
    expect(counter(s, 'catan.games.restored_on_start')).toBe(2);
    expect(events(s, 'server.started')).toEqual([expect.objectContaining({ games_restored: 2, lost_on_restart: 0, previous_shutdown: 'unclean' })]);
    expect(s.stateHash(a.roomCode)).toEqual({ seq: 4, stateHash: stateHash(a.state) });
    expect(st.loadGame(a.gameId)!.meta.allDisconnectedSince).toBe(BOOT_AT);
    expect(st.loadGame(kept.gameId)!.meta.allDisconnectedSince).toBe(BOOT_AT - 120_000);
  });

  it('restores an abandoned game lazily, on its first hello, counting restored_on_start once', async () => {
    const dbPath = tempDb();
    const st = store(dbPath);
    const g = seed(st, 'abandoned', 3);
    const s = await boot(dbPath);
    expect(counter(s, 'catan.games.restored_on_start')).toBe(0);
    expect((await hello(s.port, g.roomCode, g.tokens[0]!)).outcome).toMatchObject({ result: 'ok' });
    expect(counter(s, 'catan.games.restored_on_start')).toBe(1);
    expect((await hello(s.port, g.roomCode, g.tokens[1]!)).outcome).toMatchObject({ result: 'ok' });
    expect(counter(s, 'catan.games.restored_on_start')).toBe(1);
    expect(s.stateHash(g.roomCode)).toEqual({ seq: 3, stateHash: stateHash(g.state) });
  });
});

describe('boot: the lost path (design §5.9, F7, G3)', () => {
  it('a hash mismatch in an active game → expired(lost), lost_on_restart +1, game.lost and game.ended{from_state: active}; no transition', async () => {
    const dbPath = tempDb();
    const st = store(dbPath);
    const g = seed(st, 'active', 3);
    const ok = seed(st, 'active', 2);
    corruptEvent(dbPath, g.gameId, 2);
    const s = await boot(dbPath);

    expect(st.loadGame(g.gameId)!.meta).toMatchObject({ lifecycle: 'expired', endReason: 'lost', endedAt: BOOT_AT });
    expect(counter(s, 'catan.games.lost_on_restart')).toBe(1);
    expect(counter(s, 'catan.games.restored_on_start')).toBe(1);
    expect(s.telemetry.metrics()['catan.games.transitions']).toBeUndefined();
    expect(events(s, 'game.lost')).toEqual([
      expect.objectContaining({ severity_text: 'ERROR', game_id: g.gameId, seq: 2, expected: 'f'.repeat(64), actual: g.hashes[1] }),
    ]);
    expect(events(s, 'game.ended')).toEqual([
      expect.objectContaining({ game_id: g.gameId, outcome: 'lost', from_state: 'active', active_play_s: 90, wall_s: 3600, seed: 'secret-seed' }),
    ]);
    expect(events(s, 'server.started')).toEqual([expect.objectContaining({ games_restored: 1, lost_on_restart: 1 })]);
    // The lost game is gone for its players; the healthy one is untouched.
    expect(await hello(s.port, g.roomCode, g.tokens[0]!)).toEqual({ outcome: expect.objectContaining({ reasonCode: 'game_expired' }), close: 4410 });
    expect(s.stateHash(ok.roomCode)?.seq).toBe(2);
  });

  it.each([
    ['a missing snapshot', (dbPath: string, gameId: string) => {
      const st = openGameStore(dbPath);
      (st as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): void } } }).db.prepare('DELETE FROM snapshots WHERE game_id = ?').run(gameId);
      st.close();
    }],
    ['an unreadable snapshot', (dbPath: string, gameId: string) => {
      const st = openGameStore(dbPath);
      st.writeSnapshot(gameId, 0, '{"schemaVersion":99}', 'x'.repeat(64), ENGINE_VERSION, 1);
      st.close();
    }],
    ['a snapshot whose hash does not match', (dbPath: string, gameId: string) => {
      const st = openGameStore(dbPath);
      const snap = st.loadGame(gameId)!.snapshot!;
      st.writeSnapshot(gameId, 0, snap.stateJson, '0'.repeat(64), ENGINE_VERSION, 1);
      st.close();
    }],
  ])('%s → lost', async (_n, damage) => {
    const dbPath = tempDb();
    const g = seed(store(dbPath), 'active', 1);
    damage(dbPath, g.gameId);
    const s = await boot(dbPath);
    expect(counter(s, 'catan.games.lost_on_restart')).toBe(1);
    expect(events(s, 'game.lost')).toEqual([expect.objectContaining({ game_id: g.gameId })]);
  });

  it('an abandoned game takes the lost path lazily, on first hello: from_state abandoned, no transition, 4410', async () => {
    const dbPath = tempDb();
    const st = store(dbPath);
    const g = seed(st, 'abandoned', 3);
    corruptEvent(dbPath, g.gameId, 3);
    const s = await boot(dbPath);
    expect(counter(s, 'catan.games.lost_on_restart')).toBe(0);
    expect(await hello(s.port, g.roomCode, g.tokens[0]!)).toEqual({ outcome: expect.objectContaining({ reasonCode: 'game_expired' }), close: 4410 });
    expect(counter(s, 'catan.games.lost_on_restart')).toBe(1);
    expect(counter(s, 'catan.games.restored_on_start')).toBe(0);
    expect(s.telemetry.metrics()['catan.games.transitions']).toBeUndefined();
    expect(events(s, 'game.ended')).toEqual([expect.objectContaining({ game_id: g.gameId, outcome: 'lost', from_state: 'abandoned' })]);
    expect(st.loadGame(g.gameId)!.meta).toMatchObject({ lifecycle: 'expired', endReason: 'lost' });
  });
});
