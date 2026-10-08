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
/** Reduces a query to one number per series; no data and NaN count as 0. */
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
export const secretLogExpr = (ctx: RuleContext): string =>
  `sum(count_over_time({${sel(ctx)}} |~ \`${SECRET_LINE_REGEX}\` [15m]))`;
export const bundleMismatchExpr = (ctx: RuleContext): string =>
  `sum(count_over_time({${sel(ctx)}} | json | event="server.bundle_version_mismatch" [15m]))`;

/**
 * Failed probes in the last `window` from raw samples (count − successes). At the 120 s check interval, 5 min holds 2–3
 * probes (NFR9: two consecutive failures) and 6 min holds 3 (A2).
 */
export const failedProbesExpr = (ctx: RuleContext, window: string): string =>
  `sum(count_over_time(probe_success{${probe(ctx)}}[${window}]) - sum_over_time(probe_success{${probe(ctx)}}[${window}]))`;
export const twoFailuresExpr = (ctx: RuleContext): string => failedProbesExpr(ctx, '5m');
/** The ad-hoc half of a game-night window: any active game in the last 30 minutes. */
export const activeLookbackExpr = (ctx: RuleContext): string => `max_over_time(catan_games{${sel(ctx, 'state="active"')}}[30m])`;

interface RuleSpec {
  uid: string;
  title: string;
  queries: Query[];
  /** refId of the final threshold expression. */
  condition: string;
  for: string;
  summary: string;
  labels?: Record<string, string>;
  noDataState?: 'OK' | 'NoData' | 'Alerting';
}

function specs(ctx: RuleContext): RuleSpec[] {
  return [
    {
      uid: 'catan-a1-server-errors',
      title: 'A1 server errors (internal_error, errors, 5xx, secrets in logs, bundle mismatch)',
      queries: [
        prom(ctx, 'errors', serverErrorsExpr(ctx)),
        loki(ctx, 'secrets', secretLogExpr(ctx)),
        loki(ctx, 'bundle', bundleMismatchExpr(ctx)),
        last('errorsN', 'errors'),
        last('secretsN', 'secrets'),
        last('bundleN', 'bundle'),
        math('fire', '($errorsN > 0) || ($secretsN > 0) || ($bundleN > 0)'),
      ],
      condition: 'fire',
      for: '0s',
      summary: 'Server-side errors, a secret-shaped log line, or a bundle/server version mismatch in the last 15 min.',
    },
    {
      uid: 'catan-a2-down',
      title: 'A2 down (3 consecutive failed /healthz probes)',
      queries: [
        prom(ctx, 'failed', failedProbesExpr(ctx, '6m'), 360),
        prom(ctx, 'samples', `sum(count_over_time(probe_success{${probe(ctx)}}[6m]))`, 360),
        last('failedN', 'failed'),
        last('samplesN', 'samples'),
        math('fire', '($samplesN >= 3) && ($failedN >= $samplesN)'),
      ],
      condition: 'fire',
      for: '0s',
      summary: 'The last 3 Synthetic Monitoring probes of /healthz failed.',
      noDataState: 'Alerting',
    },
    {
      uid: 'catan-a3-lost-games',
      title: 'A3 games lost on restart, or an unclean start while games were active',
      queries: [
        // Counter increase (needs the counters zero-initialised at boot) and the once-per-occurrence log events, which
        // also catch the first event after a restart.
        prom(ctx, 'lost', `sum(increase(catan_games_lost_on_restart_total{${sel(ctx)}}[15m]) or vector(0))`),
        loki(ctx, 'lostLog', `sum(count_over_time({${sel(ctx)}} | json | event="game.lost" [15m]))`),
        prom(ctx, 'unclean', `sum(increase(catan_server_starts_total{${sel(ctx, 'shutdown="unclean"')}}[15m]) or vector(0))`),
        loki(ctx, 'uncleanLog', `sum(count_over_time({${sel(ctx)}} | json | event="server.started" | previous_shutdown="unclean" [15m]))`),
        prom(ctx, 'active', `max(${activeLookbackExpr(ctx)}) or vector(0)`, 1800),
        last('lostN', 'lost'),
        last('lostLogN', 'lostLog'),
        last('uncleanN', 'unclean'),
        last('uncleanLogN', 'uncleanLog'),
        last('activeN', 'active'),
        math('fire', '($lostN > 0) || ($lostLogN > 0) || ((($uncleanN > 0) || ($uncleanLogN > 0)) && ($activeN > 0))'),
      ],
      condition: 'fire',
      for: '0s',
      summary: 'A started game could not be restored, or the server restarted uncleanly while games were active.',
    },
    {
      uid: 'catan-a4-job-stale',
      title: 'A4 abandonment job stale or failing (optional, from 5cf2796b)',
      queries: [
        prom(ctx, 'age', `time() - max(catan_job_abandonment_last_success_seconds{${sel(ctx)}})`),
        // The last-success gauge is absent until the first successful run: a job failing from boot is stale too.
        prom(ctx, 'never', `(absent(catan_job_abandonment_last_success_seconds{${sel(ctx)}}) and on() max(catan_runtime_uptime_seconds{${sel(ctx)}}) > 900) or vector(0)`),
        prom(ctx, 'errors', `sum(increase(catan_job_abandonment_runs_total{${sel(ctx, 'result="error"')}}[15m]) or vector(0))`),
        last('ageN', 'age'),
        last('neverN', 'never'),
        last('errorsN', 'errors'),
        math('fire', '($ageN > 900) || ($neverN > 0) || ($errorsN > 0)'),
      ],
      condition: 'fire',
      for: '0s',
      summary: 'The abandonment job has not succeeded for 15 min (or never since boot), or a run failed (AC29 relies on it).',
    },
    {
      uid: 'catan-nfr9-window',
      title: 'NFR9 two consecutive failed probes in a scheduled game-night window',
      queries: [prom(ctx, 'failed', twoFailuresExpr(ctx), 300), last('failedN', 'failed'), math('fire', '$failedN >= 2')],
      condition: 'fire',
      for: '0s',
      summary: 'Two consecutive /healthz probes failed during a scheduled game-night window.',
      labels: { ...WINDOW_LABEL },
    },
    {
      uid: 'catan-nfr9-active',
      title: 'NFR9 two consecutive failed probes while games were active (30 min lookback)',
      queries: [
        prom(ctx, 'failed', twoFailuresExpr(ctx), 300),
        prom(ctx, 'active', `max(${activeLookbackExpr(ctx)}) or vector(0)`, 1800),
        last('failedN', 'failed'),
        last('activeN', 'active'),
        math('fire', '($failedN >= 2) && ($activeN > 0)'),
      ],
      condition: 'fire',
      for: '0s',
      summary: 'Two consecutive /healthz probes failed while games were active in the last 30 min.',
    },
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
      noDataState: r.noDataState ?? 'OK',
      execErrState: 'Error',
      labels: { app: 'catan', cluster: ctx.cluster, ...r.labels },
      annotations: { summary: r.summary },
      isPaused: false,
    })),
  };
}
