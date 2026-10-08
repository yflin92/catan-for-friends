import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_GAME_CONFIG, ENGINE_VERSION, createGame, serializeState, stateHash } from '@hexlands/engine';
import { serverMsgSchemaStrict } from '@hexlands/protocol/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { hashSeatToken } from './codes';
import { normalizeRoomCode, requireHost } from './hello';
import { startServer, type RunningServer, type ServerOptions } from './server';
import { openGameStore, type SqliteGameStore } from './store/sqlite';
import { createTelemetry } from './telemetry';
import { RecordingSecrets } from './testing';
import type { Connection } from './ws-gateway';

const ID = '3b241101-e2bb-4255-8caf-4136c566a962';
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function boot(opts: Partial<ServerOptions> = {}): Promise<{ s: RunningServer; store: SqliteGameStore; secrets: RecordingSecrets }> {
  const dir = mkdtempSync(path.join(tmpdir(), 'hexlands-hello-'));
  const secrets = new RecordingSecrets();
  const s = await startServer({ port: 0, dbPath: path.join(dir, 'db'), telemetry: 'memory', secrets, buildVersion: 'v-hello', ...opts });
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

interface Session {
  frames: Record<string, unknown>[];
  code: number | null;
}
/** Sends one hello and collects every frame until the outcome (plus the close code if the server closes). */
async function hello(port: number, fields: Record<string, unknown>): Promise<Session> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  cleanups.push(() => ws.terminate());
  const frames: Record<string, unknown>[] = [];
  const session: Session = { frames, code: null };
  const closed = new Promise<void>((r) => ws.on('close', (code) => ((session.code = code), r())));
  await new Promise((r, j) => ws.once('open', r).once('error', j));
  const gotOutcome = new Promise<void>((r) =>
    ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as Record<string, unknown>;
      frames.push(m);
      if (m['t'] === 'outcome') r();
    }),
  );
  ws.send(JSON.stringify({ t: 'hello', v: 1, actionId: ID, ...fields }));
  await gotOutcome;
  await Promise.race([closed, new Promise((r) => setTimeout(r, 100))]);
  return session;
}

describe('hello (design §5.1(2), AC26)', () => {
  it('welcomes the host with seat 0 and the room, then sends ok', async () => {
    const { s } = await boot();
    const { roomCode, seatToken } = await createRoom(s.port);
    const { frames, code } = await hello(s.port, { roomCode, seatToken });
    expect(frames.map((f) => f['t'])).toEqual(['welcome', 'outcome']);
    expect(frames[0]).toMatchObject({ v: 1, seat: 0, isHost: true, seq: 0, view: null });
    expect((frames[0]?.['room'] as Record<string, unknown>)['buildVersion']).toBe('v-hello');
    expect((frames[0]?.['room'] as { seats: unknown[] }).seats[0]).toEqual({ seat: 0, name: 'Ana', connected: true });
    expect(frames[1]).toEqual({ t: 'outcome', actionId: ID, result: 'ok' });
    for (const f of frames) expect(serverMsgSchemaStrict.safeParse(f).success).toBe(true);
    expect(code).toBeNull();
  });

  it('accepts the code as shown (ABC-DEF) and in lower case', async () => {
    const { s } = await boot();
    const { roomCode } = await createRoom(s.port);
    const shown = `${roomCode.slice(0, 3)}-${roomCode.slice(3)}`.toLowerCase();
    expect((await hello(s.port, { roomCode: shown })).frames.at(-1)).toMatchObject({ result: 'ok' });
  });

  it('welcomes a visitor without a token as seat null with the room and no view', async () => {
    const { s, store } = await boot();
    const { roomCode } = await createRoom(s.port);
    const lobby = await hello(s.port, { roomCode });
    expect(lobby.frames[0]).toMatchObject({ t: 'welcome', seat: null, isHost: false, view: null });
    const gameId = store.findByRoomCode(roomCode)!.id;
    const created = createGame({ config: DEFAULT_GAME_CONFIG.rules, playerCount: 3, seed: 'visitor' });
    if (!created.ok) throw new Error('createGame failed');
    store.writeSnapshot(gameId, 0, serializeState(created.state), stateHash(created.state), ENGINE_VERSION, 0);
    store.updateMeta(gameId, { lifecycle: 'active' });
    const started = await hello(s.port, { roomCode });
    expect(started.frames[0]).toMatchObject({ t: 'welcome', seat: null, isHost: false, view: null });
    expect(started.frames.at(-1)).toMatchObject({ result: 'ok' });
  });

  it('answers an unknown room with auth/unknown_room and close 4401, sending no room data', async () => {
    const { s } = await boot();
    const { frames, code } = await hello(s.port, { roomCode: 'ZZZZZZ' });
    expect(frames).toEqual([{ t: 'outcome', actionId: ID, result: 'auth', reasonCode: 'unknown_room' }]);
    expect(code).toBe(4401);
  });

  it('counts unknown rooms against the IP and then answers auth/rate_limited_auth', async () => {
    const { s } = await boot({ config: { rooms: { failedCodeAttemptsPerIpPerMin: 2 } } });
    // Created first: once the client is locked out, POST /api/rooms is refused too (D15).
    const { roomCode } = await createRoom(s.port);
    await hello(s.port, { roomCode: 'ZZZZZZ' });
    await hello(s.port, { roomCode: 'ZZZZZY' });
    const { frames, code } = await hello(s.port, { roomCode });
    expect(frames).toEqual([{ t: 'outcome', actionId: ID, result: 'auth', reasonCode: 'rate_limited_auth' }]);
    expect(code).toBe(4401);
  });

  it('answers an expired room with rule/game_expired and close 4410; so does its tombstone; then it is unknown', async () => {
    const { s, store } = await boot();
    const { roomCode } = await createRoom(s.port);
    const id = store.findByRoomCode(roomCode)!.id;
    store.updateMeta(id, { lifecycle: 'expired' });
    const expired = await hello(s.port, { roomCode });
    expect(expired.frames).toEqual([{ t: 'outcome', actionId: ID, result: 'rule', reasonCode: 'game_expired' }]);
    expect(expired.code).toBe(4410);
    store.purgeGame(id, Date.now() + 60_000);
    const tombstoned = await hello(s.port, { roomCode });
    expect(tombstoned.frames).toEqual([{ t: 'outcome', actionId: ID, result: 'rule', reasonCode: 'game_expired' }]);
    expect(tombstoned.code).toBe(4410);
    store.clearEndedTombstones(Date.now() + 60_000);
    expect((await hello(s.port, { roomCode })).frames[0]).toMatchObject({ reasonCode: 'unknown_room' });
  });

  it.each([
    ['an unknown token', 'bad_seat_token'],
    ['a token of another room', 'token_room_mismatch'],
    ['a revoked token', 'seat_token_revoked'],
    ['a token revoked in another room', 'token_room_mismatch'],
  ] as const)('answers %s with auth/%s and close 4401, sending no room data', async (kind, reasonCode) => {
    const { s, store } = await boot();
    const a = await createRoom(s.port, 'Ana');
    const b = await createRoom(s.port, 'Bo');
    let token = 'x'.repeat(43);
    if (kind === 'a token of another room') token = b.seatToken;
    if (kind === 'a revoked token') {
      store.revokeToken(store.findByRoomCode(a.roomCode)!.id, hashSeatToken(a.seatToken), 1);
      token = a.seatToken;
    }
    if (kind === 'a token revoked in another room') {
      store.revokeToken(store.findByRoomCode(b.roomCode)!.id, hashSeatToken(b.seatToken), 1);
      token = b.seatToken;
    }
    const { frames, code } = await hello(s.port, { roomCode: a.roomCode, seatToken: token });
    expect(frames).toEqual([{ t: 'outcome', actionId: ID, result: 'auth', reasonCode }]);
    expect(code).toBe(4401);
    expect(s.telemetry.metrics()['catan.actions']?.points).toContainEqual({ attributes: { result: 'auth' }, value: 1 });
    expect(s.telemetry.metrics()['catan.ws.reconnects']?.points).toEqual([{ attributes: { outcome: 'failed_auth' }, value: 1 }]);
  });

  it('never logs room codes or tokens', async () => {
    const { s, secrets } = await boot();
    const { roomCode, seatToken } = await createRoom(s.port);
    await hello(s.port, { roomCode, seatToken });
    await hello(s.port, { roomCode, seatToken: 'y'.repeat(43) });
    await hello(s.port, { roomCode: 'QQQQQQ' });
    const text = s.telemetry.logs().map((r) => String(r.body)).join('\n');
    for (const v of secrets.valuesOf()) expect(text).not.toContain(v);
  });

  it('does not count successful hellos as actions', async () => {
    const { s } = await boot();
    const { roomCode, seatToken } = await createRoom(s.port);
    await hello(s.port, { roomCode, seatToken });
    expect(s.telemetry.metrics()['catan.actions']).toBeUndefined();
  });
});

describe('helpers', () => {
  it('normalizes room codes', () => {
    expect(normalizeRoomCode(' abc-def ')).toBe('ABCDEF');
  });

  it('requireHost allows only the host seat of that game', () => {
    const meta = { id: 'g', hostSeat: 1 } as Parameters<typeof requireHost>[1];
    const conn = (binding: Connection['binding']) => ({ binding }) as Connection;
    expect(requireHost(conn({ gameId: 'g', seat: 1 }), meta)).toBeNull();
    expect(requireHost(conn({ gameId: 'g', seat: 0 }), meta)).toEqual({ result: 'auth', reasonCode: 'not_host' });
    expect(requireHost(conn({ gameId: 'h', seat: 1 }), meta)).toEqual({ result: 'auth', reasonCode: 'not_host' });
    expect(requireHost(conn({ gameId: 'g', seat: null }), meta)).toEqual({ result: 'auth', reasonCode: 'not_host' });
    expect(requireHost(conn(null), meta)).toEqual({ result: 'auth', reasonCode: 'not_host' });
  });

  it('redacts secret-named log fields at any depth', async () => {
    const t = createTelemetry({ mode: 'memory', environment: 'dev', serviceVersion: 'v' });
    t.log('INFO', 'x', { roomCode: 'ABCDEF', nested: { seatToken: 'tok', list: [{ token: 't', passphrase: 'p' }] }, ok: 1 });
    const body = JSON.parse(t.logs()[0]!.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      roomCode: '[Redacted]',
      nested: { seatToken: '[Redacted]', list: [{ token: '[Redacted]', passphrase: '[Redacted]' }] },
      ok: 1,
    });
    await t.shutdown();
  });
});
