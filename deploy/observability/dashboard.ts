// "Catan — game night" dashboard as code (X-alerts item 5; Evolve observability needs v5 §1, D16). Every metric and log
// query filters on {cluster="$env", namespace="catan-server"}; probe queries filter on the Synthetic Monitoring check.
// Panel SLIs follow Evolve's definitions; NFR6 shows no verdict while fewer than 100 attempts exist (requirements A28).
import { serverErrorsExpr, type RuleContext } from './rules.ts';
import {
  authRejectionsByReasonExpr,
  authRejectionsExpr,
  nfr10LostOnRestartExpr,
  nfr1ShareExpr,
  nfr4RejectedShareExpr,
  nfr5UnplannedPerPlayerHourExpr,
  nfr6GapShareExpr,
  nfr6ReconnectSuccessExpr,
  nfr9FailedProbes5mExpr,
  q95 as sliQ95,
  reconnectEventsLogQL,
  reconnectsByOutcomeExpr,
  resumeGapReportsExpr,
  resumeGapShareExpr,
  resumeGapWithinTargetExpr,
} from './sli.ts';

export const DASHBOARD_UID = 'catan-game-night';

type Target = Record<string, unknown>;
type Panel = Record<string, unknown>;

/** Selector with the dashboard's $env variable. */
const S = (extra = ''): string => `cluster="$env",namespace="catan-server"${extra === '' ? '' : `,${extra}`}`;
const W14 = '14d';

export function dashboard(ctx: RuleContext): Record<string, unknown> {
  const promDs = { type: 'prometheus', uid: ctx.promUid };
  const lokiDs = { type: 'loki', uid: ctx.lokiUid };
  const tempoDs = { type: 'tempo', uid: ctx.tempoUid };
  const probe = `job="${ctx.probeJob}",instance="${ctx.probeInstance}"`;
  const envCtx: RuleContext = { ...ctx, cluster: '$env' };
  // TraceQL resource scope; span attributes such as catan.game.id stay in trace queries, never metric labels (D28(b)).
  const T = 'resource.service.name = "catan-server" && resource.cluster = "$env"';

  let id = 0;
  let y = 0;
  const panels: Panel[] = [];
  const row = (title: string) => {
    panels.push({ id: ++id, type: 'row', title, collapsed: false, gridPos: { h: 1, w: 24, x: 0, y: y++ }, panels: [] });
  };
  let x = 0;
  const place = (w: number, h: number) => {
    if (x + w > 24) {
      x = 0;
      y += 8;
    }
    const pos = { h, w, x, y };
    x += w;
    return pos;
  };
  const endRow = () => {
    if (x > 0) y += 8;
    x = 0;
  };
  const prom = (expr: string, legendFormat = '', extra: Target = {}): Target => ({ datasource: promDs, expr, legendFormat, ...extra });
  const panel = (type: string, title: string, targets: Target[], opts: Panel = {}, w = 6, h = 8): void => {
    const { datasource, ...rest } = opts;
    panels.push({ id: ++id, type, title, datasource: datasource ?? promDs, targets: targets.map((t, i) => ({ refId: String.fromCharCode(65 + i), ...t })), gridPos: place(w, h), ...rest });
  };
  const stat = (title: string, targets: Target[], unit: string, thresholds: { value: number | null; color: string }[], description: string, w = 6) =>
    panel('stat', title, targets, { description, fieldConfig: { defaults: { unit, noValue: 'n < 100 — no verdict', thresholds: { mode: 'absolute', steps: thresholds } }, overrides: [] }, options: { reduceOptions: { calcs: ['lastNotNull'] } } }, w);
  const ts = (title: string, targets: Target[], unit = 'short', description = '', w = 12) =>
    panel('timeseries', title, targets, { description, fieldConfig: { defaults: { unit }, overrides: [] } }, w);
  const green = (v: number | null = null) => ({ value: v, color: 'green' });
  const red = (v: number) => ({ value: v, color: 'red' });
  const q95 = (metric: string, extra = '', range = '$__range') => sliQ95(envCtx, metric, extra, range);

  // ── SLIs ──
  row('SLIs (NFR)');
  stat('NFR1 actions ≤ 50 ms (share)', [prom(nfr1ShareExpr(envCtx, '$__range'))], 'percentunit', [red(0), green(0.95)], 'Share of server action handling ≤ 0.05 s (the le="0.05" bucket).');
  stat('NFR1 p95 (all / ok)', [prom(q95('catan_action_duration_seconds'), 'all'), prom(q95('catan_action_duration_seconds', 'result="ok"'), 'ok')], 's', [green(), red(0.05)], 'Server action p95, overall and for result="ok".');
  stat('NFR2 client action RTT p95 (verdict)', [prom(q95('catan_client_action_rtt_seconds'))], 's', [green(), red(0.3)], 'Verdict: catan.client.action_rtt p95 ≤ 300 ms.');
  stat('NFR3 server errors (A1 metric part, 15 min)', [prom(serverErrorsExpr(envCtx))], 'short', [green(), red(1)], 'internal_error rejections + catan.errors (except component="telemetry", D31) + non-drain 5xx; the A1 metric terms.');
  stat('NFR4 rule/turn rejections (excl. auth)', [prom(nfr4RejectedShareExpr(envCtx, '$__range'))], 'percentunit', [green(), red(0.02)], 'rule|turn / (ok|rule|turn|error); auth is excluded and shown separately.');
  stat('NFR5 unplanned disconnects per player-hour', [prom(nfr5UnplannedPerPlayerHourExpr(envCtx, '$__range'))], 'short', [green(), red(1)], 'unplanned / (catan_player_connected_seconds_total / 3600).');
  stat('NFR6 reconnect success (14 d)', [prom(nfr6ReconnectSuccessExpr(envCtx, W14))], 'percentunit', [red(0), green(0.99)], 'resumed / (all − failed_auth) over 14 days; no verdict while n < 100 (A28).');
  // NFR6 gap SLI (D30): the share of client-reported gaps strictly under 5 s, from the zero-initialised counters.
  stat('NFR6 network resume gaps < 5 s (verdict, 14 d)', [prom(nfr6GapShareExpr(envCtx, 'network', W14))], 'percentunit', [red(0), green(0.95)], 'within_target / reports for cause="network" over 14 days (strictly < 5 s, D30); server_restart gaps have their own panel. No verdict while n < 100 (A28).');
  ts('NFR6 network gap raw counts (14 d)', [prom(resumeGapReportsExpr(envCtx, 'network', W14), 'reports'), prom(resumeGapWithinTargetExpr(envCtx, 'network', W14), 'within target')], 'short', 'Raw D30 counts; read these while reports < 100 (no verdict, A28).', 6);
  ts('NFR6 network resume gap p95 (diagnostic)', [prom(q95('catan_ws_resume_gap_seconds', 'cause="network"', '$__rate_interval'), 'p95')], 's', 'Histogram p95, diagnostic only: its le="5" bucket includes exactly 5 s, so the verdict uses the within_target counter.', 6);
  ts('NFR6 raw counts (14 d, by outcome)', [prom(reconnectsByOutcomeExpr(envCtx, W14), '{{outcome}}')], 'short', 'Raw reconnect counts; read these while n < 100.', 6);
  stat('NFR9 probe success (range)', [prom(`avg_over_time(probe_success{${probe}}[$__range])`)], 'percentunit', [red(0), green(0.99)], 'Synthetic Monitoring /healthz success; judge it inside the game-night regions and active-game periods.');
  stat('NFR9 failed probes in 5 min', [prom(nfr9FailedProbes5mExpr(probe))], 'short', [green(), red(2)], 'Never 2 consecutive failures (120 s check).');
  stat('NFR10 games lost on restart', [prom(nfr10LostOnRestartExpr(envCtx, '$__range'))], 'short', [green(), red(1)], 'catan.games.lost_on_restart.');
  stat('NFR12 app series (of 450)', [prom(`count({${S()}})`)], 'short', [green(), { value: 400, color: 'orange' }, red(450)], 'Active series with this cluster and namespace, against the 450 budget.');
  stat('NFR13 abandoned→expired / lobby→active', [prom(`sum(increase(catan_games_transitions_total{${S('from="abandoned",to="expired"')}}[$__range])) / sum(increase(catan_games_transitions_total{${S('from="lobby",to="active"')}}[$__range]))`)], 'percentunit', [green(), red(0.2)], 'Lost restores are not transitions, so they never count here.');
  stat('Lobbies never started', [prom(`sum(increase(catan_games_transitions_total{${S('from="lobby",to="expired"')}}[$__range])) or vector(0)`)], 'short', [green()], 'lobby→expired transitions.');
  ts('Auth rejections (daily; not in NFR4)', [
    prom(authRejectionsExpr(envCtx, '1d'), 'WS auth rejections'),
    prom(`sum(increase(catan_rooms_creates_total{${S('result="rate_limited_auth"')}}[1d]))`, 'room creates refused (failed-attempt limit)'),
    prom(authRejectionsByReasonExpr(envCtx, '1d'), '{{reason_code}}'),
  ], 'short', 'Two separate series (different units, never summed), plus the WS breakdown by reason code.');
  endRow();

  // ── live ──
  row('Live');
  stat('Slots used (lobby + active, of 10)', [prom(`sum(catan_games{${S('state=~"lobby|active"')}})`)], 'short', [green(), { value: 8, color: 'orange' }, red(10)], 'rooms.maxActiveGames counts lobby + active.');
  ts('Games by state', [prom(`sum by (state) (catan_games{${S()}})`, '{{state}}')], 'short', '', 6);
  ts('Players / connections', [prom(`sum(catan_players_connected{${S()}})`, 'players'), prom(`sum(catan_ws_connections{${S()}})`, 'sockets')], 'short', '', 6);
  stat('Disk free', [prom(`min(catan_disk_free_bytes{${S()}})`)], 'bytes', [red(0), { value: 2e9, color: 'orange' }, green(5e9)], 'statfs of /data (catan.disk.free).');
  ts('Rooms created, by result', [prom(`sum by (result) (increase(catan_rooms_creates_total{${S()}}[$__rate_interval]))`, '{{result}}')], 'short');
  ts('Action latency p95 (diagnostics: ws.rtt, delivery)', [
    prom(q95('catan_client_action_rtt_seconds', '', '$__rate_interval'), 'client action_rtt'),
    prom(q95('catan_ws_rtt_seconds', '', '$__rate_interval'), 'ws.rtt'),
    prom(q95('catan_ws_delivery_duration_seconds', '', '$__rate_interval'), 'delivery'),
    prom(q95('catan_action_duration_seconds', '', '$__rate_interval'), 'server'),
  ], 's');
  // Player-facing actions only: kind = server (D28(c)); timer skips are INTERNAL catan.action spans.
  panel('table', 'Per-action-type p95 (TraceQL)', [{ datasource: tempoDs, queryType: 'traceqlmetrics', query: `{ ${T} && name = "catan.action" && kind = server } | quantile_over_time(duration, .95) by (span.catan.action.type)` }], { datasource: tempoDs }, 12);
  panel('table', 'Slow actions (> 50 ms, TraceQL)', [{ datasource: tempoDs, queryType: 'traceql', tableType: 'spans', limit: 50, query: `{ ${T} && name = "catan.action" && kind = server && duration > 50ms } | select(span.catan.action.type, span.catan.reduce_ms, span.catan.persist_ms, span.catan.broadcast_ms, span.catan.game.id)` }], { datasource: tempoDs, description: 'Individual player-facing actions over the NFR1 50 ms budget, with their reduce / persist / broadcast split (A5 runbook).' }, 24);
  endRow();

  // ── connections ──
  row('Connections');
  ts('Disconnects by reason', [prom(`sum by (reason) (increase(catan_ws_disconnects_total{${S()}}[$__rate_interval]))`, '{{reason}}')]);
  ts('Reconnects by outcome', [prom(`sum by (outcome) (increase(catan_ws_reconnects_total{${S()}}[$__rate_interval]))`, '{{outcome}}')]);
  panel('stat', 'Resume gaps — server_restart < 5 s (14 d)', [prom(resumeGapShareExpr(envCtx, 'server_restart', W14))], { description: 'within_target / reports for cause="server_restart" over 14 days (D30); no n gate.', fieldConfig: { defaults: { unit: 'percentunit', noValue: 'no restart gaps reported' }, overrides: [] }, options: { reduceOptions: { calcs: ['lastNotNull'] } } }, 6);
  ts('Resume gaps — server_restart (own panel)', [prom(q95('catan_ws_resume_gap_seconds', 'cause="server_restart"', '$__rate_interval'), 'p95'), prom(`sum(increase(catan_ws_resume_gap_seconds_count{${S('cause="server_restart"')}}[$__rate_interval]))`, 'count')], 's');
  // The client-measured network gaps NFR6 judges, bucket by bucket: the A28 view of individual gaps while n < 100.
  panel(
    'bargauge',
    'Network resume gaps — 14 d distribution (client-measured; individual gaps while n < 100)',
    [prom(`sum by (le) (increase(catan_ws_resume_gap_seconds_bucket{${S('cause="network"')}}[${W14}]))`, '{{le}}', { format: 'heatmap', instant: true })],
    { description: 'catan.ws.resume_gap{cause="network"} from client telemetry, by bucket upper bound (s), over 14 days.' },
    12,
  );
  // player.reconnected carries the server-side gap: it includes absence time and is null after a restart (D29).
  panel('logs', 'Reconnect events (server-side gap; null = unknown)', [{ datasource: lokiDs, expr: reconnectEventsLogQL(envCtx) }], { datasource: lokiDs }, 12);
  endRow();

  // ── lifecycle ──
  row('Lifecycle');
  ts('Transitions', [prom(`sum by (from, to) (increase(catan_games_transitions_total{${S()}}[$__rate_interval]))`, '{{from}}→{{to}}')]);
  ts('Abandonment job', [prom(`time() - max(catan_job_abandonment_last_success_seconds{${S()}})`, 'seconds since last success'), prom(`sum by (result) (increase(catan_job_abandonment_runs_total{${S()}}[$__rate_interval]))`, 'runs {{result}}')], 'short');
  endRow();

  // ── ops ──
  row('Ops');
  ts('Server starts', [prom(`sum by (shutdown) (increase(catan_server_starts_total{${S()}}[$__rate_interval]))`, '{{shutdown}}')]);
  ts('Errors by component', [prom(`sum by (component) (increase(catan_errors_total{${S()}}[$__rate_interval]))`, '{{component}}')]);
  ts('Persist p95', [prom(`histogram_quantile(0.95, sum by (le, op) (increase(catan_persist_duration_seconds_bucket{${S()}}[$__rate_interval])))`, '{{op}}')], 's');
  ts('Client errors / dropped telemetry', [prom(`sum by (kind) (increase(catan_client_errors_total{${S()}}[$__rate_interval]))`, '{{kind}}'), prom(`sum(increase(catan_telemetry_dropped_total{${S()}}[$__rate_interval]))`, 'dropped')]);
  panel('timeseries', 'System work by span (kind=internal, TraceQL)', [{ datasource: tempoDs, queryType: 'traceqlmetrics', query: `{ ${T} && kind = internal } | rate() by (name)` }], { datasource: tempoDs, description: 'Server-originated spans: abandonment job, boot, drain and timer skips (D28(c)).' }, 12);
  endRow();

  // ── logs ──
  row('Logs');
  panel('logs', 'Warnings and errors', [{ datasource: lokiDs, expr: `{${S()}} | json | severity_text=~"WARN|ERROR|FATAL"` }], { datasource: lokiDs }, 24);
  endRow();

  return {
    uid: DASHBOARD_UID,
    title: 'Catan — game night',
    tags: ['catan'],
    timezone: 'utc',
    schemaVersion: 39,
    time: { from: 'now-6h', to: 'now' },
    templating: {
      list: [{ name: 'env', type: 'custom', query: ctx.cluster, current: { text: ctx.cluster, value: ctx.cluster }, options: [{ text: ctx.cluster, value: ctx.cluster, selected: true }] }],
    },
    annotations: {
      list: [
        {
          name: 'Deploys',
          datasource: lokiDs,
          enable: true,
          iconColor: 'blue',
          expr: `{${S()}} | json | event=~"server.started|server.draining|deploy.forced"`,
          titleFormat: '{{event}}',
          textFormat: 'version {{service_version}}',
          tagKeys: 'event',
        },
        { name: 'Game nights', datasource: { type: 'grafana', uid: '-- Grafana --' }, enable: true, iconColor: 'purple', target: { type: 'tags', tags: ['catan', 'game-night'], matchAny: false, limit: 100 } },
      ],
    },
    panels,
  };
}

/** Every query string in the dashboard (for filter checks). */
export function dashboardQueries(d: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const p of d['panels'] as Panel[]) for (const t of (p['targets'] as Target[] | undefined) ?? []) out.push(String(t['expr'] ?? t['query']));
  for (const a of (d['annotations'] as { list: Record<string, unknown>[] }).list) if (typeof a['expr'] === 'string') out.push(a['expr']);
  return out;
}

