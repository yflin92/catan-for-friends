// NFR SLI expressions shared by the game-night dashboard (dashboard.ts) and the post-game report
// (tooling/load/gamenight-report.ts): one builder per SLI, taking the rule context (cluster) and the PromQL range, so
// the panel and the report run the same query. The dashboard passes cluster "$env" and range "$__range"; the report
// passes the real cluster and the window in seconds (e.g. "14400s"). Every selector filters on cluster + namespace.
import { sel, type RuleContext } from './rules.ts';

/** A histogram's observation count over the range (the n of its share and quantiles). */
export const histogramCountExpr = (ctx: RuleContext, metric: string, range: string): string =>
  `sum(increase(${metric}_count{${sel(ctx)}}[${range}]))`;

/** Share of a histogram's observations at or below `le` (a bucket boundary) over the range. */
export const shareWithin = (ctx: RuleContext, metric: string, le: string, range: string): string =>
  `sum(increase(${metric}_bucket{${sel(ctx, `le="${le}"`)}}[${range}])) / ${histogramCountExpr(ctx, metric, range)}`;

/** Interpolated p95 of a histogram over the range. */
export const q95 = (ctx: RuleContext, metric: string, extra: string, range: string): string =>
  `histogram_quantile(0.95, sum by (le) (increase(${metric}_bucket{${sel(ctx, extra)}}[${range}])))`;

/** NFR1: share of client commands handled within 50 ms (the le="0.05" bucket, inclusive). */
export const nfr1ShareExpr = (ctx: RuleContext, range: string): string => shareWithin(ctx, 'catan_action_duration_seconds', '0.05', range);

/** NFR4 numerator: rule|turn rejections. */
export const rejectedRuleTurnExpr = (ctx: RuleContext, range: string): string =>
  `sum(increase(catan_actions_total{${sel(ctx, 'result=~"rule|turn"')}}[${range}]))`;

/** NFR4 denominator: every answered command except auth. */
export const answeredExclAuthExpr = (ctx: RuleContext, range: string): string =>
  `sum(increase(catan_actions_total{${sel(ctx, 'result=~"ok|rule|turn|error"')}}[${range}]))`;

/** NFR4: rule|turn rejections over every answered command except auth. */
export const nfr4RejectedShareExpr = (ctx: RuleContext, range: string): string =>
  `${rejectedRuleTurnExpr(ctx, range)} / ${answeredExclAuthExpr(ctx, range)}`;

/** NFR5 numerator: unplanned disconnects. */
export const unplannedDisconnectsExpr = (ctx: RuleContext, range: string): string =>
  `sum(increase(catan_ws_disconnects_total{${sel(ctx, 'reason="unplanned"')}}[${range}]))`;

/** NFR5 denominator: player-hours connected. */
export const playerHoursExpr = (ctx: RuleContext, range: string): string =>
  `(sum(increase(catan_player_connected_seconds_total{${sel(ctx)}}[${range}])) / 3600)`;

/** NFR5: unplanned disconnects per player-hour. */
export const nfr5UnplannedPerPlayerHourExpr = (ctx: RuleContext, range: string): string =>
  `${unplannedDisconnectsExpr(ctx, range)} / ${playerHoursExpr(ctx, range)}`;

/** NFR6: reconnects by outcome. */
export const reconnectsByOutcomeExpr = (ctx: RuleContext, range: string): string =>
  `sum by (outcome) (increase(catan_ws_reconnects_total{${sel(ctx)}}[${range}]))`;

/** NFR6 attempts: every reconnect except failed_auth. */
export const reconnectAttemptsExpr = (ctx: RuleContext, range: string): string =>
  `(sum(increase(catan_ws_reconnects_total{${sel(ctx)}}[${range}])) - sum(increase(catan_ws_reconnects_total{${sel(ctx, 'outcome="failed_auth"')}}[${range}])))`;

/** NFR6 reconnect success, withheld (no sample) while attempts < 100 (A28). */
export const nfr6ReconnectSuccessExpr = (ctx: RuleContext, range: string): string =>
  `(sum(increase(catan_ws_reconnects_total{${sel(ctx, 'outcome="resumed"')}}[${range}])) / ${reconnectAttemptsExpr(ctx, range)}) and on() (${reconnectAttemptsExpr(ctx, range)} >= 100)`;

/** NFR6 gap SLI (D30): client-reported resume gaps of one cause, or of every cause when `cause` is null. */
export const resumeGapReportsExpr = (ctx: RuleContext, cause: string | null, range: string): string =>
  `sum(increase(catan_ws_resume_gap_reports_total{${sel(ctx, cause === null ? '' : `cause="${cause}"`)}}[${range}]))`;

/** NFR6 gap SLI (D30): those strictly under 5 s. */
export const resumeGapWithinTargetExpr = (ctx: RuleContext, cause: string | null, range: string): string =>
  `sum(increase(catan_ws_resume_gap_within_target_total{${sel(ctx, cause === null ? '' : `cause="${cause}"`)}}[${range}]))`;

/** Share of one cause's client-reported resume gaps strictly under 5 s (D30), with no n gate. */
export const resumeGapShareExpr = (ctx: RuleContext, cause: string, range: string): string =>
  `${resumeGapWithinTargetExpr(ctx, cause, range)} / ${resumeGapReportsExpr(ctx, cause, range)}`;

/** NFR6 gap share, withheld while reports < 100 (A28). */
export const nfr6GapShareExpr = (ctx: RuleContext, cause: string, range: string): string =>
  `${resumeGapShareExpr(ctx, cause, range)} and on() (${resumeGapReportsExpr(ctx, cause, range)} >= 100)`;

/** NFR9: failed probes in the last 5 minutes of the Synthetic Monitoring check (probe job + instance). */
export const nfr9FailedProbes5mExpr = (probe: string): string =>
  `sum(count_over_time(probe_success{${probe}}[5m]) - sum_over_time(probe_success{${probe}}[5m]))`;

/** NFR10: games lost on restart (a zero-initialised counter, so 0 is a real 0). */
export const nfr10LostOnRestartExpr = (ctx: RuleContext, range: string): string =>
  `sum(increase(catan_games_lost_on_restart_total{${sel(ctx)}}[${range}])) or vector(0)`;

/** The WS auth reason codes the auth panel shows (excluded from NFR4). */
export const AUTH_REASON_CODES = 'bad_seat_token|token_room_mismatch|unknown_room|seat_superseded|seat_token_revoked|rate_limited_auth';

/** WS auth rejections (not in NFR4). */
export const authRejectionsExpr = (ctx: RuleContext, range: string): string =>
  `sum(increase(catan_actions_total{${sel(ctx, 'result="auth"')}}[${range}]))`;

/** WS auth rejections by reason code (not in NFR4). */
export const authRejectionsByReasonExpr = (ctx: RuleContext, range: string): string =>
  `sum by (reason_code) (increase(catan_actions_rejected_total{${sel(ctx, `reason_code=~"${AUTH_REASON_CODES}"`)}}[${range}]))`;

/** The reconnect events the dashboard's log panel shows (server-side gap_s; null when unknown, D29). */
export const reconnectEventsLogQL = (ctx: RuleContext): string => `{${sel(ctx)}} | json | event="player.reconnected"`;

// ── Post-game report only (tooling/load/gamenight-report.ts): expressions from Verify's query list on task 7626d58c,
// with no dashboard panel of their own. Each names the list item it serves.

/** R1–R3 presence: how many series of a metric exist at the evaluation time (0 = the metric is missing: NO_DATA). */
export const seriesPresentExpr = (ctx: RuleContext, metric: string): string => `count(${metric}{${sel(ctx)}})`;

/** R2: client telemetry batches or samples dropped (the client metrics are incomplete when > 0). */
export const telemetryDroppedExpr = (ctx: RuleContext, range: string): string =>
  `sum(increase(catan_telemetry_dropped_total{${sel(ctx)}}[${range}]))`;

/** R3, R10: server starts, optionally of one shutdown kind (`extra`, e.g. shutdown="unclean"). */
export const serverStartsExpr = (ctx: RuleContext, extra: string, range: string): string =>
  `sum(increase(catan_server_starts_total{${sel(ctx, extra)}}[${range}]))`;

/** R10: server starts by previous shutdown kind. */
export const serverStartsByShutdownExpr = (ctx: RuleContext, range: string): string =>
  `sum by (shutdown) (increase(catan_server_starts_total{${sel(ctx)}}[${range}]))`;

/** R3: catan.errors by component (telemetry shown, not counted in NFR3). */
export const errorsByComponentExpr = (ctx: RuleContext, range: string): string =>
  `sum by (component) (increase(catan_errors_total{${sel(ctx)}}[${range}]))`;

/** R5: disconnects by reason. */
export const disconnectsByReasonExpr = (ctx: RuleContext, range: string): string =>
  `sum by (reason) (increase(catan_ws_disconnects_total{${sel(ctx)}}[${range}]))`;

/** R7: resumed reconnects in a window. */
export const reconnectsResumedExpr = (ctx: RuleContext, range: string): string =>
  `sum(increase(catan_ws_reconnects_total{${sel(ctx, 'outcome="resumed"')}}[${range}]))`;

/** R6 (G2): raw counter totals at the evaluation time, by one label: what increase() cannot see of a series' first sample. */
export const counterTotalsByExpr = (ctx: RuleContext, metric: string, label: string): string => `sum by (${label}) (${metric}{${sel(ctx)}})`;

/** R8 (a): the raw Synthetic Monitoring probe samples in the range (an instant query of a range vector). */
export const probeSamplesExpr = (probe: string, range: string): string => `probe_success{${probe}}[${range}]`;

/** R8 (c): probe results over a long range: how many, and how many succeeded. */
export const probeCountExpr = (probe: string, range: string): string => `sum(count_over_time(probe_success{${probe}}[${range}]))`;
export const probePassedExpr = (probe: string, range: string): string => `sum(sum_over_time(probe_success{${probe}}[${range}]))`;

/** R8: active games (range query) for the active-game extent around the declared window. */
export const activeGamesExpr = (ctx: RuleContext): string => `sum(catan_games{${sel(ctx, 'state="active"')}})`;

/** R8 (b), R9: one server event's log lines. */
export const eventLogQL = (ctx: RuleContext, event: string): string => `{${sel(ctx)}} | json | event="${event}"`;

/** R8 (b): server starts that restored games, i.e. a restart while games were active. */
export const restartsWithGamesLogQL = (ctx: RuleContext): string => `{${sel(ctx)}} | json | event="server.started" | games_restored > 0`;

/** R8, R9 (Loki G3): every log line of the environment in the range; 0 means the logs are missing, not quiet. */
export const anyLogLinesExpr = (ctx: RuleContext, range: string): string => `sum(count_over_time({${sel(ctx)}} [${range}]))`;

/** R7–R9: how many lines a LogQL pipeline matched in the range (an instant metric query). */
export const logLinesCountExpr = (logql: string, range: string): string => `sum(count_over_time(${logql} [${range}]))`;

/** R9: the sum of one numeric JSON field over the matching lines in the range. */
export const logFieldSumExpr = (logql: string, field: string, range: string): string => `sum(sum_over_time(${logql} | unwrap ${field} [${range}]))`;

/** R10: active → finished transitions (games that reached the end). */
export const gamesFinishedExpr = (ctx: RuleContext, range: string): string =>
  `sum(increase(catan_games_transitions_total{${sel(ctx, 'from="active",to="finished"')}}[${range}]))`;

/** R10: client-reported errors by kind. */
export const clientErrorsByKindExpr = (ctx: RuleContext, range: string): string =>
  `sum by (kind) (increase(catan_client_errors_total{${sel(ctx)}}[${range}]))`;
