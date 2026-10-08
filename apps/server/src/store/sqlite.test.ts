import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DEFAULT_GAME_CONFIG, type Command } from '@hexlands/engine';
import { afterEach, describe, expect, it } from 'vitest';
import type { NewEvent } from './game-store';
import { SCHEMA_VERSION, SeqGapError, openGameStore, type SqliteGameStore } from './sqlite';

const tokenHash = (t: string) => createHash('sha256').update(t).digest();
const roll: Command = { by: 0, action: { type: 'rollDice' } };
const skip: Command = { by: 'system', action: { type: 'skipSeat', seat: 2, reason: 'host' } };

const stores: SqliteGameStore[] = [];
const dirs: string[] = [];
function mem(): SqliteGameStore {
  const s = openGameStore(':memory:');
  stores.push(s);
  return s;
}
function tmpFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'hexlands-store-'));
  dirs.push(dir);
  return path.join(dir, 'hexlands.db');
}
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function room(s: SqliteGameStore, id = 'g1', code = 'ABCDEF', at = 1_000): void {
  s.createRoom({ id, roomCode: code, config: DEFAULT_GAME_CONFIG, hostSeat: 0, createdAt: at });
}
function ev(seq: number, over: Partial<NewEvent> = {}): NewEvent {
  return {
    gameId: 'g1',
    seq,
    actionId: `a-${seq}`,
    payloadHash: `p-${seq}`,
    by: 0,
    command: roll,
    hashAfter: `h-${seq}`,
    at: 10_000 + seq,
    ...over,
  };
}

describe('schema and pragmas (design §4)', () => {
  it('opens a file database in WAL mode with synchronous=FULL and foreign keys on', () => {
    const file = tmpFile();
    const s = openGameStore(file);
    stores.push(s);
    const raw = new Database(file, { readonly: true });
    expect(raw.pragma('journal_mode', { simple: true })).toBe('wal');
    raw.close();
    const db = (s as unknown as { db: Database.Database }).db;
    expect(db.pragma('synchronous', { simple: true })).toBe(2);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('creates exactly the §4 tables and records schema_version', () => {
    const s = mem();
    const db = (s as unknown as { db: Database.Database }).db;
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as { name: string }[]).map((t) => t.name);
    expect(tables).toEqual(['events', 'games', 'revoked_tokens', 'seats', 'server_meta', 'snapshots']);
    expect(db.prepare(`SELECT value FROM server_meta WHERE key='schema_version'`).get()).toEqual({ value: String(SCHEMA_VERSION) });
  });

  it('reopens an existing database without re-migrating and keeps the data', () => {
    const file = tmpFile();
    const a = openGameStore(file);
    room(a);
    a.appendEvent(ev(1));
    a.close();
    const b = openGameStore(file);
    stores.push(b);
    expect(b.loadGame('g1')?.meta.headSeq).toBe(1);
  });

  it('refuses a database written by a newer schema', () => {
    const file = tmpFile();
    openGameStore(file).close();
    const raw = new Database(file);
    raw.prepare(`UPDATE server_meta SET value = '99' WHERE key = 'schema_version'`).run();
    raw.close();
    expect(() => openGameStore(file)).toThrow(/schema_version 99/);
  });
});

describe('games rows', () => {
  it('creates a lobby row and finds it by room code and lifecycle', () => {
    const s = mem();
    room(s);
    const g = s.findByRoomCode('ABCDEF');
    expect(g).toMatchObject({
      id: 'g1',
      lifecycle: 'lobby',
      hostSeat: 0,
      headSeq: 0,
      roomRev: 0,
      createdAt: 1_000,
      lastLobbyActivityAt: 1_000,
      lastActionAt: null,
      allDisconnectedSince: null,
      activePlayMs: 0,
      endReason: null,
    });
    expect(g?.config).toEqual(DEFAULT_GAME_CONFIG);
    expect(s.findByRoomCode('ZZZZZZ')).toBeNull();
    expect(s.listGames(['lobby']).map((r) => r.id)).toEqual(['g1']);
    expect(s.listGames(['active'])).toEqual([]);
    expect(s.listGames([])).toEqual([]);
  });

  it('rejects a duplicate room code', () => {
    const s = mem();
    room(s);
    expect(() => room(s, 'g2', 'ABCDEF')).toThrow();
  });

  it('updateMeta patches columns (config as JSON) and refuses immutable or unknown ones', () => {
    const s = mem();
    room(s);
    const config = { ...DEFAULT_GAME_CONFIG, rules: { ...DEFAULT_GAME_CONFIG.rules, vpTarget: 12 } };
    s.updateMeta('g1', { lifecycle: 'active', startedAt: 2_000, seed: 'seed', roomRev: 3, config, abandonReason: null });
    expect(s.findByRoomCode('ABCDEF')).toMatchObject({ lifecycle: 'active', startedAt: 2_000, seed: 'seed', roomRev: 3 });
    expect(s.findByRoomCode('ABCDEF')?.config.rules.vpTarget).toBe(12);
    expect(() => s.updateMeta('g1', { headSeq: 9 })).toThrow(/headSeq/);
    expect(() => s.updateMeta('g1', { id: 'x' })).toThrow(/id/);
    expect(() => s.updateMeta('g1', { bogus: 1 } as never)).toThrow(/unknown column/);
    expect(() => s.updateMeta('g1', { lifecycle: 'paused' as never })).toThrow();
  });
});

describe('seats and tokens (ADR-0006)', () => {
  it('finds a seat by token hash, across games, and replaces a seat on upsert', () => {
    const s = mem();
    room(s);
    room(s, 'g2', 'BCDEFG');
    s.upsertSeat('g1', 0, 'Ana', tokenHash('t0'), 1);
    s.upsertSeat('g2', 1, 'Bo', tokenHash('t1'), 2);
    expect(s.findSeatByTokenHash(tokenHash('t0'))).toEqual({ gameId: 'g1', seat: 0 });
    expect(s.findSeatByTokenHash(tokenHash('t1'))).toEqual({ gameId: 'g2', seat: 1 });
    expect(s.findSeatByTokenHash(tokenHash('nope'))).toBeNull();
    s.upsertSeat('g1', 0, 'Ana B', tokenHash('t0'), 3);
    expect(s.loadGame('g1')?.seats).toEqual([{ seat: 0, displayName: 'Ana B', claimedAt: 3 }]);
  });

  it('keeps token hashes globally unique', () => {
    const s = mem();
    room(s);
    s.upsertSeat('g1', 0, 'Ana', tokenHash('t0'), 1);
    expect(() => s.upsertSeat('g1', 1, 'Bo', tokenHash('t0'), 1)).toThrow();
  });

  it('revokeToken frees the seat and reports the revoking game afterwards', () => {
    const s = mem();
    room(s);
    s.upsertSeat('g1', 2, 'Cy', tokenHash('t2'), 1);
    s.revokeToken('g1', tokenHash('t2'), 5);
    expect(s.findSeatByTokenHash(tokenHash('t2'))).toEqual({ revokedIn: 'g1' });
    expect(s.loadGame('g1')?.seats).toEqual([]);
    s.revokeToken('g1', tokenHash('t2'), 6);
    s.upsertSeat('g1', 2, 'Cy', tokenHash('t2-new'), 7);
    expect(s.findSeatByTokenHash(tokenHash('t2-new'))).toEqual({ gameId: 'g1', seat: 2 });
  });
});

describe('renameSeat, renumberSeats, seatTokenHash (D9)', () => {
  it('renames without touching the token', () => {
    const s = mem();
    room(s);
    s.upsertSeat('g1', 0, 'Ana', tokenHash('t0'), 1);
    s.renameSeat('g1', 0, 'Anna');
    expect(s.loadGame('g1')?.seats).toEqual([{ seat: 0, displayName: 'Anna', claimedAt: 1 }]);
    expect(s.findSeatByTokenHash(tokenHash('t0'))).toEqual({ gameId: 'g1', seat: 0 });
  });

  it('moves occupants (name, token, claim time) to their new index in one transaction; host follows; nothing revoked', () => {
    const s = mem();
    room(s);
    s.upsertSeat('g1', 0, 'Ana', tokenHash('t0'), 10);
    s.upsertSeat('g1', 2, 'Cy', tokenHash('t2'), 12);
    s.renumberSeats('g1', [2, 3, 0, 1]);
    expect(s.loadGame('g1')?.seats).toEqual([
      { seat: 0, displayName: 'Cy', claimedAt: 12 },
      { seat: 2, displayName: 'Ana', claimedAt: 10 },
    ]);
    expect(s.findSeatByTokenHash(tokenHash('t0'))).toEqual({ gameId: 'g1', seat: 2 });
    expect(s.findSeatByTokenHash(tokenHash('t2'))).toEqual({ gameId: 'g1', seat: 0 });
    expect(s.loadGame('g1')?.meta.hostSeat).toBe(2);
    expect(s.seatTokenHash('g1', 2)).toEqual(tokenHash('t0'));
    expect(s.seatTokenHash('g1', 1)).toBeNull();
    const db = (s as unknown as { db: Database.Database }).db;
    expect(db.prepare(`SELECT COUNT(*) AS n FROM revoked_tokens`).get()).toEqual({ n: 0 });
  });

  it('refuses an order that is not a permutation of 0..3', () => {
    const s = mem();
    room(s);
    for (const bad of [[0, 1, 2], [0, 0, 1, 2], [0, 1, 2, 4]]) expect(() => s.renumberSeats('g1', bad as never)).toThrow();
  });
});

describe('appendEvent: the commit transaction (ADR-0005)', () => {
  it('inserts the event and advances head_seq and last_action_at together', () => {
    const s = mem();
    room(s);
    s.appendEvent(ev(1));
    s.appendEvent(ev(2, { actionId: null, payloadHash: null, by: 'system', command: skip }));
    const g = s.loadGame('g1');
    expect(g?.meta.headSeq).toBe(2);
    expect(g?.meta.lastActionAt).toBe(10_002);
    expect(g?.events).toEqual([
      { seq: 1, actionId: 'a-1', payloadHash: 'p-1', by: 0, command: roll, hashAfter: 'h-1', committedAt: 10_001 },
      { seq: 2, actionId: null, payloadHash: null, by: 'system', command: skip, hashAfter: 'h-2', committedAt: 10_002 },
    ]);
  });

  it('refuses a gap or a repeated seq and commits nothing', () => {
    const s = mem();
    room(s);
    s.appendEvent(ev(1));
    expect(() => s.appendEvent(ev(3))).toThrow(SeqGapError);
    expect(() => s.appendEvent(ev(1, { actionId: 'other' }))).toThrow();
    const g = s.loadGame('g1');
    expect(g?.meta.headSeq).toBe(1);
    expect(g?.events.map((e) => e.seq)).toEqual([1]);
  });

  it('refuses a second commit of the same actionId (AC21) and leaves head_seq alone', () => {
    const s = mem();
    room(s);
    s.appendEvent(ev(1, { actionId: 'dup' }));
    expect(() => s.appendEvent(ev(2, { actionId: 'dup' }))).toThrow(/UNIQUE/);
    expect(s.loadGame('g1')?.meta.headSeq).toBe(1);
    expect(s.findCommitted('g1', 'dup')).toEqual({ seq: 1, payloadHash: 'p-1' });
    expect(s.findCommitted('g1', 'never')).toBeNull();
    room(s, 'g2', 'BCDEFG');
    expect(() => s.appendEvent(ev(1, { gameId: 'g2', actionId: 'dup' }))).not.toThrow();
  });

  it('refuses an event for an unknown game (foreign key)', () => {
    const s = mem();
    expect(() => s.appendEvent(ev(1, { gameId: 'missing' }))).toThrow();
  });

  it('survives reopening the file (durable before ack)', () => {
    const file = tmpFile();
    const a = openGameStore(file);
    room(a);
    a.appendEvent(ev(1));
    a.close();
    const b = openGameStore(file);
    stores.push(b);
    expect(b.findCommitted('g1', 'a-1')).toEqual({ seq: 1, payloadHash: 'p-1' });
  });
});

describe('snapshots and loadGame', () => {
  it('keeps the latest 2 snapshots and loads the latest plus the events after it', () => {
    const s = mem();
    room(s);
    s.writeSnapshot('g1', 0, '{"s":0}', 'h0', 'e1', 1);
    for (let i = 1; i <= 5; i++) s.appendEvent(ev(i));
    s.writeSnapshot('g1', 2, '{"s":2}', 'h2', 'e1', 2);
    s.writeSnapshot('g1', 4, '{"s":4}', 'h4', 'e1', 3);
    const db = (s as unknown as { db: Database.Database }).db;
    expect((db.prepare(`SELECT seq FROM snapshots WHERE game_id='g1' ORDER BY seq`).all() as { seq: number }[]).map((r) => r.seq)).toEqual([2, 4]);
    const g = s.loadGame('g1');
    expect(g?.snapshot).toEqual({ seq: 4, stateJson: '{"s":4}', stateHash: 'h4', engineVersion: 'e1', createdAt: 3 });
    expect(g?.events.map((e) => e.seq)).toEqual([5]);
  });

  it('rewrites a snapshot at the same seq and loads every event when there is no snapshot', () => {
    const s = mem();
    room(s);
    s.appendEvent(ev(1));
    expect(s.loadGame('g1')?.snapshot).toBeNull();
    expect(s.loadGame('g1')?.events).toHaveLength(1);
    s.writeSnapshot('g1', 1, 'a', 'h', 'e1', 1);
    s.writeSnapshot('g1', 1, 'b', 'h', 'e1', 2);
    expect(s.loadGame('g1')?.snapshot?.stateJson).toBe('b');
    expect(s.loadGame('nope')).toBeNull();
  });
});

describe('shutdown marker and retention', () => {
  it('takeShutdownMarker reads and clears', () => {
    const s = mem();
    expect(s.takeShutdownMarker()).toBeNull();
    s.writeShutdownMarker(123);
    s.writeShutdownMarker(456);
    expect(s.takeShutdownMarker()).toBe(456);
    expect(s.takeShutdownMarker()).toBeNull();
  });

  it('purgeGame deletes events, snapshots and seats, nulls the room code and keeps the games row', () => {
    const s = mem();
    room(s);
    room(s, 'g2', 'BCDEFG');
    s.upsertSeat('g1', 0, 'Ana', tokenHash('t0'), 1);
    s.upsertSeat('g2', 0, 'Bo', tokenHash('u0'), 1);
    s.appendEvent(ev(1));
    s.writeSnapshot('g1', 1, '{}', 'h', 'e1', 1);
    s.updateMeta('g1', { lifecycle: 'expired', endReason: 'abandoned_expired', endedAt: 9 });
    s.purgeGame('g1');
    const g = s.loadGame('g1');
    expect(g?.meta).toMatchObject({ id: 'g1', roomCode: null, lifecycle: 'expired', headSeq: 1 });
    expect(g?.seats).toEqual([]);
    expect(g?.snapshot).toBeNull();
    expect(g?.events).toEqual([]);
    expect(s.findByRoomCode('ABCDEF')).toBeNull();
    expect(s.findSeatByTokenHash(tokenHash('t0'))).toBeNull();
    expect(s.loadGame('g2')?.seats).toHaveLength(1);
  });

  it('close is idempotent', () => {
    const s = openGameStore(':memory:');
    s.close();
    expect(() => s.close()).not.toThrow();
  });
});
