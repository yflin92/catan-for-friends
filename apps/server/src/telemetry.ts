// Telemetry facade (design §9, ADR-0009, TH10). It is the only recording point for metrics, spans and structured
// logs. Modes:
// - 'otlp': OTel SDK providers exporting over OTLP/HTTP to the Alloy sidecar (endpoint from OTEL_EXPORTER_OTLP_*);
//   logs are also written as JSON lines to stdout.
// - 'memory': in-memory span and log exporters plus a synchronous MetricSnapshot, read via metrics()/spans()/logs().
// - 'off': nothing is exported; logs are still written to stdout.
// Instrument definitions (names, labels, buckets) live with their owners; this module provides the primitives.
import { context, trace, type Tracer } from '@opentelemetry/api';
import { SeverityNumber, type Logger as OtelLogger } from '@opentelemetry/api-logs';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchLogRecordProcessor,
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
  type ReadableLogRecord,
} from '@opentelemetry/sdk-logs';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import type { Environment, TelemetryMode } from './config';

export type { ReadableLogRecord, ReadableSpan };

export const SERVICE_NAME = 'catan-server';
/** Stable across restarts so restarts create no new series (design §9.1). */
export const SERVICE_INSTANCE_ID = 'catan-1';

/** Synchronous view of every metric recorded through the facade ('memory' mode only). */
export type MetricSnapshot = Readonly<
  Record<
    string,
    {
      readonly type: 'counter' | 'updown' | 'gauge' | 'histogram';
      readonly points: readonly {
        readonly attributes: Readonly<Record<string, string>>;
        /** counter/updown: cumulative since start; gauge: current. */
        readonly value?: number;
        readonly count?: number;
        readonly sum?: number;
        /** counts.length = boundaries.length + 1; counts[i] holds values in (boundaries[i-1], boundaries[i]]. */
        readonly buckets?: { readonly boundaries: readonly number[]; readonly counts: readonly number[] };
      }[];
    }
  >
>;

export type MetricAttributes = Readonly<Record<string, string>>;

export interface InstrumentOptions {
  readonly description?: string;
  readonly unit?: string;
  /**
   * The closed label set: label name → allowed values. Attributes with an undeclared name are dropped, and a value
   * outside its list is recorded as 'other' (design §9.2). An instrument without labels records no attributes.
   */
  readonly labels?: Readonly<Record<string, readonly string[]>>;
}

export interface HistogramOptions extends InstrumentOptions {
  /** Explicit bucket boundaries, ascending (design §9.2). */
  readonly boundaries: readonly number[];
}

export interface Counter {
  add(value: number, attributes?: MetricAttributes): void;
}
export interface UpDownCounter {
  add(delta: number, attributes?: MetricAttributes): void;
}
export interface Histogram {
  record(value: number, attributes?: MetricAttributes): void;
}
export type GaugeCallback = () => readonly { readonly value: number; readonly attributes?: MetricAttributes }[];

export type LogSeverity = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';

export interface Telemetry {
  readonly mode: TelemetryMode;
  readonly tracer: Tracer;
  counter(name: string, opts?: InstrumentOptions): Counter;
  upDownCounter(name: string, opts?: InstrumentOptions): UpDownCounter;
  histogram(name: string, opts: HistogramOptions): Histogram;
  /** Registers an observable gauge. 'memory' mode evaluates the callback on every metrics() call. */
  observableGauge(name: string, opts: InstrumentOptions, callback: GaugeCallback): void;
  /**
   * Emits one structured event (design §9.5). The OTLP log body is JSON.stringify of the full record: the required
   * fields, trace_id/span_id when inside a span, and `fields`, with REDACTED_KEYS values replaced at any depth.
   */
  log(severity: LogSeverity, event: string, fields?: Readonly<Record<string, unknown>>): void;
  metrics(): MetricSnapshot;
  spans(): readonly ReadableSpan[];
  logs(): readonly ReadableLogRecord[];
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface TelemetryOptions {
  readonly mode: TelemetryMode;
  readonly environment: Environment;
  readonly serviceVersion: string;
  /** Destination of JSON log lines in 'otlp' and 'off' modes. Defaults to stdout. */
  readonly writeLine?: (line: string) => void;
}

const SEVERITY_NUMBER: Readonly<Record<LogSeverity, SeverityNumber>> = {
  DEBUG: SeverityNumber.DEBUG,
  INFO: SeverityNumber.INFO,
  WARN: SeverityNumber.WARN,
  ERROR: SeverityNumber.ERROR,
  FATAL: SeverityNumber.FATAL,
};

let contextManagerInstalled = false;
/** Active-span propagation for trace_id/span_id in logs; registered once per process. */
function ensureContextManager(): void {
  if (contextManagerInstalled) return;
  contextManagerInstalled = true;
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
}

export function createTelemetry(opts: TelemetryOptions): Telemetry {
  ensureContextManager();
  const resource = resourceFromAttributes({
    'service.name': SERVICE_NAME,
    'service.version': opts.serviceVersion,
    'deployment.environment': opts.environment,
    'service.instance.id': SERVICE_INSTANCE_ID,
    app: 'catan',
    env: opts.environment,
  });

  const spanExporter = opts.mode === 'memory' ? new InMemorySpanExporter() : null;
  const logExporter = opts.mode === 'memory' ? new InMemoryLogRecordExporter() : null;
  const tracerProvider = new BasicTracerProvider({
    resource,
    spanProcessors:
      opts.mode === 'memory' && spanExporter
        ? [new SimpleSpanProcessor(spanExporter)]
        : opts.mode === 'otlp'
          ? [new BatchSpanProcessor(new OTLPTraceExporter())]
          : [],
  });
  const loggerProvider = new LoggerProvider({
    resource,
    processors:
      opts.mode === 'memory' && logExporter
        ? [new SimpleLogRecordProcessor({ exporter: logExporter })]
        : opts.mode === 'otlp'
          ? [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })]
          : [],
  });
  const meterProvider = new MeterProvider({
    resource,
    readers:
      opts.mode === 'otlp'
        ? [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter(), exportIntervalMillis: 60_000 })]
        : [],
  });

  const tracer = tracerProvider.getTracer(SERVICE_NAME);
  const otelLogger: OtelLogger = loggerProvider.getLogger(SERVICE_NAME);
  const meter = meterProvider.getMeter(SERVICE_NAME);
  const snapshot = opts.mode === 'memory' ? new SnapshotStore() : null;
  const writeLine = opts.writeLine ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const registered = new Map<string, { type: InstrumentType; instrument: unknown }>();
  let kept: { spans: readonly ReadableSpan[]; logs: readonly ReadableLogRecord[] } | null = null;

  function register<T>(name: string, type: InstrumentType, make: () => T): T {
    const existing = registered.get(name);
    if (existing) {
      if (existing.type !== type) throw new Error(`metric ${name} is already registered as a ${existing.type}`);
      return existing.instrument as T;
    }
    const instrument = make();
    registered.set(name, { type, instrument });
    return instrument;
  }

  const otelOpts = (o: InstrumentOptions | undefined) => ({
    ...(o?.description !== undefined ? { description: o.description } : {}),
    ...(o?.unit !== undefined ? { unit: o.unit } : {}),
  });

  return {
    mode: opts.mode,
    tracer,

    counter(name, o) {
      return register(name, 'counter', () => {
        const c = meter.createCounter(name, otelOpts(o));
        return {
          add(value, attributes) {
            const attrs = closeLabels(o?.labels, attributes);
            c.add(value, attrs);
            snapshot?.add(name, 'counter', attrs, value);
          },
        } satisfies Counter;
      });
    },

    upDownCounter(name, o) {
      return register(name, 'updown', () => {
        const c = meter.createUpDownCounter(name, otelOpts(o));
        return {
          add(delta, attributes) {
            const attrs = closeLabels(o?.labels, attributes);
            c.add(delta, attrs);
            snapshot?.add(name, 'updown', attrs, delta);
          },
        } satisfies UpDownCounter;
      });
    },

    histogram(name, o) {
      return register(name, 'histogram', () => {
        const boundaries = [...o.boundaries];
        const h = meter.createHistogram(name, { ...otelOpts(o), advice: { explicitBucketBoundaries: boundaries } });
        return {
          record(value, attributes) {
            const attrs = closeLabels(o.labels, attributes);
            h.record(value, attrs);
            snapshot?.record(name, attrs, value, boundaries);
          },
        } satisfies Histogram;
      });
    },

    observableGauge(name, o, callback) {
      register(name, 'gauge', () => {
        const g = meter.createObservableGauge(name, otelOpts(o));
        const observe = () => callback().map((p) => ({ value: p.value, attributes: closeLabels(o.labels, p.attributes) }));
        g.addCallback((result) => {
          for (const p of observe()) result.observe(p.value, p.attributes);
        });
        snapshot?.addGauge(name, observe);
        return g;
      });
    },

    log(severity, event, fields) {
      const span = trace.getSpan(context.active())?.spanContext();
      const inSpan = span !== undefined && trace.isSpanContextValid(span);
      const record: Record<string, unknown> = {
        timestamp: new Date().toISOString(),
        severity_text: severity,
        event,
        service_name: SERVICE_NAME,
        service_version: opts.serviceVersion,
        environment: opts.environment,
        ...(inSpan ? { trace_id: span.traceId, span_id: span.spanId } : {}),
        ...fields,
      };
      const body = JSON.stringify(redact(record));
      otelLogger.emit({
        severityNumber: SEVERITY_NUMBER[severity],
        severityText: severity,
        body,
        attributes: { event },
        context: context.active(),
      });
      if (opts.mode !== 'memory') writeLine(body);
    },

    metrics: () => snapshot?.read() ?? {},
    spans: () => kept?.spans ?? spanExporter?.getFinishedSpans() ?? [],
    logs: () => kept?.logs ?? logExporter?.getFinishedLogRecords() ?? [],

    async forceFlush() {
      await Promise.all([tracerProvider.forceFlush(), loggerProvider.forceFlush(), meterProvider.forceFlush()]);
    },

    async shutdown() {
      // The in-memory exporters clear on shutdown; 'memory' mode keeps what it recorded readable afterwards.
      if (opts.mode === 'memory') kept ??= { spans: [...(spanExporter?.getFinishedSpans() ?? [])], logs: [...(logExporter?.getFinishedLogRecords() ?? [])] };
      await Promise.all([tracerProvider.shutdown(), loggerProvider.shutdown(), meterProvider.shutdown()]);
    },
  };
}

type InstrumentType = MetricSnapshot[string]['type'];

/** Log fields whose values are secrets (design §9.5, F16); replaced at any depth before a record is emitted. */
export const REDACTED_KEYS: ReadonlySet<string> = new Set(['roomCode', 'seatToken', 'token', 'passphrase']);

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = REDACTED_KEYS.has(k) ? '[Redacted]' : redact(v);
  return out;
}

/** Applies the closed label set of an instrument (see InstrumentOptions.labels). */
export function closeLabels(
  labels: Readonly<Record<string, readonly string[]>> | undefined,
  attributes: MetricAttributes | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!labels || !attributes) return out;
  for (const [key, value] of Object.entries(attributes)) {
    const allowed = labels[key];
    if (allowed === undefined) continue;
    out[key] = allowed.includes(value) ? value : 'other';
  }
  return out;
}

interface MutablePoint {
  attributes: Record<string, string>;
  value?: number;
  count?: number;
  sum?: number;
  buckets?: { boundaries: readonly number[]; counts: number[] };
}

/** Backing store of the 'memory' MetricSnapshot. */
class SnapshotStore {
  private readonly series = new Map<string, { type: InstrumentType; points: Map<string, MutablePoint> }>();
  private readonly gauges = new Map<string, () => readonly { value: number; attributes: Record<string, string> }[]>();

  add(name: string, type: 'counter' | 'updown', attributes: Record<string, string>, delta: number): void {
    const p = this.point(name, type, attributes);
    p.value = (p.value ?? 0) + delta;
  }

  record(name: string, attributes: Record<string, string>, value: number, boundaries: readonly number[]): void {
    const p = this.point(name, 'histogram', attributes);
    p.buckets ??= { boundaries, counts: new Array<number>(boundaries.length + 1).fill(0) };
    p.count = (p.count ?? 0) + 1;
    p.sum = (p.sum ?? 0) + value;
    const idx = boundaries.findIndex((b) => value <= b);
    const bucket = idx === -1 ? boundaries.length : idx;
    p.buckets.counts[bucket] = (p.buckets.counts[bucket] ?? 0) + 1;
  }

  addGauge(name: string, observe: () => readonly { value: number; attributes: Record<string, string> }[]): void {
    this.gauges.set(name, observe);
  }

  read(): MetricSnapshot {
    const out: Record<string, MetricSnapshot[string]> = {};
    for (const [name, s] of this.series) {
      out[name] = {
        type: s.type,
        points: [...s.points.values()].map((p) => ({
          attributes: { ...p.attributes },
          ...(p.value !== undefined ? { value: p.value } : {}),
          ...(p.count !== undefined ? { count: p.count } : {}),
          ...(p.sum !== undefined ? { sum: p.sum } : {}),
          ...(p.buckets ? { buckets: { boundaries: [...p.buckets.boundaries], counts: [...p.buckets.counts] } } : {}),
        })),
      };
    }
    for (const [name, observe] of this.gauges) {
      out[name] = { type: 'gauge', points: observe().map((p) => ({ attributes: { ...p.attributes }, value: p.value })) };
    }
    return out;
  }

  private point(name: string, type: InstrumentType, attributes: Record<string, string>): MutablePoint {
    let s = this.series.get(name);
    if (!s) {
      s = { type, points: new Map() };
      this.series.set(name, s);
    }
    const key = JSON.stringify(Object.entries(attributes).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    let p = s.points.get(key);
    if (!p) {
      p = { attributes };
      s.points.set(key, p);
    }
    return p;
  }
}
