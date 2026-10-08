// Restart-safe counters. Prometheus increase() takes a series' first sample as its baseline, so a counter series that
// is first exported already carrying events loses them, and a series that continues across a restart counts the
// post-boot events only when the restart reads as a counter reset. Every counter series therefore starts at 0 and that
// 0 is exported before the listener opens: the boot events and the reconnect burst after a restart always come after
// an exported 0. The NFR6 gap SLI is read from two counters (reports, within_target), since a histogram cannot be
// exported empty.
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { ClientTelemetry, RESUME_GAP_TARGET_MS } from './client-telemetry';
import { FakeClock } from './clock';
import { CATALOGUE, ZERO_INIT_SERIES, seriesOf } from './metrics';
import { startServer, type RunningServer } from './server';
import { createTelemetry } from './telemetry';
import type { Connection } from './ws-gateway';

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function dbPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'hexlands-zero-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'db');
}

const point = (s: RunningServer, name: string, attrs: Record<string, string>) =>
  s.telemetry.metrics()[name]?.points.find((p) => Object.entries(attrs).every(([k, v]) => p.attributes[k] === v) && Object.keys(p.attributes).length === Object.keys(attrs).length);

const catalogue = CATALOGUE as Record<string, { name: string }>;
/** Every zero-initialised series as name + attributes. */
const zeroSeries = ZERO_INIT_SERIES.flatMap(([key, combos]) => combos.map((attrs) => ({ name: catalogue[key]!.name, attrs })));

describe('every counter starts at 0', () => {
  it('covers every synchronous counter of the catalogue with every label combination (the budgeted counter series)', () => {
    expect(ZERO_INIT_SERIES.map(([key]) => catalogue[key]!.name).sort()).toEqual(
      [
        'catan.actions',
        'catan.actions.rejected',
        'catan.errors',
        'catan.http.responses_5xx',
        'catan.rooms.creates',
        'catan.player.connected_seconds',
        'catan.ws.disconnects',
        'catan.ws.reconnects',
        'catan.ws.resume_gap.reports',
        'catan.ws.resume_gap.within_target',
        'catan.games.transitions',
        'catan.games.active_play_seconds',
        'catan.games.lost_on_restart',
        'catan.games.restored_on_start',
        'catan.server.starts',
        'catan.job.abandonment.runs',
        'catan.client.errors',
        'catan.telemetry.dropped',
      ].sort(),
    );
    for (const [key, combos] of ZERO_INIT_SERIES) expect(combos.length, catalogue[key]!.name).toBe(seriesOf(CATALOGUE[key]));
    expect(ZERO_INIT_SERIES.find(([key]) => key === 'gamesTransitions')![1]).toHaveLength(7);
  });

  it('before any event, every counter series is present at 0 (server.starts: this start at 1, the other kind at 0)', async () => {
    const s = await startServer({ port: 0, dbPath: dbPath(), telemetry: 'memory' });
    cleanups.push(() => s.close());
    for (const { name, attrs } of zeroSeries) {
      const p = point(s, name, attrs);
      expect(p, `${name} ${JSON.stringify(attrs)}`).toBeDefined();
      if (name === 'catan.server.starts') continue;
      expect(p!.value, `${name} ${JSON.stringify(attrs)}`).toBe(0);
    }
    // A fresh database has no shutdown marker, so this start is 'unclean'.
    expect(point(s, 'catan.server.starts', { shutdown: 'unclean' })!.value).toBe(1);
    expect(point(s, 'catan.server.starts', { shutdown: 'clean' })!.value).toBe(0);
  });

  it('the first event after start reads as an increase of 1 (the series was already exported at 0)', async () => {
    const s = await startServer({ port: 0, dbPath: dbPath(), telemetry: 'memory' });
    cleanups.push(() => s.close());
    const before = point(s, 'catan.job.abandonment.runs', { result: 'ok' })!.value!;
    s.runAbandonmentJob();
    expect(point(s, 'catan.job.abandonment.runs', { result: 'ok' })!.value! - before).toBe(1);
  });
});

describe('NFR6 gap SLI counters (D30)', () => {
  function ingest(gaps: readonly { ms: number; cause: 'network' | 'server_restart' }[]) {
    const telemetry = createTelemetry({ mode: 'memory', environment: 'dev', serviceVersion: 'v' });
    cleanups.push(() => telemetry.shutdown());
    const clock = new FakeClock(0);
    const conn = { id: 1, binding: null } as unknown as Connection;
    const ct = new ClientTelemetry(telemetry, clock);
    for (const g of gaps) {
      ct.ingest(conn, { t: 'telemetry', resumeGaps: [g] });
      clock.advance(60_000);
    }
    const value = (name: string, cause: string) =>
      telemetry.metrics()[name]?.points.find((p) => p.attributes['cause'] === cause)?.value ?? 0;
    return { reports: (c: string) => value('catan.ws.resume_gap.reports', c), within: (c: string) => value('catan.ws.resume_gap.within_target', c) };
  }

  it('every reported gap counts in reports; within_target counts only gaps strictly below 5000 ms', () => {
    expect(RESUME_GAP_TARGET_MS).toBe(5_000);
    const one = ingest([{ ms: 4_999, cause: 'network' }]);
    expect([one.reports('network'), one.within('network')]).toEqual([1, 1]);
    const two = ingest([{ ms: 5_000, cause: 'network' }]);
    expect([two.reports('network'), two.within('network')]).toEqual([1, 0]);
    const mixed = ingest([
      { ms: 0, cause: 'server_restart' },
      { ms: 12_000, cause: 'server_restart' },
      { ms: 4_999, cause: 'network' },
    ]);
    expect([mixed.reports('server_restart'), mixed.within('server_restart')]).toEqual([2, 1]);
    expect([mixed.reports('network'), mixed.within('network')]).toEqual([1, 1]);
  });
});

// ── OTLP: the zeros are exported before the listener opens ───────────────────────────────────────────────────────

interface Exported {
  readonly name: string;
  readonly attrs: Record<string, string>;
  readonly value: number;
}

function parseMetrics(body: string): Exported[] {
  const out: Exported[] = [];
  const doc = JSON.parse(body) as {
    resourceMetrics?: { scopeMetrics?: { metrics?: { name: string; sum?: { dataPoints?: unknown[] } }[] }[] }[];
  };
  for (const rm of doc.resourceMetrics ?? []) {
    for (const sm of rm.scopeMetrics ?? []) {
      for (const m of sm.metrics ?? []) {
        for (const dp of (m.sum?.dataPoints ?? []) as { attributes?: { key: string; value: { stringValue?: string } }[]; asInt?: string | number; asDouble?: number }[]) {
          const attrs = Object.fromEntries((dp.attributes ?? []).map((a) => [a.key, a.value.stringValue ?? '']));
          out.push({ name: m.name, attrs, value: Number(dp.asInt ?? dp.asDouble ?? 0) });
        }
      }
    }
  }
  return out;
}

/** A fake OTLP/HTTP collector; OTEL_EXPORTER_OTLP_ENDPOINT points at it until the test ends. Returns its exports. */
async function collector(): Promise<Exported[][]> {
  const exports: Exported[][] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.url === '/v1/metrics') exports.push(parseMetrics(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise((r) => server.close(() => r(undefined))));
  const saved = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
  process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(() => {
    if (saved === undefined) delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
    else process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = saved;
  });
  return exports;
}

const find = (batch: readonly Exported[], name: string, attrs: Record<string, string> = {}) =>
  batch.find((e) => e.name === name && JSON.stringify(e.attrs) === JSON.stringify(attrs));

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

/** One seated hello; resolves with its outcome once the socket is closed again. */
async function hello(port: number, roomCode: string, seatToken: string): Promise<Record<string, unknown>> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  cleanups.push(() => ws.terminate());
  await new Promise((r, j) => ws.once('open', r).once('error', j));
  const outcome = new Promise<Record<string, unknown>>((r) =>
    ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as Record<string, unknown>;
      if (m['t'] === 'outcome') r(m);
    }),
  );
  ws.send(JSON.stringify({ t: 'hello', v: 1, actionId: '00000000-0000-4000-9000-000000000001', roomCode, seatToken }));
  const out = await outcome;
  const closed = new Promise((r) => ws.once('close', r));
  ws.close(1000);
  await closed;
  return out;
}

describe('OTLP export order at boot', () => {
  it('the first metrics export carries every counter series at 0, before the boot events', async () => {
    const exports = await collector();
    const s = await startServer({ port: 0, dbPath: dbPath(), telemetry: 'otlp' });
    await s.close();
    expect(exports.length).toBeGreaterThanOrEqual(2);
    const first = exports[0]!;
    for (const { name, attrs } of zeroSeries) expect(find(first, name, attrs)?.value, `${name} ${JSON.stringify(attrs)}`).toBe(0);
    expect(find(exports.at(-1)!, 'catan.server.starts', { shutdown: 'unclean' })?.value).toBe(1);
  });

  it('after each restart, N reconnects read as an increase of N: the 0 is exported before the listener accepts them', async () => {
    const db = dbPath();
    const seats: { roomCode: string; seatToken: string }[] = [];
    // First boot (no exporter): three seats, each bound once, so a later hello with its token is a reconnect.
    const s0 = await startServer({ port: 0, dbPath: db, telemetry: 'memory' });
    for (let i = 0; i < 3; i++) {
      const seat = await createRoom(s0.port);
      expect(await hello(s0.port, seat.roomCode, seat.seatToken)).toMatchObject({ result: 'ok' });
      seats.push(seat);
    }
    await s0.close();

    const exports = await collector();
    // Two restarts with the same burst size (N2 ≥ N1, the case Prometheus sees only through counter-reset detection).
    for (const n of [3, 3]) {
      const from = exports.length;
      const s = await startServer({ port: 0, dbPath: db, telemetry: 'otlp' });
      // startServer resolves once the listener is open; the boot export has already arrived, with the zero.
      expect(exports.length).toBeGreaterThan(from);
      const baseline = find(exports[from]!, 'catan.ws.reconnects', { outcome: 'resumed' })!.value;
      expect(baseline).toBe(0);
      for (const seat of seats.slice(0, n)) expect(await hello(s.port, seat.roomCode, seat.seatToken)).toMatchObject({ result: 'ok' });
      await s.close();
      const last = exports.at(-1)!;
      expect(find(last, 'catan.ws.reconnects', { outcome: 'resumed' })!.value - baseline).toBe(n);
    }
  });
});
