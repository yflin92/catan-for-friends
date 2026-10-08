// "Catan — game night" dashboard as code (X-alerts item 5; Evolve observability needs v5 §1, D16). Every metric and log
// query filters on {cluster="$env", namespace="catan-server"}; probe queries filter on the Synthetic Monitoring check.
// Panel SLIs follow Evolve's definitions; NFR6 shows no verdict while fewer than 100 attempts exist (requirements A28).
import { serverErrorsExpr, type RuleContext } from './rules.ts';

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
  const q95 = (metric: string, extra = '', range = '$__range') =>
    `histogram_quantile(0.95, sum by (le) (increase(${metric}_bucket{${S(extra)}}[${range}])))`;

  // ── SLIs ──
  row('SLIs (NFR)');
  stat('NFR1 actions ≤ 50 ms (share)', [prom(`sum(increase(catan_action_duration_seconds_bucket{${S('le="0.05"')}}[$__range])) / sum(increase(catan_action_duration_seconds_count{${S()}}[$__range]))`)], 'percentunit', [red(0), green(0.95)], 'Share of server action handling ≤ 0.05 s (the le="0.05" bucket).');
  stat('NFR1 p95 (all / ok)', [prom(q95('catan_action_duration_seconds'), 'all'), prom(q95('catan_action_duration_seconds', 'result="ok"'), 'ok')], 's', [green(), red(0.05)], 'Server action p95, overall and for result="ok".');
  stat('NFR2 client action RTT p95 (verdict)', [prom(q95('catan_client_action_rtt_seconds'))], 's', [green(), red(0.3)], 'Verdict: catan.client.action_rtt p95 ≤ 300 ms.');
  stat('NFR3 server errors (A1 metric part, 15 min)', [prom(serverErrorsExpr(envCtx))], 'short', [green(), red(1)], 'internal_error rejections + catan.errors + non-drain 5xx; the A1 alert expression.');
  stat('NFR4 rule/turn rejections (excl. auth)', [prom(`sum(increase(catan_actions_total{${S('result=~"rule|turn"')}}[$__range])) / sum(increase(catan_actions_total{${S('result=~"ok|rule|turn|error"')}}[$__range]))`)], 'percentunit', [green(), red(0.02)], 'rule|turn / (ok|rule|turn|error); auth is excluded and shown separately.');
  stat('NFR5 unplanned disconnects per player-hour', [prom(`sum(increase(catan_ws_disconnects_total{${S('reason="unplanned"')}}[$__range])) / (sum(increase(catan_player_connected_seconds_total{${S()}}[$__range])) / 3600)`)], 'short', [green(), red(1)], 'unplanned / (catan_player_connected_seconds_total / 3600).');
  const attempts = `(sum(increase(catan_ws_reconnects_total{${S()}}[${W14}])) - sum(increase(catan_ws_reconnects_total{${S('outcome="failed_auth"')}}[${W14}])))`;
  stat('NFR6 reconnect success (14 d)', [prom(`(sum(increase(catan_ws_reconnects_total{${S('outcome="resumed"')}}[${W14}])) / ${attempts}) and on() (${attempts} >= 100)`)], 'percentunit', [red(0), green(0.99)], 'resumed / (all − failed_auth) over 14 days; no verdict while n < 100 (A28).');
  stat('NFR6 network resume gap p95 (14 d)', [prom(`${q95('catan_ws_resume_gap_seconds', 'cause="network"', W14)} and on() (sum(increase(catan_ws_resume_gap_seconds_count{${S('cause="network"')}}[${W14}])) >= 100)`)], 's', [green(), red(5)], 'cause="network" only; server_restart gaps have their own panel. No verdict while n < 100.');
  ts('NFR6 raw counts (14 d, by outcome)', [prom(`sum by (outcome) (increase(catan_ws_reconnects_total{${S()}}[${W14}]))`, '{{outcome}}')], 'short', 'Raw reconnect counts; read these while n < 100.', 6);
  stat('NFR9 probe success (range)', [prom(`avg_over_time(probe_success{${probe}}[$__range])`)], 'percentunit', [red(0), green(0.99)], 'Synthetic Monitoring /healthz success; judge it inside the game-night regions and active-game periods.');
  stat('NFR9 failed probes in 5 min', [prom(`sum(count_over_time(probe_success{${probe}}[5m]) - sum_over_time(probe_success{${probe}}[5m]))`)], 'short', [green(), red(2)], 'Never 2 consecutive failures (120 s check).');
  stat('NFR10 games lost on restart', [prom(`sum(increase(catan_games_lost_on_restart_total{${S()}}[$__range])) or vector(0)`)], 'short', [green(), red(1)], 'catan.games.lost_on_restart.');
  stat('NFR12 app series (of 450)', [prom(`count({${S()}})`)], 'short', [green(), { value: 400, color: 'orange' }, red(450)], 'Active series with this cluster and namespace, against the 450 budget.');
  stat('NFR13 abandoned→expired / lobby→active', [prom(`sum(increase(catan_games_transitions_total{${S('from="abandoned",to="expired"')}}[$__range])) / sum(increase(catan_games_transitions_total{${S('from="lobby",to="active"')}}[$__range]))`)], 'percentunit', [green(), red(0.2)], 'Lost restores are not transitions, so they never count here.');
  stat('Lobbies never started', [prom(`sum(increase(catan_games_transitions_total{${S('from="lobby",to="expired"')}}[$__range])) or vector(0)`)], 'short', [green()], 'lobby→expired transitions.');
  ts('Auth rejections (daily; not in NFR4)', [
    prom(`sum(increase(catan_actions_total{${S('result="auth"')}}[1d]))`, 'WS auth rejections'),
    prom(`sum(increase(catan_rooms_creates_total{${S('result="rate_limited_auth"')}}[1d]))`, 'room creates refused (failed-attempt limit)'),
    prom(`sum by (reason_code) (increase(catan_actions_rejected_total{${S('reason_code=~"bad_seat_token|token_room_mismatch|unknown_room|seat_superseded|seat_token_revoked|rate_limited_auth"')}}[1d]))`, '{{reason_code}}'),
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
  panel('table', 'Per-action-type p95 (TraceQL)', [{ datasource: tempoDs, queryType: 'traceqlmetrics', query: `{ resource.service.name = "catan-server" && resource.cluster = "$env" && name = "catan.action" } | quantile_over_time(duration, .95) by (span.catan.action.type)` }], { datasource: tempoDs }, 12);
  endRow();

  // ── connections ──
  row('Connections');
  ts('Disconnects by reason', [prom(`sum by (reason) (increase(catan_ws_disconnects_total{${S()}}[$__rate_interval]))`, '{{reason}}')]);
  ts('Reconnects by outcome', [prom(`sum by (outcome) (increase(catan_ws_reconnects_total{${S()}}[$__rate_interval]))`, '{{outcome}}')]);
  ts('Resume gaps — server_restart (own panel)', [prom(q95('catan_ws_resume_gap_seconds', 'cause="server_restart"', '$__rate_interval'), 'p95'), prom(`sum(increase(catan_ws_resume_gap_seconds_count{${S('cause="server_restart"')}}[$__rate_interval]))`, 'count')], 's');
  panel('logs', 'Individual network resume gaps', [{ datasource: lokiDs, expr: `{${S()}} | json | event="player.reconnected"` }], { datasource: lokiDs }, 12);
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

