// The metric catalogue (design §9.2, ADR-0009): every app instrument with its kind, unit, closed label sets and bucket
// boundaries, in one place. Owners record through serverMetrics(telemetry) and register gauges with registerGauge, so
// names and labels cannot drift between call sites. Labels are closed enums only (no game, player, seat, room, action
// or trace ids); a value outside its list is recorded as 'other' by the telemetry facade.
//
// Worst-case series (AC33, E10) = Σ over instruments of (label combinations × (histogram ? boundaries + 3 : 1)), plus
// the runtime reservation. Label combinations are the product of the label value counts, or the edge count for
// catan.games.transitions. Only reason_code declares 'other' as a value (design §9.2 counts 44 + other); the other
// labels are fed from typed enums.
import { ReasonCode } from '@hexlands/engine';
import { CLIENT_ERROR_KINDS, DISCONNECT_REASONS, RECONNECT_OUTCOMES, RESUME_GAP_CAUSES } from '@hexlands/protocol';
import type { Counter, GaugeCallback, Histogram, Telemetry } from './telemetry';

export type InstrumentKind = 'counter' | 'updown' | 'histogram' | 'gauge';

export interface InstrumentSpec {
  readonly name: string;
  readonly kind: InstrumentKind;
  readonly unit?: string;
  readonly description: string;
  readonly labels?: Readonly<Record<string, readonly string[]>>;
  readonly boundaries?: readonly number[];
  /** When set, the only label combinations ever recorded (catan.games.transitions). */
  readonly edges?: readonly (readonly [string, string])[];
}

const RESULTS = ['ok', 'rule', 'turn', 'auth', 'error'] as const;
const DURATION_S = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1] as const;
const RTT_S = [0.025, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 1, 2, 5] as const;

/** The 7 valid lifecycle edges (design §9.2); none→lobby is a room creation. */
export const TRANSITION_EDGES = [
  ['none', 'lobby'],
  ['lobby', 'active'],
  ['lobby', 'expired'],
  ['active', 'abandoned'],
  ['abandoned', 'active'],
  ['active', 'finished'],
  ['abandoned', 'expired'],
] as const satisfies readonly (readonly [string, string])[];

export type TransitionEdge = (typeof TRANSITION_EDGES)[number];

/** The only label keys an app instrument may use (design §9.2); none of them carries an id. */
export const ALLOWED_LABEL_KEYS: ReadonlySet<string> = new Set([
  'result',
  'reason_code',
  'component',
  'reason',
  'outcome',
  'cause',
  'state',
  'from',
  'to',
  'op',
  'shutdown',
  'kind',
]);

/** Series reserved for the runtime whitelist gauges (design §9.2: ≤ 15). */
export const RUNTIME_SERIES_RESERVED = 15;

export const CATALOGUE = {
  actionDuration: {
    name: 'catan.action.duration',
    kind: 'histogram',
    unit: 's',
    description: 'receipt of an action, lobby or control message to its outcome (one per catan.action span)',
    labels: { result: RESULTS },
    boundaries: DURATION_S,
  },
  actions: {
    name: 'catan.actions',
    kind: 'counter',
    description: 'outcomes of action, lobby and control messages, and failed hellos',
    labels: { result: RESULTS },
  },
  actionsRejected: {
    name: 'catan.actions.rejected',
    kind: 'counter',
    description: 'every non-ok outcome counted by catan.actions, error class included, by reason code',
    labels: { reason_code: [...Object.keys(ReasonCode), 'other'] },
  },
  errors: {
    name: 'catan.errors',
    kind: 'counter',
    description: 'unhandled exceptions and faults by component; never incremented by drain 503s',
    labels: { component: ['ws', 'engine', 'persist', 'http', 'job', 'telemetry'] },
  },
  http5xx: { name: 'catan.http.responses_5xx', kind: 'counter', description: 'non-drain HTTP 5xx responses' },
  roomsCreates: {
    name: 'catan.rooms.creates',
    kind: 'counter',
    description: 'POST /api/rooms results',
    labels: { result: ['ok', 'capacity_reached', 'rate_limited', 'rate_limited_auth', 'bad_passphrase'] },
  },
  wsRtt: { name: 'catan.ws.rtt', kind: 'histogram', unit: 's', description: 'server ping → pong', boundaries: RTT_S },
  wsDelivery: {
    name: 'catan.ws.delivery.duration',
    kind: 'histogram',
    unit: 's',
    description: 'commit of seq N → client ack N, per recipient',
    boundaries: RTT_S,
  },
  clientActionRtt: {
    name: 'catan.client.action_rtt',
    kind: 'histogram',
    unit: 's',
    description: 'client-measured submit → outcome, same-connection samples only (NFR2 verdict SLI)',
    boundaries: RTT_S,
  },
  wsConnections: { name: 'catan.ws.connections', kind: 'gauge', description: 'open WebSocket connections' },
  playersConnected: { name: 'catan.players.connected', kind: 'gauge', description: 'seated players with an open socket' },
  playerConnectedSeconds: {
    name: 'catan.player.connected_seconds',
    kind: 'counter',
    description: 'seated-player connected time in seconds (NFR5 denominator)',
  },
  wsDisconnects: {
    name: 'catan.ws.disconnects',
    kind: 'counter',
    description: 'seated-socket disconnects by reason',
    labels: { reason: DISCONNECT_REASONS },
  },
  wsReconnects: {
    name: 'catan.ws.reconnects',
    kind: 'counter',
    description: 'reconnect attempts by outcome',
    labels: { outcome: RECONNECT_OUTCOMES },
  },
  wsResumeGap: {
    name: 'catan.ws.resume_gap',
    kind: 'histogram',
    unit: 's',
    description: 'client-reported resume gaps (visible + online time)',
    labels: { cause: RESUME_GAP_CAUSES },
    boundaries: [0.5, 1, 2, 3, 5, 10, 30, 60, 300],
  },
  games: {
    name: 'catan.games',
    kind: 'gauge',
    description: 'non-terminal games by lifecycle state',
    labels: { state: ['lobby', 'active', 'abandoned'] },
  },
  gamesTransitions: {
    name: 'catan.games.transitions',
    kind: 'counter',
    description: 'lifecycle transitions (the 7 valid edges; never for games lost on restart)',
    labels: {
      from: ['none', 'lobby', 'active', 'abandoned'],
      to: ['lobby', 'active', 'expired', 'abandoned', 'finished'],
    },
    edges: TRANSITION_EDGES,
  },
  gamesActivePlaySeconds: {
    name: 'catan.games.active_play_seconds',
    kind: 'counter',
    description: 'active play time across games, in seconds',
  },
  gameActivePlay: {
    name: 'catan.game.active_play',
    kind: 'histogram',
    unit: 's',
    description: 'active play time of a finished game',
    boundaries: [600, 1200, 1800, 2700, 3600, 5400, 7200, 10800, 14400],
  },
  persistDuration: {
    name: 'catan.persist.duration',
    kind: 'histogram',
    unit: 's',
    description: 'GameStore writes by operation',
    labels: { op: ['append', 'snapshot', 'flush'] },
    boundaries: [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 1],
  },
  gamesLostOnRestart: { name: 'catan.games.lost_on_restart', kind: 'counter', description: 'games that could not be restored' },
  gamesRestoredOnStart: { name: 'catan.games.restored_on_start', kind: 'counter', description: 'games restored at boot' },
  serverStarts: {
    name: 'catan.server.starts',
    kind: 'counter',
    description: 'server starts by previous shutdown kind',
    labels: { shutdown: ['clean', 'unclean'] },
  },
  jobRuns: {
    name: 'catan.job.abandonment.runs',
    kind: 'counter',
    description: 'abandonment job runs',
    labels: { result: ['ok', 'error'] },
  },
  jobDuration: {
    name: 'catan.job.abandonment.duration',
    kind: 'histogram',
    unit: 's',
    description: 'abandonment job run time',
    boundaries: DURATION_S,
  },
  jobLastSuccess: {
    name: 'catan.job.abandonment.last_success',
    kind: 'gauge',
    unit: 's',
    description: 'unix time of the last successful abandonment job run',
  },
  clientErrors: {
    name: 'catan.client.errors',
    kind: 'counter',
    description: 'client-reported errors by kind',
    labels: { kind: CLIENT_ERROR_KINDS },
  },
  telemetryDropped: { name: 'catan.telemetry.dropped', kind: 'counter', description: 'client telemetry batches or samples dropped' },
  diskFreeBytes: {
    name: 'catan.disk.free_bytes',
    kind: 'gauge',
    unit: 'By',
    description: 'free bytes on the data volume (statfs every 60 s)',
  },
} as const satisfies Readonly<Record<string, InstrumentSpec>>;

export type CatalogueKey = keyof typeof CATALOGUE;

/** Every catalogue instrument, in declaration order. */
export const INSTRUMENTS: readonly InstrumentSpec[] = Object.values(CATALOGUE);

/** Worst-case series of one instrument. */
export function seriesOf(spec: InstrumentSpec): number {
  const combos = spec.edges
    ? spec.edges.length
    : Object.values(spec.labels ?? {}).reduce((n, values) => n * values.length, 1);
  return combos * (spec.kind === 'histogram' ? (spec.boundaries?.length ?? 0) + 3 : 1);
}

/** Worst-case app series: every catalogue instrument plus the runtime reservation. */
export function worstCaseSeries(): number {
  return INSTRUMENTS.reduce((n, s) => n + seriesOf(s), 0) + RUNTIME_SERIES_RESERVED;
}

type SyncKeys = { [K in CatalogueKey]: (typeof CATALOGUE)[K]['kind'] extends 'gauge' ? never : K }[CatalogueKey];
type Instrument<K extends SyncKeys> = (typeof CATALOGUE)[K]['kind'] extends 'histogram' ? Histogram : Counter;
export type ServerMetrics = { readonly [K in SyncKeys]: Instrument<K> } & {
  /** Counts one lifecycle transition; only the 7 valid edges exist. */
  transition(from: TransitionEdge[0], to: TransitionEdge[1]): void;
};

const cache = new WeakMap<Telemetry, ServerMetrics>();

function create(t: Telemetry, spec: InstrumentSpec): Counter | Histogram {
  const opts = {
    description: spec.description,
    ...(spec.unit !== undefined ? { unit: spec.unit } : {}),
    ...(spec.labels !== undefined ? { labels: spec.labels } : {}),
  };
  switch (spec.kind) {
    case 'histogram':
      return t.histogram(spec.name, { ...opts, boundaries: spec.boundaries ?? [] });
    case 'updown':
      return t.upDownCounter(spec.name, opts);
    default:
      return t.counter(spec.name, opts);
  }
}

/**
 * The synchronous instruments of the catalogue, created lazily on first use (an instrument with no recorded point
 * stays absent from MetricSnapshot) and memoised per Telemetry.
 */
export function serverMetrics(t: Telemetry): ServerMetrics {
  const existing = cache.get(t);
  if (existing) return existing;
  const made = new Map<string, Counter | Histogram>();
  const get = (spec: InstrumentSpec) => {
    let i = made.get(spec.name);
    if (i === undefined) {
      i = create(t, spec);
      made.set(spec.name, i);
    }
    return i;
  };
  const target = {
    transition(from: string, to: string) {
      if (!TRANSITION_EDGES.some(([f, x]) => f === from && x === to)) return;
      (get(CATALOGUE.gamesTransitions) as Counter).add(1, { from, to });
    },
  };
  const metrics = new Proxy(target, {
    get(obj, key) {
      if (key === 'transition') return obj.transition;
      const spec = (CATALOGUE as Record<string, InstrumentSpec>)[String(key)];
      if (spec === undefined || spec.kind === 'gauge') return undefined;
      return get(spec);
    },
  }) as unknown as ServerMetrics;
  cache.set(t, metrics);
  return metrics;
}

/** Registers a catalogue gauge with its observation callback. */
export function registerGauge(t: Telemetry, spec: InstrumentSpec & { kind: 'gauge' }, callback: GaugeCallback): void {
  t.observableGauge(
    spec.name,
    {
      description: spec.description,
      ...(spec.unit !== undefined ? { unit: spec.unit } : {}),
      ...(spec.labels !== undefined ? { labels: spec.labels } : {}),
    },
    callback,
  );
}
