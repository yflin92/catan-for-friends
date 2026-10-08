// Zero-initialised alerting counters (alerts A1, A3, A4, A7). Prometheus increase() reads 0 for a
// series whose first sample is already 1, so every alerting series must exist at 0 before its first event, and the
// boot-time events (server.starts, lost_on_restart) must be exported only after those zeros.
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ALERTING_ZERO_SERIES, CATALOGUE } from './metrics';
import { startServer, type RunningServer } from './server';

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

describe('alerting counters start at 0', () => {
  it('before any event, every alerting series is present at 0 (server.starts: this start at 1, the other kind at 0)', async () => {
    const s = await startServer({ port: 0, dbPath: dbPath(), telemetry: 'memory' });
    cleanups.push(() => s.close());
    const catalogue = CATALOGUE as Record<string, { name: string }>;
    for (const [key, combos] of ALERTING_ZERO_SERIES) {
      for (const attrs of combos) {
        const p = point(s, catalogue[key]!.name, attrs);
        expect(p, `${catalogue[key]!.name} ${JSON.stringify(attrs)}`).toBeDefined();
        if (key === 'serverStarts') continue;
        expect(p!.value, `${catalogue[key]!.name} ${JSON.stringify(attrs)}`).toBe(0);
      }
    }
    // A fresh database has no shutdown marker, so this start is 'unclean'.
    expect(point(s, 'catan.server.starts', { shutdown: 'unclean' })!.value).toBe(1);
    expect(point(s, 'catan.server.starts', { shutdown: 'clean' })!.value).toBe(0);
    // The listed series cover A1 (errors, internal_error, 5xx), A3 (lost_on_restart, unclean starts), A4 (job runs)
    // and A7 (rooms.creates rejections).
    const names = ALERTING_ZERO_SERIES.flatMap(([key, combos]) => combos.map((c) => `${catalogue[key]!.name}${JSON.stringify(c)}`));
    expect(names).toEqual(
      expect.arrayContaining([
        'catan.errors{"component":"telemetry"}',
        'catan.actions.rejected{"reason_code":"internal_error"}',
        'catan.http.responses_5xx{}',
        'catan.games.lost_on_restart{}',
        'catan.server.starts{"shutdown":"unclean"}',
        'catan.job.abandonment.runs{"result":"error"}',
        'catan.rooms.creates{"result":"capacity_reached"}',
        'catan.rooms.creates{"result":"rate_limited"}',
        'catan.rooms.creates{"result":"rate_limited_auth"}',
      ]),
    );
  });

  it('the first event after start reads as an increase of 1 (the series was already exported at 0)', async () => {
    const s = await startServer({ port: 0, dbPath: dbPath(), telemetry: 'memory' });
    cleanups.push(() => s.close());
    const before = point(s, 'catan.job.abandonment.runs', { result: 'ok' })!.value!;
    s.runAbandonmentJob();
    expect(point(s, 'catan.job.abandonment.runs', { result: 'ok' })!.value! - before).toBe(1);
  });
});

// ── OTLP export order: the zeros reach the collector before the boot events ─────────────────────────────────────────

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

describe('OTLP export order at boot', () => {
  it('the first metrics export carries server.starts and lost_on_restart at 0; a later one carries the boot events', async () => {
    const exports: Exported[][] = [];
    const collector: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        if (req.url === '/v1/metrics') exports.push(parseMetrics(Buffer.concat(chunks).toString('utf8')));
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
      });
    });
    await new Promise<void>((r) => collector.listen(0, '127.0.0.1', r));
    cleanups.push(() => new Promise((r) => collector.close(() => r(undefined))));
    const saved = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = `http://127.0.0.1:${(collector.address() as AddressInfo).port}`;
    cleanups.push(() => {
      if (saved === undefined) delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
      else process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = saved;
    });
    const s = await startServer({ port: 0, dbPath: dbPath(), telemetry: 'otlp' });
    await s.close();

    const find = (batch: Exported[], name: string, attrs: Record<string, string> = {}) =>
      batch.find((e) => e.name === name && JSON.stringify(e.attrs) === JSON.stringify(attrs));
    expect(exports.length).toBeGreaterThanOrEqual(2);
    const first = exports[0]!;
    expect(find(first, 'catan.server.starts', { shutdown: 'unclean' })?.value).toBe(0);
    expect(find(first, 'catan.server.starts', { shutdown: 'clean' })?.value).toBe(0);
    expect(find(first, 'catan.games.lost_on_restart')?.value).toBe(0);
    expect(find(first, 'catan.errors', { component: 'engine' })?.value).toBe(0);
    const last = exports.at(-1)!;
    expect(find(last, 'catan.server.starts', { shutdown: 'unclean' })?.value).toBe(1);
  });
});
