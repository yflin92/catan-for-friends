// Room views and lobby ops read the games row and the seats table only (S-HARD c2): a hello's welcome, a lobby op and
// its room broadcast never load the whole game (snapshot + events).
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { startServer } from './server';
import { SqliteGameStore } from './store/sqlite';

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of cleanups.splice(0).reverse()) await c();
});

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

it('a hello welcome, a lobby op and its room broadcast run without loadGame', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hexlands-roomview-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const s = await startServer({ port: 0, dbPath: path.join(dir, 'db'), telemetry: 'memory' });
  cleanups.push(() => s.close());
  const { roomCode, seatToken } = await createRoom(s.port);
  const loadGame = vi.spyOn(SqliteGameStore.prototype, 'loadGame');

  const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws`);
  cleanups.push(() => ws.terminate());
  await new Promise((r, j) => ws.once('open', r).once('error', j));
  const frames: Record<string, unknown>[] = [];
  ws.on('message', (d) => frames.push(JSON.parse(String(d)) as Record<string, unknown>));
  const outcome = (actionId: string) =>
    new Promise<void>((r) => {
      const check = () => (frames.some((f) => f['t'] === 'outcome' && f['actionId'] === actionId) ? r() : setTimeout(check, 5));
      check();
    });
  ws.send(JSON.stringify({ t: 'hello', v: 1, roomCode, seatToken, actionId: '00000000-0000-4000-8000-000000000001' }));
  await outcome('00000000-0000-4000-8000-000000000001');
  ws.send(JSON.stringify({ t: 'lobby', op: { kind: 'setConfig', absencePolicy: { skipAfterSec: 90 } }, actionId: '00000000-0000-4000-8000-000000000002' }));
  await outcome('00000000-0000-4000-8000-000000000002');
  await new Promise((r) => setTimeout(r, 20));

  const welcome = frames.find((f) => f['t'] === 'welcome') as { room: { seats: { name: string | null }[] } };
  const room = frames.find((f) => f['t'] === 'room') as { room: { seats: { name: string | null }[] } };
  expect(welcome.room.seats[0]?.name).toBe('Ana');
  expect(room.room.seats[0]?.name).toBe('Ana');
  expect(loadGame).not.toHaveBeenCalled();
});
