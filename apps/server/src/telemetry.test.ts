import { describe, expect, it, vi } from 'vitest';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { closeLabels, createTelemetry, withRootSpan, withRootSpanAsync } from './telemetry';

const memory = () => createTelemetry({ mode: 'memory', environment: 'dev', serviceVersion: 'abc123' });

describe('telemetry facade (TH10, ruling G1)', () => {
  it('records counters and up-down counters cumulatively per closed label set', async () => {
    const t = memory();
    const c = t.counter('catan.actions', { labels: { result: ['ok', 'rule', 'turn', 'auth', 'error'] } });
    c.add(1, { result: 'ok' });
    c.add(2, { result: 'ok' });
    c.add(1, { result: 'bogus', game_id: 'g-1' });
    const u = t.upDownCounter('catan.ws.open');
    u.add(2);
    u.add(-1);
    const m = t.metrics();
    expect(m['catan.actions']).toEqual({
      type: 'counter',
      points: [
        { attributes: { result: 'ok' }, value: 3 },
        { attributes: { result: 'other' }, value: 1 },
      ],
    });
    expect(m['catan.ws.open']).toEqual({ type: 'updown', points: [{ attributes: {}, value: 1 }] });
    await t.shutdown();
  });

  it('buckets histograms on the given boundaries, (prev, b] per bucket plus overflow', async () => {
    const t = memory();
    const h = t.histogram('catan.action.duration', { unit: 's', boundaries: [0.05, 0.3, 5] });
    for (const v of [0.01, 0.05, 0.2, 1, 10]) h.record(v);
    const p = t.metrics()['catan.action.duration']?.points[0];
    expect(p?.count).toBe(5);
    expect(p?.sum).toBeCloseTo(11.26);
    expect(p?.buckets).toEqual({ boundaries: [0.05, 0.3, 5], counts: [2, 1, 1, 1] });
    await t.shutdown();
  });

  it('evaluates observable gauges when metrics() is called', async () => {
    const t = memory();
    let games = 1;
    t.observableGauge('catan.games', { labels: { state: ['lobby', 'active', 'abandoned'] } }, () => [
      { value: games, attributes: { state: 'active' } },
    ]);
    expect(t.metrics()['catan.games']).toEqual({ type: 'gauge', points: [{ attributes: { state: 'active' }, value: 1 }] });
    games = 4;
    expect(t.metrics()['catan.games']?.points[0]?.value).toBe(4);
    await t.shutdown();
  });

  it('returns the same instrument for the same name and refuses a type clash', async () => {
    const t = memory();
    expect(t.counter('x')).toBe(t.counter('x'));
    expect(() => t.histogram('x', { boundaries: [1] })).toThrow(/already registered/);
    await t.shutdown();
  });

  it('captures finished spans', async () => {
    const t = memory();
    t.tracer.startActiveSpan('catan.action', (span) => span.end());
    expect(t.spans().map((s) => s.name)).toEqual(['catan.action']);
    await t.shutdown();
  });

  it('withRootSpan: a root span even inside another span; it returns the result and ends', async () => {
    const t = memory();
    const out = t.tracer.startActiveSpan('outer', (outer) => {
      const v = withRootSpan(t.tracer, 'server.boot', SpanKind.INTERNAL, { 'catan.x': 1 }, () => 42);
      outer.end();
      return v;
    });
    expect(out).toBe(42);
    const inner = t.spans().find((s) => s.name === 'server.boot')!;
    expect(inner.parentSpanContext).toBeUndefined();
    expect(inner.kind).toBe(SpanKind.INTERNAL);
    expect(inner.attributes).toEqual({ 'catan.x': 1 });
    expect(inner.status.code).toBe(SpanStatusCode.UNSET);
    await t.shutdown();
  });

  it('withRootSpan: a throw or a rejection sets ERROR, adds an exception event with the type only, ends, and propagates', async () => {
    const t = memory();
    const secret = 'ABCDEF tok_secret';
    expect(() =>
      withRootSpan(t.tracer, 'catan.resync', SpanKind.SERVER, {}, () => {
        throw new TypeError(secret);
      }),
    ).toThrow(secret);
    await expect(withRootSpanAsync(t.tracer, 'server.drain', SpanKind.INTERNAL, {}, async () => Promise.reject(new RangeError(secret)))).rejects.toThrow(secret);
    const [sync, async_] = t.spans();
    for (const [span, type] of [[sync!, 'TypeError'], [async_!, 'RangeError']] as const) {
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.events.map((e) => [e.name, e.attributes])).toEqual([['exception', { 'exception.type': type }]]);
      expect(JSON.stringify([span.attributes, span.events, span.status])).not.toContain('secret');
    }
    await t.shutdown();
  });

  it('emits log records whose body is the full JSON event, with trace context inside a span', async () => {
    const t = memory();
    t.log('WARN', 'server.test_hooks_ignored');
    t.tracer.startActiveSpan('catan.action', (span) => {
      t.log('INFO', 'action.rejected', { game_id: 'g-1', reason_code: 'not_your_turn' });
      span.end();
    });
    const [outside, inside] = t.logs();
    const a = JSON.parse(outside?.body as string) as Record<string, unknown>;
    expect(a).toMatchObject({
      severity_text: 'WARN',
      event: 'server.test_hooks_ignored',
      service_name: 'catan-server',
      service_version: 'abc123',
      environment: 'dev',
    });
    expect(typeof a['timestamp']).toBe('string');
    expect(a).not.toHaveProperty('trace_id');
    expect(outside?.severityText).toBe('WARN');
    const b = JSON.parse(inside?.body as string) as Record<string, unknown>;
    const span = t.spans()[0]!;
    expect(b).toMatchObject({
      event: 'action.rejected',
      game_id: 'g-1',
      reason_code: 'not_your_turn',
      trace_id: span.spanContext().traceId,
      span_id: span.spanContext().spanId,
    });
    await t.shutdown();
  });

  it("returns empty accessors in 'off' mode and writes logs as JSON lines instead", async () => {
    const lines: string[] = [];
    const t = createTelemetry({ mode: 'off', environment: 'dev', serviceVersion: 'v', writeLine: (l) => lines.push(l) });
    t.counter('catan.actions').add(1);
    t.tracer.startActiveSpan('s', (s) => s.end());
    t.log('INFO', 'server.started');
    expect(t.metrics()).toEqual({});
    expect(t.spans()).toEqual([]);
    expect(t.logs()).toEqual([]);
    expect(JSON.parse(lines[0]!)).toMatchObject({ event: 'server.started', severity_text: 'INFO' });
    await t.shutdown();
  });

  // Without Grafana the deploy runs with HEXLANDS_TELEMETRY=off (design D32b), and the container's stdout (docker logs)
  // is then the only record: 'off' must write the redacted JSON lines there by default and attempt no export.
  it("'off' mode writes redacted JSON log lines to stdout by default and never exports", async () => {
    const written: string[] = [];
    const saved = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'http://127.0.0.1:1';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
    try {
      const t = createTelemetry({ mode: 'off', environment: 'prod', serviceVersion: 'v-off' });
      t.counter('catan.actions').add(1);
      t.log('INFO', 'server.started', { games_restored: 0, lost_on_restart: 0, previous_shutdown: 'clean' });
      t.log('INFO', 'room.create_rejected', { reason: 'bad_passphrase', passphrase: 'SENTINEL-off-pass' });
      await t.shutdown();
    } finally {
      spy.mockRestore();
      if (saved === undefined) delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
      else process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = saved;
    }
    const lines = written
      .join('')
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toContainEqual(
      expect.objectContaining({ event: 'server.started', severity_text: 'INFO', service_version: 'v-off', environment: 'prod', previous_shutdown: 'clean' }),
    );
    expect(lines).toContainEqual(expect.objectContaining({ event: 'room.create_rejected', passphrase: '[Redacted]' }));
    expect(written.join('')).not.toContain('SENTINEL-off-pass');
    // No exporter exists in 'off' mode, so no export can fail and log a telemetry.* warning.
    expect(lines.filter((l) => String(l['event']).startsWith('telemetry.'))).toEqual([]);
  });

  it('closeLabels keeps only declared label names and maps unknown values to other', () => {
    expect(closeLabels({ result: ['ok'] }, { result: 'ok', seat: '2' })).toEqual({ result: 'ok' });
    expect(closeLabels({ result: ['ok'] }, { result: 'nope' })).toEqual({ result: 'other' });
    expect(closeLabels(undefined, { result: 'ok' })).toEqual({});
  });
});
