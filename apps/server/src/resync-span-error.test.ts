// verify-Va #75 K6: a hello that ends in error/internal_error marks its catan.resync span ERROR.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { afterEach, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { startServer } from './server';
import { SqliteGameStore } from './store/sqlite';

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

it('hello → internal_error: catan.resync is status ERROR, result error, reason internal_error; no exception message', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vk6-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const s = await startServer({ port: 0, dbPath: path.join(dir, 'db'), telemetry: 'memory' });
  cleanups.push(() => s.close());
  const orig = SqliteGameStore.prototype.findByRoomCode;
  SqliteGameStore.prototype.findByRoomCode = function () { throw new Error('store down SECRETROOM'); };
  cleanups.push(() => { SqliteGameStore.prototype.findByRoomCode = orig; });
  const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws`); cleanups.push(() => ws.terminate());
  await new Promise((r, j) => ws.once('open', r).once('error', j));
  const out = await new Promise<Record<string, unknown>>((r) => { ws.on('message', (d) => { const m = JSON.parse(String(d)); if (m.t === 'outcome') r(m); }); ws.send(JSON.stringify({ t: 'hello', v: 1, roomCode: 'ABCDEF', actionId: '00000000-0000-4000-9000-000000000001' })); });
  const sp = s.telemetry.spans().filter((x) => x.name === 'catan.resync');
  console.log(JSON.stringify({ out, spans: sp.map((x) => ({ kind: x.kind, status: x.status, attrs: x.attributes, events: x.events.length })) }));
  expect(out).toMatchObject({ result: 'error', reasonCode: 'internal_error' });
  expect(sp).toHaveLength(1);
  expect(sp[0]!.kind).toBe(SpanKind.SERVER);
  expect(sp[0]!.status.code).toBe(SpanStatusCode.ERROR);
  expect(sp[0]!.attributes).toEqual({ 'catan.resync.trigger': 'hello', 'catan.result': 'error', 'catan.reason_code': 'internal_error' });
  expect(JSON.stringify([sp[0]!.attributes, sp[0]!.events, sp[0]!.status])).not.toContain('SECRETROOM');
});
