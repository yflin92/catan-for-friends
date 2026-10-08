import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { roomViewSchemaStrict } from '@hexlands/protocol/testing';
import { ROOM_CODE_ALPHABET, hashSeatToken, mintRoomCode, mintSeatToken } from './codes';
import { normalizeDisplayName } from './names';
import { roomView } from './room-view';
import { startServer, type RunningServer, type ServerOptions } from './server';
import { RecordingSecrets } from './testing';

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function call(port: number, method: string, p: string, body?: string, headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
const create = (port: number, displayName: unknown, extra: Record<string, unknown> = {}) =>
  call(port, 'POST', '/api/rooms', JSON.stringify({ displayName, ...extra }), { 'Content-Type': 'application/json' });

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function boot(opts: Partial<ServerOptions> = {}, env: Record<string, string> = {}): Promise<RunningServer & { secrets: RecordingSecrets; dbFile: string }> {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  const dir = mkdtempSync(path.join(tmpdir(), 'hexlands-http-'));
  const dbFile = path.join(dir, 'db.sqlite');
  const secrets = new RecordingSecrets();
  try {
    const s = await startServer({ port: 0, dbPath: dbFile, telemetry: 'memory', secrets, buildVersion: 'v-test', ...opts });
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => s.close());
    return Object.assign(s, { secrets, dbFile });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function openStore(file: string) {
  const { openGameStore } = await import('./store/sqlite');
  const s = openGameStore(file);
  cleanups.push(() => s.close());
  return s;
}

describe('POST /api/rooms (AC1, design §5.1(1))', () => {
  it('creates a lobby with the host in seat 0 and returns the secrets only in the body', async () => {
    const s = await boot();
    const res = await create(s.port, '  Ana ');
    expect(res.status).toBe(201);
    const body = JSON.parse(res.body) as { roomCode: string; seatToken: string; seat: number };
    expect(Object.keys(body).sort()).toEqual(['roomCode', 'seat', 'seatToken']);
    expect(body.seat).toBe(0);
    expect(body.roomCode).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/);
    expect(body.seatToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(body.seatToken, 'base64url')).toHaveLength(32);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.headers['cache-control']).toBe('no-store');

    const store = await openStore(s.dbFile);
    const meta = store.findByRoomCode(body.roomCode);
    expect(meta).toMatchObject({ lifecycle: 'lobby', hostSeat: 0, headSeq: 0 });
    expect(store.findSeatByTokenHash(createHash('sha256').update(body.seatToken).digest())).toEqual({ gameId: meta?.id, seat: 0 });
    expect(store.loadGame(meta!.id)?.seats).toEqual([expect.objectContaining({ seat: 0, displayName: 'Ana' })]);

    expect(s.secrets.valuesOf('roomCode')).toEqual([body.roomCode]);
    expect(s.secrets.valuesOf('seatToken')).toEqual([body.seatToken]);
    const created = s.telemetry.logs().map((r) => JSON.parse(r.body as string) as Record<string, unknown>).find((e) => e['event'] === 'game.created');
    expect(created).toMatchObject({ game_id: meta?.id, player_slots: 4 });
    const logText = s.telemetry.logs().map((r) => String(r.body)).join('\n');
    expect(logText).not.toContain(body.roomCode);
    expect(logText).not.toContain(body.seatToken);
    expect(s.telemetry.metrics()['catan.rooms.creates']?.points).toEqual([{ attributes: { result: 'ok' }, value: 1 }]);
    expect(s.telemetry.metrics()['catan.games']?.points).toContainEqual({ attributes: { state: 'lobby' }, value: 1 });
  });

  it('never stores the raw token', async () => {
    const s = await boot();
    const body = JSON.parse((await create(s.port, 'Ana')).body) as { seatToken: string };
    await s.close();
    const { readFileSync, readdirSync } = await import('node:fs');
    const dir = path.dirname(s.dbFile);
    const bytes = readdirSync(dir).map((f) => readFileSync(path.join(dir, f)).toString('latin1')).join('');
    expect(bytes).not.toContain(body.seatToken);
  });

  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['21 characters', 'x'.repeat(21)],
    ['control character', 'An\u0007a'],
    ['newline', 'An\na'],
  ])('rejects an invalid name (%s) with 400 invalid_name', async (_n, name) => {
    const s = await boot();
    const res = await create(s.port, name);
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ reasonCode: 'invalid_name' });
  });

  it('accepts 20 characters after NFC normalisation and trimming', async () => {
    const s = await boot();
    const decomposed = 'é'.repeat(20);
    expect((await create(s.port, ` ${decomposed} `)).status).toBe(201);
  });

  const JSON_CT = 'application/json';
  it.each([
    ['wrong content type', '{"displayName":"Ana"}', 'text/plain'],
    ['bad JSON', '{', JSON_CT],
    ['unknown key', '{"displayName":"Ana","x":1}', JSON_CT],
    ['non-string name', '{"displayName":5}', JSON_CT],
    ['oversized body', JSON.stringify({ displayName: 'x'.repeat(5000) }), JSON_CT],
  ])('rejects %s with 400 malformed_action', async (_n, body, contentType) => {
    const s = await boot();
    const res = await call(s.port, 'POST', '/api/rooms', body, { 'Content-Type': contentType });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ reasonCode: 'malformed_action' });
  });

  it('caps lobby + active games at rooms.maxActiveGames; abandoned games do not count', async () => {
    const s = await boot({ config: { rooms: { maxActiveGames: 2 } } });
    const a = JSON.parse((await create(s.port, 'A')).body) as { roomCode: string };
    expect((await create(s.port, 'B')).status).toBe(201);
    const full = await create(s.port, 'C');
    expect(full.status).toBe(409);
    expect(JSON.parse(full.body)).toEqual({ reasonCode: 'capacity_reached' });
    expect(s.telemetry.metrics()['catan.rooms.creates']?.points).toContainEqual({ attributes: { result: 'capacity_reached' }, value: 1 });
    const store = await openStore(s.dbFile);
    const id = store.findByRoomCode(a.roomCode)!.id;
    store.updateMeta(id, { lifecycle: 'active' });
    expect((await create(s.port, 'C')).status).toBe(409);
    store.updateMeta(id, { lifecycle: 'abandoned' });
    expect((await create(s.port, 'C')).status).toBe(201);
    store.updateMeta(id, { lifecycle: 'expired' });
    expect((await create(s.port, 'D')).status).toBe(409);
  });

  it('only accepts POST', async () => {
    const s = await boot();
    expect((await call(s.port, 'GET', '/api/rooms')).status).toBe(405);
    expect((await call(s.port, 'GET', '/api/nothing')).status).toBe(404);
  });
});

describe('GET /healthz (design §9.6)', () => {
  it('returns 200 with the version and the documented body shape', async () => {
    const s = await boot();
    await create(s.port, 'Ana');
    const res = await call(s.port, 'GET', '/healthz');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      status: 'ok',
      version: 'v-test',
      uptime_s: expect.any(Number),
      draining: false,
      games: { lobby: 1, active: 0, abandoned: 0 },
      players_connected: 0,
      last_persist_ok_s_ago: null,
      abandonment_job_last_success_s_ago: null,
    });
    expect(res.headers['x-robots-tag']).toBe('noindex');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });
});

describe('static assets and headers (design §8)', () => {
  it('serves the bundle with noindex, no-referrer and the CSP, and refuses traversal', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hexlands-static-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Hexlands</title>');
    mkdirSync(path.join(dir, 'assets'));
    writeFileSync(path.join(dir, 'assets', 'app.js'), 'console.log(1)');
    writeFileSync(path.join(path.dirname(dir), 'secret.txt'), 'nope');
    const s = await boot({}, { HEXLANDS_STATIC_DIR: dir });
    const html = await call(s.port, 'GET', '/', undefined, { Host: 'hexlands.example' });
    expect(html.status).toBe(200);
    expect(html.body).toContain('Hexlands');
    expect(html.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(html.headers['content-security-policy']).toBe(
      "default-src 'self'; connect-src 'self' wss://hexlands.example; img-src 'self' data:",
    );
    expect(html.headers['x-robots-tag']).toBe('noindex');
    expect(html.headers['referrer-policy']).toBe('no-referrer');
    expect(html.headers['set-cookie']).toBeUndefined();
    const js = await call(s.port, 'GET', '/assets/app.js');
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect((await call(s.port, 'GET', '/../secret.txt')).status).toBe(404);
    expect((await call(s.port, 'GET', '/%2e%2e/secret.txt')).status).toBe(404);
    expect((await call(s.port, 'GET', '/missing.js')).status).toBe(404);
    expect((await call(s.port, 'GET', '/%E0%A4%A')).status).toBe(400);
  });

  it('serves nothing when no bundle directory is configured', async () => {
    const s = await boot();
    const res = await call(s.port, 'GET', '/');
    expect(res.status).toBe(404);
    expect(res.headers['x-robots-tag']).toBe('noindex');
  });
});

describe('codes, tokens and names', () => {
  it('room codes use only the 32-symbol alphabet at the configured length (30 bits at 6)', () => {
    expect(ROOM_CODE_ALPHABET).toHaveLength(32);
    expect(new Set(ROOM_CODE_ALPHABET).size).toBe(32);
    expect(ROOM_CODE_ALPHABET).not.toMatch(/[01OI]/);
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const c = mintRoomCode(6);
      expect(c).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/);
      seen.add(c);
    }
    expect(seen.size).toBeGreaterThan(1990);
    expect(6 * Math.log2(32)).toBe(30);
  });

  it('seat tokens are 32 random bytes in base64url and hash to SHA-256', () => {
    const t = mintSeatToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(mintSeatToken()).not.toBe(t);
    expect(hashSeatToken(t)).toEqual(createHash('sha256').update(t).digest());
  });

  it('normalises display names', () => {
    expect(normalizeDisplayName('  Bo  ')).toBe('Bo');
    expect(normalizeDisplayName('é')).toBe('é');
    expect(normalizeDisplayName('<img src=x onerror=>')).toBe('<img src=x onerror=>');
    expect(normalizeDisplayName('x'.repeat(20))).toBe('x'.repeat(20));
    expect(normalizeDisplayName('​')).toBe('​');
  });
});

describe('room view (D6 buildVersion)', () => {
  it('carries the server build version and validates against the strict room schema', async () => {
    const s = await boot();
    const { roomCode } = JSON.parse((await create(s.port, 'Ana')).body) as { roomCode: string };
    const store = await openStore(s.dbFile);
    const meta = store.findByRoomCode(roomCode)!;
    const view = roomView(meta, store.loadGame(meta.id)!.seats, { connected: () => true }, 'v-test');
    expect(view.buildVersion).toBe('v-test');
    expect(view.seats).toEqual([
      { seat: 0, name: 'Ana', connected: true },
      { seat: 1, name: null, connected: false },
      { seat: 2, name: null, connected: false },
      { seat: 3, name: null, connected: false },
    ]);
    expect(roomViewSchemaStrict.safeParse(JSON.parse(JSON.stringify(view))).success).toBe(true);
  });
});
