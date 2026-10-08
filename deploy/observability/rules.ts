// Grafana-managed alert rules (design §9.6, X-alerts item 4; Evolve observability needs v5 §5). Non-paging; grouping and
// the 4 h repeat live in the notification policy (sync.ts). Every query filters on {cluster, namespace="catan-server"};
// probe queries filter on the Synthetic Monitoring check's job and instance.
//   A1  server errors: internal_error rejections + catan.errors + non-drain 5xx, OR the production secret-shape LogQL
//       (G4), OR server.bundle_version_mismatch (D12).
//   A2  down: 3 consecutive failed /healthz probes; always on.
//   A3  lost games: lost_on_restart > 0 or a game.lost event, or an unclean start (server_starts / server.started) while
//       games were active in the last 30 min.
//   A4  abandonment job stale > 15 min, never successful 15 min after boot, or a failed run. Optional, from Evolve's
//       task 5cf2796b; does not gate X-alerts.
//   NFR9 two consecutive failed probes inside a game-night window: the scheduled half is routed through the
//       "game-night" time interval; the ad-hoc half requires active games in the last 30 min. Both evaluate without the
//       game server, so they work while it is down.
// No data (Evolve 5cf2796b R1–R5): Grafana drops a whole math expression when any input it names has no series, the
// normal state of a log count with no matching line. So every input is one query built from terms
// `(sum(<aggregate> <cmp> bool X) or vector(0))` joined with + (OR) and * (AND); it always returns exactly one sample,
// and `fire` combines the inputs with + / * and > 0. noDataState is OK on every rule: no data means a query broke.
// The server being down is A2's job; if the probe check itself stops reporting, A2 stays OK.

export interface RuleContext {
  /** deployment.environment of the stack (the `cluster` label). */
  readonly cluster: string;
  readonly promUid: string;
  readonly lokiUid: string;
  readonly tempoUid: string;
  /** Synthetic Monitoring check labels (job = check name, instance = probed URL). */
  readonly probeJob: string;
  readonly probeInstance: string;
}

export const FOLDER_UID = 'catan';
export const RULE_GROUP = 'catan-alerts';
/** Labels the notification policy routes on. */
export const WINDOW_LABEL = { window: 'game-night' } as const;

type Query = { refId: string; datasourceUid: string; model: Record<string, unknown>; relativeTimeRange?: { from: number; to: number } };

const prom = (ctx: RuleContext, refId: string, expr: string, lookbackS = 900): Query => ({
  refId,
  datasourceUid: ctx.promUid,
  relativeTimeRange: { from: lookbackS, to: 0 },
  model: { refId, expr, instant: true, range: false },
});
const loki = (ctx: RuleContext, refId: string, expr: string): Query => ({
  refId,
  datasourceUid: ctx.lokiUid,
  relativeTimeRange: { from: 900, to: 0 },
  model: { refId, expr, queryType: 'instant' },
});
/** Reduces a query to one number per series; NaN and null become 0. An input with no series stays no data. */
const last = (refId: string, of: string): Query => ({
  refId,
  datasourceUid: '__expr__',
  model: { refId, type: 'reduce', expression: of, reducer: 'last', settings: { mode: 'replaceNN', replaceWithValue: 0 } },
});
const math = (refId: string, expression: string): Query => ({ refId, datasourceUid: '__expr__', model: { refId, type: 'math', expression } });

/** The series selector every metric query uses. */
export const sel = (ctx: RuleContext, extra = ''): string =>
  `cluster="${ctx.cluster}",namespace="catan-server"${extra === '' ? '' : `,${extra}`}`;
const probe = (ctx: RuleContext): string => `job="${ctx.probeJob}",instance="${ctx.probeInstance}"`;

/** NFR3 / A1 metric part: server-side errors over 15 min. */
export const serverErrorsExpr = (ctx: RuleContext): string =>
  `sum(increase(catan_actions_rejected_total{${sel(ctx, 'reason_code="internal_error"')}}[15m]) or vector(0))` +
  ` + sum(increase(catan_errors_total{${sel(ctx)}}[15m]) or vector(0))` +
  ` + sum(increase(catan_http_responses_5xx_total{${sel(ctx)}}[15m]) or vector(0))`;

/**
 * Production secret check (G4): seat-token SHAPE (exactly 43 base64url characters), a forbidden key whose value is not
 * the redaction marker, or a rejoin-link fragment (#join= / #seat=). The exact-value scan is T-3's CI job.
 */
export const SECRET_LINE_REGEX =
  '"(roomCode|seatToken|token|passphrase)":"[^\\\\[]|(^|[^A-Za-z0-9_-])[A-Za-z0-9_-]{43}([^A-Za-z0-9_-]|$)|#(join|seat)=';

/**
 * One no-data-safe term (Evolve 5cf2796b R2/R3): an aggregated expression compared with `bool`, summed to drop every
 * label, or 0 when it has no series. A term is always exactly one label-less 0/1 (or count) sample.
 */
export const term = (aggregated: string, comparison: string): string => `(sum(${aggregated} ${comparison}) or vector(0))`;
/** OR of terms: their sum (> 0 when any holds). */
const anyOf = (...terms: string[]): string => terms.join(' + ');
/** AND of terms: their product, parenthesised so it can stand inside an anyOf. */
const allOf = (...terms: string[]): string => `(${terms.join(' * ')})`;

const increased = (ctx: RuleContext, metric: string, extra = '', window = '15m'): string =>
  term(`sum(increase(${metric}{${sel(ctx, extra)}}[${window}]))`, '> bool 0');
const logged = (ctx: RuleContext, pipeline: string): string => term(`sum(count_over_time({${sel(ctx)}} ${pipeline} [15m]))`, '> bool 0');
const probes = (ctx: RuleContext, window: string): string => `probe_success{${probe(ctx)}}[${window}]`;
/** Failed probes in the window from raw samples (count − successes); 120 s checks put 2–3 in 5 min and 3 in 6 min. */
const failedProbes = (ctx: RuleContext, window: string): string =>
  `sum(count_over_time(${probes(ctx, window)})) - sum(sum_over_time(${probes(ctx, window)}))`;
/** The ad-hoc half of a game-night window: any active game in the last 30 minutes. */
const activeRecently = (ctx: RuleContext): string => term(`max(max_over_time(catan_games{${sel(ctx, 'state="active"')}}[30m]))`, '> bool 0');

/** A1's metric terms: internal_error rejections, catan.errors and non-drain 5xx over 15 min. */
export const a1MetricExpr = (ctx: RuleContext): string =>
  anyOf(
    increased(ctx, 'catan_actions_rejected_total', 'reason_code="internal_error"'),
    increased(ctx, 'catan_errors_total'),
    increased(ctx, 'catan_http_responses_5xx_total'),
  );
/** A1's log terms: a secret-shaped line (G4) or server.bundle_version_mismatch (D12). */
export const a1LogExpr = (ctx: RuleContext): string =>
  anyOf(logged(ctx, `|~ \`${SECRET_LINE_REGEX}\``), logged(ctx, '| json | event="server.bundle_version_mismatch"'));
/** A2: at least 3 probes in 6 min, none of them successful. */
export const a2Expr = (ctx: RuleContext): string =>
  allOf(term(`sum(count_over_time(${probes(ctx, '6m')}))`, '>= bool 3'), term(`sum(sum_over_time(${probes(ctx, '6m')}))`, '== bool 0'));
/** A3's metric terms: a game lost on restart, or an unclean start (both zero-initialised counters) while games were active. */
export const a3MetricExpr = (ctx: RuleContext): string =>
  anyOf(
    increased(ctx, 'catan_games_lost_on_restart_total'),
    allOf(increased(ctx, 'catan_server_starts_total', 'shutdown="unclean"'), activeRecently(ctx)),
  );
/** A4 (Evolve 5cf2796b): stale for 15 min, never successful 15 min after boot, or a failed run in 30 min. */
export const a4Expr = (ctx: RuleContext): string =>
  anyOf(
    term(`(time() - max(catan_job_abandonment_last_success_seconds{${sel(ctx)}}))`, '> bool 900'),
    `(sum(absent(catan_job_abandonment_last_success_seconds{${sel(ctx)}}) * on() (max(catan_runtime_uptime_seconds{${sel(ctx)}}) > bool 900)) or vector(0))`,
    increased(ctx, 'catan_job_abandonment_runs_total', 'result="error"', '30m'),
  );
/** NFR9: two failed probes in 5 min. */
export const twoFailuresExpr = (ctx: RuleContext): string => term(failedProbes(ctx, '5m'), '>= bool 2');

interface RuleSpec {
  uid: string;
  title: string;
  queries: Query[];
  /** refId of the final threshold expression. */
  condition: string;
  for: string;
  summary: string;
  labels?: Record<string, string>;
}

/** A rule whose inputs are each one always-defined query; `fire` combines their last values with `+`/`*` and `> 0`. */
function rule(spec: Omit<RuleSpec, 'queries' | 'condition'>, inputs: Query[], combine: string): RuleSpec {
  return {
    ...spec,
    queries: [...inputs, ...inputs.map((q) => last(`${q.refId}N`, q.refId)), math('fire', `(${combine}) > 0`)],
    condition: 'fire',
  };
}

function specs(ctx: RuleContext): RuleSpec[] {
  return [
    rule(
      {
        uid: 'catan-a1-server-errors',
        title: 'A1 server errors (internal_error, errors, 5xx, secrets in logs, bundle mismatch)',
        for: '0s',
        summary: 'Server-side errors, a secret-shaped log line, or a bundle/server version mismatch in the last 15 min.',
      },
      [prom(ctx, 'metrics', a1MetricExpr(ctx)), loki(ctx, 'logs', a1LogExpr(ctx))],
      '$metricsN + $logsN',
    ),
    rule(
      { uid: 'catan-a2-down', title: 'A2 down (3 consecutive failed /healthz probes)', for: '0s', summary: 'The last 3 Synthetic Monitoring probes of /healthz failed.' },
      [prom(ctx, 'probes', a2Expr(ctx), 360)],
      '$probesN',
    ),
    rule(
      {
        uid: 'catan-a3-lost-games',
        title: 'A3 games lost on restart, or an unclean start while games were active',
        for: '0s',
        summary: 'A started game could not be restored, or the server restarted uncleanly while games were active.',
      },
      [
        prom(ctx, 'metrics', a3MetricExpr(ctx), 1800),
        // The once-per-occurrence log events also catch the first event after a restart, before a counter is exported.
        loki(ctx, 'lostLog', logged(ctx, '| json | event="game.lost"')),
        loki(ctx, 'uncleanLog', logged(ctx, '| json | event="server.started" | previous_shutdown="unclean"')),
        prom(ctx, 'active', activeRecently(ctx), 1800),
      ],
      '$metricsN + $lostLogN + $uncleanLogN * $activeN',
    ),
    rule(
      {
        uid: 'catan-a4-job-stale',
        title: 'A4 abandonment job stale or failing (optional, from 5cf2796b)',
        for: '0s',
        summary: 'The abandonment job has not succeeded for 15 min (or never since boot), or a run failed (AC29 relies on it).',
      },
      [prom(ctx, 'job', a4Expr(ctx))],
      '$jobN',
    ),
    rule(
      {
        uid: 'catan-nfr9-window',
        title: 'NFR9 two consecutive failed probes in a scheduled game-night window',
        for: '0s',
        summary: 'Two consecutive /healthz probes failed during a scheduled game-night window.',
        labels: { ...WINDOW_LABEL },
      },
      [prom(ctx, 'failed', twoFailuresExpr(ctx), 300)],
      '$failedN',
    ),
    rule(
      {
        uid: 'catan-nfr9-active',
        title: 'NFR9 two consecutive failed probes while games were active (30 min lookback)',
        for: '0s',
        summary: 'Two consecutive /healthz probes failed while games were active in the last 30 min.',
      },
      [prom(ctx, 'failed', allOf(twoFailuresExpr(ctx), activeRecently(ctx)), 1800)],
      '$failedN',
    ),
  ];
}

/** The rule group for PUT /api/v1/provisioning/folder/{FOLDER_UID}/rule-groups/{RULE_GROUP}. */
export function ruleGroup(ctx: RuleContext): Record<string, unknown> {
  return {
    title: RULE_GROUP,
    folderUid: FOLDER_UID,
    interval: 60,
    rules: specs(ctx).map((r) => ({
      uid: r.uid,
      title: r.title,
      folderUID: FOLDER_UID,
      ruleGroup: RULE_GROUP,
      condition: r.condition,
      data: r.queries,
      for: r.for,
      noDataState: 'OK',
      execErrState: 'Error',
      labels: { app: 'catan', cluster: ctx.cluster, ...r.labels },
      annotations: { summary: r.summary },
      isPaused: false,
    })),
  };
}
