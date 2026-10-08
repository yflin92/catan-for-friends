// Post-game NFR report (AC34/AC35 evidence; task 7626d58c, Verify's query list R1–R10 / G1–G6): for one declared
// game-night window, every NFR's verdict with its numbers, n and the exact query that produced them. The queries are
// built only from deploy/observability (sli.ts, rules.ts), so the report and the dashboard run the same PromQL (G1).
// Credentials come from the environment or the URLs (prom-client.ts) and never reach an output; no room code, seat
// token or game id is ever printed (G5). It is evidence, not a playtest gate: a FAIL means "file a bug" (AC34).
//
//   node --experimental-strip-types --no-warnings --import ./tooling/ts-resolve-hook.mjs tooling/load/gamenight-report.ts \
//     --prom-url <prometheus or Grafana proxy> --loki-url <loki or Grafana proxy> --cluster prod \
//     --from 2026-10-10T18:00:00Z --to 2026-10-10T23:00:00Z [--resume-at <UTC>] [--json] [--out report.json]
//
// Exit codes (G4): 1 any FAIL (a confirmed breach, even when other evidence is incomplete); else 2 when a required item
// has NO_DATA or a query failed; else 0 (every item PASS or NO_VERDICT by design). Incomplete evidence is always
// printed at the top of the table.
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { serverErrorsExpr, type RuleContext } from '../../deploy/observability/rules';
import * as sli from '../../deploy/observability/sli';
import { lokiInstantQuery, lokiQueryRange, promQuery, promRangeQuery, promSamplesQuery, type LokiStream, type RangeRow, type Row } from './prom-client';
import { countSeries } from './series-count';

export type Verdict = 'PASS' | 'FAIL' | 'NO_VERDICT' | 'NO_DATA';

export interface ReportInput {
  readonly cluster: string;
  readonly probeJob: string;
  readonly probeInstance: string;
  /** Window bounds, unix seconds (UTC). */
  readonly from: number;
  readonly to: number;
  /** AC35: when the deliberate reconnect happened, unix seconds. */
  readonly resumeAt?: number;
}

/**
 * One query as run: the expression with the window filled in, where it comes from, and how it was evaluated:
 * - instant: a Prometheus instant query at `at`;
 * - samples: a Prometheus instant query of a range vector at `at` (raw samples);
 * - range: a Prometheus range query over [start, end] at `step` (only the active-game extent);
 * - loki: a LogQL instant metric query at `at` (count_over_time / sum_over_time);
 * - lines: LogQL log lines in [start, end], shown and never judged.
 */
export interface QuerySpec {
  readonly key: string;
  readonly expr: string;
  readonly source: string;
  readonly kind: 'instant' | 'samples' | 'range' | 'loki' | 'lines';
  readonly at?: number;
  readonly start?: number;
  readonly end?: number;
  readonly step?: number;
}

export interface Item {
  readonly id: string;
  readonly title: string;
  /** A required item with NO_DATA makes the evidence incomplete (exit 2). */
  readonly required: boolean;
  verdict: Verdict;
  numbers: Record<string, unknown>;
  n: number | null;
  queries: QuerySpec[];
  notes: string[];
  warnings: string[];
}

/** Where the report reads from; the CLI uses Prometheus and Loki over HTTP, tests a seeded stand-in. */
export interface Backend {
  instant(expr: string, at: number): Promise<Row[]>;
  samples(expr: string, at: number): Promise<RangeRow[]>;
  range(expr: string, start: number, end: number, step: number): Promise<RangeRow[]>;
  /** Both null when no Loki URL is configured. */
  lokiInstant: ((logql: string, at: number) => Promise<Row[]>) | null;
  lokiLines: ((logql: string, start: number, end: number) => Promise<LokiStream[]>) | null;
  /** R10 context; null when unavailable. */
  seriesCount: (() => Promise<unknown>) | null;
}

/** AC35 sub-window around --resume-at: [at − 30 s, at + 120 s]. */
export const RESUME_BEFORE_SEC = 30;
export const RESUME_AFTER_SEC = 120;
/** NFR9 probe interval (the Synthetic Monitoring check runs every 120 s). */
export const PROBE_INTERVAL_SEC = 120;
/** A gap between probe samples (or between the window edge and a sample) longer than this is a failed probe. */
export const PROBE_GAP_SEC = 180;
/** How far around the declared window the active-game extent is searched (v1.6: declared window or active > 0). */
export const ACTIVE_EXTENT_MARGIN_SEC = 6 * 3600;

const ctxOf = (i: ReportInput): RuleContext => ({ cluster: i.cluster, promUid: '', lokiUid: '', tempoUid: '', probeJob: i.probeJob, probeInstance: i.probeInstance });
const probeOf = (i: ReportInput): string => `job="${i.probeJob}",instance="${i.probeInstance}"`;

/** Every query of the report, keyed by item, with the window filled in (pure; the G1 and G6 tests read this). */
export function buildQueries(i: ReportInput): Record<string, QuerySpec[]> {
  const ctx = ctxOf(i);
  const R = `${i.to - i.from}s`;
  const at = i.to;
  const probe = probeOf(i);
  const q = (key: string, expr: string, source: string): QuerySpec => ({ key, expr, source, kind: 'instant', at });
  const out: Record<string, QuerySpec[]> = {
    R1: [
      q('share', sli.nfr1ShareExpr(ctx, R), 'sli.nfr1ShareExpr (dashboard "NFR1 actions ≤ 50 ms (share)")'),
      q('n', sli.histogramCountExpr(ctx, 'catan_action_duration_seconds', R), 'sli.histogramCountExpr'),
      q('p95', sli.q95(ctx, 'catan_action_duration_seconds', '', R), 'sli.q95 (dashboard "NFR1 p95 (all / ok)")'),
      q('p95Ok', sli.q95(ctx, 'catan_action_duration_seconds', 'result="ok"', R), 'sli.q95 (dashboard "NFR1 p95 (all / ok)")'),
    ],
    R2: [
      q('share', sli.shareWithin(ctx, 'catan_client_action_rtt_seconds', '0.3', R), 'sli.shareWithin (R2)'),
      q('n', sli.histogramCountExpr(ctx, 'catan_client_action_rtt_seconds', R), 'sli.histogramCountExpr'),
      q('p95', sli.q95(ctx, 'catan_client_action_rtt_seconds', '', R), 'sli.q95 (dashboard "NFR2 client action RTT p95 (verdict)")'),
      q('wsRttP95', sli.q95(ctx, 'catan_ws_rtt_seconds', '', R), 'sli.q95 (diagnostic)'),
      q('deliveryP95', sli.q95(ctx, 'catan_ws_delivery_duration_seconds', '', R), 'sli.q95 (diagnostic)'),
      q('telemetryDropped', sli.telemetryDroppedExpr(ctx, R), 'sli.telemetryDroppedExpr (R2)'),
    ],
    R3: [
      q('errors', serverErrorsExpr(ctx, R), 'rules.serverErrorsExpr (A1 metric terms, dashboard "NFR3 server errors")'),
      q('uncleanStarts', sli.serverStartsExpr(ctx, 'shutdown="unclean"', R), 'sli.serverStartsExpr (R3)'),
      q('errorsByComponent', sli.errorsByComponentExpr(ctx, R), 'sli.errorsByComponentExpr (R3)'),
      q('errorsPresent', sli.seriesPresentExpr(ctx, 'catan_errors_total'), 'sli.seriesPresentExpr'),
      q('startsPresent', sli.seriesPresentExpr(ctx, 'catan_server_starts_total'), 'sli.seriesPresentExpr'),
    ],
    R4: [
      q('share', sli.nfr4RejectedShareExpr(ctx, R), 'sli.nfr4RejectedShareExpr (dashboard "NFR4 rule/turn rejections (excl. auth)")'),
      q('rejected', sli.rejectedRuleTurnExpr(ctx, R), 'sli.rejectedRuleTurnExpr'),
      q('n', sli.answeredExclAuthExpr(ctx, R), 'sli.answeredExclAuthExpr'),
      q('auth', sli.authRejectionsExpr(ctx, R), 'sli.authRejectionsExpr (dashboard "Auth rejections")'),
      q('authByReason', sli.authRejectionsByReasonExpr(ctx, R), 'sli.authRejectionsByReasonExpr (dashboard "Auth rejections")'),
    ],
    R5: [
      q('rate', sli.nfr5UnplannedPerPlayerHourExpr(ctx, R), 'sli.nfr5UnplannedPerPlayerHourExpr (dashboard "NFR5 unplanned disconnects per player-hour")'),
      q('unplanned', sli.unplannedDisconnectsExpr(ctx, R), 'sli.unplannedDisconnectsExpr'),
      q('playerHours', sli.playerHoursExpr(ctx, R), 'sli.playerHoursExpr'),
      q('byReason', sli.disconnectsByReasonExpr(ctx, R), 'sli.disconnectsByReasonExpr (R5)'),
    ],
    R6: [
      q('byOutcome', sli.reconnectsByOutcomeExpr(ctx, R), 'sli.reconnectsByOutcomeExpr (dashboard "NFR6 raw counts")'),
      q('networkReports', sli.resumeGapReportsExpr(ctx, 'network', R), 'sli.resumeGapReportsExpr (D30)'),
      q('networkWithinTarget', sli.resumeGapWithinTargetExpr(ctx, 'network', R), 'sli.resumeGapWithinTargetExpr (D30)'),
      q('restartReports', sli.resumeGapReportsExpr(ctx, 'server_restart', R), 'sli.resumeGapReportsExpr (D30)'),
      q('restartWithinTarget', sli.resumeGapWithinTargetExpr(ctx, 'server_restart', R), 'sli.resumeGapWithinTargetExpr (D30)'),
      q('reconnectsAtEnd', sli.counterTotalsByExpr(ctx, 'catan_ws_reconnects_total', 'outcome'), 'sli.counterTotalsByExpr (G2)'),
      q('disconnectsAtEnd', sli.counterTotalsByExpr(ctx, 'catan_ws_disconnects_total', 'reason'), 'sli.counterTotalsByExpr (G2)'),
      q('gapReportsAtEnd', sli.counterTotalsByExpr(ctx, 'catan_ws_resume_gap_reports_total', 'cause'), 'sli.counterTotalsByExpr (G2)'),
      q('success14d', sli.nfr6ReconnectSuccessExpr(ctx, '14d'), 'sli.nfr6ReconnectSuccessExpr (dashboard "NFR6 reconnect success (14 d)")'),
      q('attempts14d', sli.reconnectAttemptsExpr(ctx, '14d'), 'sli.reconnectAttemptsExpr'),
      q('gapShare14d', sli.nfr6GapShareExpr(ctx, 'network', '14d'), 'sli.nfr6GapShareExpr (dashboard "NFR6 network resume gaps < 5 s")'),
      q('gapReports14d', sli.resumeGapReportsExpr(ctx, 'network', '14d'), 'sli.resumeGapReportsExpr'),
    ],
    R8: [
      { key: 'probes', expr: sli.probeSamplesExpr(probe, R), source: 'sli.probeSamplesExpr (R8a)', kind: 'samples', at },
      q('failedProbes5mAtTo', sli.nfr9FailedProbes5mExpr(probe), 'sli.nfr9FailedProbes5mExpr (dashboard "NFR9 failed probes in 5 min")'),
      { key: 'anyLogLines', expr: sli.anyLogLinesExpr(ctx, R), source: 'sli.anyLogLinesExpr (Loki G3)', kind: 'loki', at },
      { key: 'deployForced', expr: sli.logLinesCountExpr(sli.eventLogQL(ctx, 'deploy.forced'), R), source: 'sli.logLinesCountExpr + sli.eventLogQL (R8b)', kind: 'loki', at },
      {
        key: 'restartsWithGames',
        expr: sli.logLinesCountExpr(sli.restartsWithGamesLogQL(ctx), R),
        source: 'sli.logLinesCountExpr + sli.restartsWithGamesLogQL (R8b)',
        kind: 'loki',
        at,
      },
      q('probes14d', sli.probeCountExpr(probe, '14d'), 'sli.probeCountExpr (R8c)'),
      q('passed14d', sli.probePassedExpr(probe, '14d'), 'sli.probePassedExpr (R8c)'),
      {
        key: 'activeGames',
        expr: sli.activeGamesExpr(ctx),
        source: 'sli.activeGamesExpr (R8 extent)',
        kind: 'range',
        start: i.from - ACTIVE_EXTENT_MARGIN_SEC,
        end: i.to + ACTIVE_EXTENT_MARGIN_SEC,
        step: 60,
      },
    ],
    R9: [
      q('lost', sli.nfr10LostOnRestartExpr(ctx, R), 'sli.nfr10LostOnRestartExpr (dashboard "NFR10 games lost on restart")'),
      q('lostPresent', sli.seriesPresentExpr(ctx, 'catan_games_lost_on_restart_total'), 'sli.seriesPresentExpr'),
      { key: 'anyLogLines', expr: sli.anyLogLinesExpr(ctx, R), source: 'sli.anyLogLinesExpr (Loki G3)', kind: 'loki', at },
      {
        key: 'logged',
        expr: sli.logFieldSumExpr(sli.eventLogQL(ctx, 'server.started'), 'lost_on_restart', R),
        source: 'sli.logFieldSumExpr + sli.eventLogQL (R9)',
        kind: 'loki',
        at,
      },
      { key: 'serverStarts', expr: sli.logLinesCountExpr(sli.eventLogQL(ctx, 'server.started'), R), source: 'sli.logLinesCountExpr + sli.eventLogQL (R9)', kind: 'loki', at },
    ],
    R10: [
      q('gamesFinished', sli.gamesFinishedExpr(ctx, R), 'sli.gamesFinishedExpr (R10)'),
      q('serverStartsByShutdown', sli.serverStartsByShutdownExpr(ctx, R), 'sli.serverStartsByShutdownExpr (R10)'),
      q('clientErrorsByKind', sli.clientErrorsByKindExpr(ctx, R), 'sli.clientErrorsByKindExpr (R10)'),
      q('telemetryDropped', sli.telemetryDroppedExpr(ctx, R), 'sli.telemetryDroppedExpr (R10)'),
    ],
  };
  if (i.resumeAt !== undefined) {
    const wAt = i.resumeAt + RESUME_AFTER_SEC;
    const W = `${RESUME_BEFORE_SEC + RESUME_AFTER_SEC}s`;
    out['R7'] = [
      { key: 'resumed', expr: sli.reconnectsResumedExpr(ctx, W), source: 'sli.reconnectsResumedExpr (R7)', kind: 'instant', at: wAt },
      { key: 'withinTarget', expr: sli.resumeGapWithinTargetExpr(ctx, null, W), source: 'sli.resumeGapWithinTargetExpr (D30, R7)', kind: 'instant', at: wAt },
      { key: 'reports', expr: sli.resumeGapReportsExpr(ctx, null, W), source: 'sli.resumeGapReportsExpr (D30, R7)', kind: 'instant', at: wAt },
      { key: 'reconnectEvents', expr: sli.reconnectEventsLogQL(ctx), source: 'sli.reconnectEventsLogQL (dashboard "Reconnect events")', kind: 'lines', start: i.resumeAt - RESUME_BEFORE_SEC, end: wAt },
    ];
  } else {
    out['R7'] = [];
  }
  return out;
}

// ── evaluation ───────────────────────────────────────────────────────────────

type Raw = Row[] | RangeRow[] | LokiStream[];
/** Query results by key; an Error when the query failed. */
type Results = Record<string, Raw | Error>;

const isError = (r: Raw | Error | undefined): r is Error => r instanceof Error;
/** A single unlabelled sample, or null when there is none (NaN, e.g. 0/0, is also null). */
function scalar(r: Raw | Error | undefined): number | null {
  if (r === undefined || isError(r) || r.length === 0) return null;
  const v = Number((r[0] as Row).value?.[1]);
  return Number.isFinite(v) ? v : null;
}
/** label value → sample, for a `sum by (label)` result. */
function byLabel(r: Raw | Error | undefined, label: string): Record<string, number> {
  if (r === undefined || isError(r)) return {};
  return Object.fromEntries((r as Row[]).map((row) => [row.metric[label] ?? '', Math.round(Number(row.value[1]) * 1000) / 1000]));
}
const round = (v: number | null, digits = 4): number | null => (v === null ? null : Math.round(v * 10 ** digits) / 10 ** digits);
/** Parsed JSON bodies of every Loki line, oldest first. */
function lokiEvents(r: Raw | Error | undefined): { ts: number; body: Record<string, unknown> }[] {
  if (r === undefined || isError(r)) return [];
  const out: { ts: number; body: Record<string, unknown> }[] = [];
  for (const s of r as LokiStream[]) {
    for (const [ns, line] of s.values) {
      try {
        out.push({ ts: Number(BigInt(ns) / 1_000_000n) / 1000, body: JSON.parse(line) as Record<string, unknown> });
      } catch {
        // A line that is not a JSON event is not one of ours.
      }
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}
const iso = (sec: number): string => new Date(sec * 1000).toISOString();

function item(id: string, title: string, required: boolean, specs: QuerySpec[], results: Results): Item {
  const it: Item = { id, title, required, verdict: 'NO_DATA', numbers: {}, n: null, queries: specs, notes: [], warnings: [] };
  for (const s of specs) {
    const r = results[s.key];
    if (isError(r)) it.warnings.push(`query ${s.key} failed: ${r.message}`);
  }
  return it;
}
const failed = (specs: QuerySpec[], results: Results, keys: readonly string[]): boolean =>
  specs.some((s) => keys.includes(s.key) && isError(results[s.key]));

/** R1/R2: a share-within-target verdict (≥ 0.95 passes), NO_DATA without observations. */
function shareItem(id: string, title: string, specs: QuerySpec[], r: Results, note: string): Item {
  const it = item(id, title, true, specs, r);
  const share = scalar(r['share']);
  const n = scalar(r['n']);
  it.n = n;
  it.numbers = { share: round(share), n, p95Sec: round(scalar(r['p95'])) };
  if (r['p95Ok'] !== undefined) it.numbers['p95OkSec'] = round(scalar(r['p95Ok']));
  if (r['wsRttP95'] !== undefined) it.numbers['diagnostic'] = { wsRttP95Sec: round(scalar(r['wsRttP95'])), deliveryP95Sec: round(scalar(r['deliveryP95'])) };
  it.notes.push(note);
  if (failed(specs, r, ['share', 'n']) || n === null || n === 0 || share === null) it.verdict = 'NO_DATA';
  else it.verdict = share >= 0.95 ? 'PASS' : 'FAIL';
  return it;
}

/**
 * R8 (a): one probe series' raw samples in [from, to] as a sequence of results. A gap longer than PROBE_GAP_SEC between
 * consecutive samples, or between a window edge and the nearest sample, is that many missed probes (each a failure);
 * two failures in a row, observed or missed, fail NFR9.
 */
export function probeSequence(s: RangeRow, from: number, to: number) {
  const samples = s.values.map(([t, x]) => [Number(t), Number(x)] as const).sort((a, b) => a[0] - b[0]);
  const results: boolean[] = [];
  let missed = 0;
  const gap = (sec: number) => {
    if (sec <= PROBE_GAP_SEC) return;
    const n = Math.max(1, Math.round(sec / PROBE_INTERVAL_SEC) - 1);
    missed += n;
    for (let k = 0; k < n; k++) results.push(false);
  };
  let prev = from;
  for (const [t, x] of samples) {
    gap(t - prev);
    results.push(x >= 1);
    prev = t;
  }
  gap(to - prev);
  const twoConsecutiveFailures = results.some((ok, k) => !ok && k > 0 && !results[k - 1]);
  return { samples: samples.length, passed: samples.filter(([, x]) => x >= 1).length, missed, twoConsecutiveFailures };
}

export function evaluate(i: ReportInput, q: Record<string, QuerySpec[]>, r: Record<string, Results>): Item[] {
  const items: Item[] = [];

  items.push(
    shareItem('R1', 'NFR1 server command latency: share ≤ 50 ms ≥ 0.95', q['R1']!, r['R1']!, 'The le="0.05" bucket is inclusive (≤ 50 ms) where the requirement says < 50 ms; every client command, timer skips excluded.'),
  );

  const r2 = shareItem('R2', 'NFR2 client action RTT: share ≤ 300 ms ≥ 0.95', q['R2']!, r['R2']!, 'Verdict metric catan.client.action_rtt; ws.rtt and delivery are diagnostics.');
  const dropped = scalar(r['R2']!['telemetryDropped']);
  r2.numbers['telemetryDropped'] = dropped;
  if (dropped !== null && dropped > 0) r2.warnings.push(`client telemetry dropped ${dropped} batch(es) or sample(s): the client metrics are incomplete`);
  items.push(r2);

  {
    const rr = r['R3']!;
    const it = item('R3', 'NFR3 server errors = 0 (D31), and no unclean start', true, q['R3']!, rr);
    const present = (scalar(rr['errorsPresent']) ?? 0) > 0 && (scalar(rr['startsPresent']) ?? 0) > 0;
    // Both counters are zero-initialised: present but without an increase sample is a real 0.
    const errors = scalar(rr['errors']) ?? (present ? 0 : null);
    const unclean = scalar(rr['uncleanStarts']) ?? (present ? 0 : null);
    it.numbers = { serverErrors: errors, uncleanStarts: unclean, errorsByComponent: byLabel(rr['errorsByComponent'], 'component') };
    it.notes.push('catan.errors{component="telemetry"} is shown in errorsByComponent but not counted (D31); drain 503s are never counted.');
    if (failed(q['R3']!, rr, ['errors', 'uncleanStarts', 'errorsPresent', 'startsPresent']) || !present || errors === null || unclean === null) it.verdict = 'NO_DATA';
    else it.verdict = errors === 0 && unclean === 0 ? 'PASS' : 'FAIL';
    items.push(it);
  }

  {
    const rr = r['R4']!;
    const it = item('R4', 'NFR4 rejected (rule|turn) < 2% of answered commands, auth excluded', true, q['R4']!, rr);
    const n = scalar(rr['n']);
    const rejected = scalar(rr['rejected']) ?? (n !== null ? 0 : null);
    const share = n !== null && n > 0 && rejected !== null ? rejected / n : null;
    it.n = n;
    it.numbers = { share: round(share), rejected, n, authRejections: scalar(rr['auth']), authByReason: byLabel(rr['authByReason'], 'reason_code') };
    it.notes.push('auth rejections are shown separately and never counted.');
    if (failed(q['R4']!, rr, ['n', 'rejected']) || share === null) it.verdict = 'NO_DATA';
    else it.verdict = share < 0.02 ? 'PASS' : 'FAIL';
    items.push(it);
  }

  {
    const rr = r['R5']!;
    const it = item('R5', 'NFR5 unplanned disconnects < 1 per player-hour', true, q['R5']!, rr);
    const hours = scalar(rr['playerHours']);
    const unplanned = scalar(rr['unplanned']) ?? (hours !== null ? 0 : null);
    const rate = hours !== null && hours > 0 && unplanned !== null ? unplanned / hours : null;
    it.n = round(hours, 3);
    it.numbers = { perPlayerHour: round(rate), unplanned, playerHours: round(hours, 3), byReason: byLabel(rr['byReason'], 'reason') };
    it.notes.push('client_backgrounded, server_restart, client_closed and superseded are not unplanned (by construction).');
    if (failed(q['R5']!, rr, ['playerHours', 'unplanned']) || rate === null) it.verdict = 'NO_DATA';
    else it.verdict = rate < 1 ? 'PASS' : 'FAIL';
    items.push(it);
  }

  {
    const rr = r['R6']!;
    const it = item('R6', 'NFR6 reconnects: raw counts only (no verdict from one night)', false, q['R6']!, rr);
    const attempts14d = scalar(rr['attempts14d']);
    const gapReports14d = scalar(rr['gapReports14d']);
    const success14d = scalar(rr['success14d']);
    const gapShare14d = scalar(rr['gapShare14d']);
    it.numbers = {
      byOutcome: byLabel(rr['byOutcome'], 'outcome'),
      network: { reports: scalar(rr['networkReports']), withinTarget: scalar(rr['networkWithinTarget']) },
      serverRestart: { reports: scalar(rr['restartReports']), withinTarget: scalar(rr['restartWithinTarget']) },
      totalsAtEnd: {
        reconnectsByOutcome: byLabel(rr['reconnectsAtEnd'], 'outcome'),
        disconnectsByReason: byLabel(rr['disconnectsAtEnd'], 'reason'),
        gapReportsByCause: byLabel(rr['gapReportsAtEnd'], 'cause'),
      },
      context14d: {
        reconnectSuccess: success14d === null ? `no verdict, n=${attempts14d ?? 0}` : { share: round(success14d), n: attempts14d, verdict: success14d >= 0.99 ? 'PASS' : 'FAIL' },
        networkGapShare: gapShare14d === null ? `no verdict, n=${gapReports14d ?? 0}` : { share: round(gapShare14d), n: gapReports14d, verdict: gapShare14d >= 0.95 ? 'PASS' : 'FAIL' },
      },
    };
    it.notes.push('One night never carries an NFR6 verdict (D30, A28); 14-day context shows a verdict only at n ≥ 100.');
    it.verdict = 'NO_VERDICT';
    items.push(it);
  }

  {
    const rr = r['R7'] ?? {};
    const it = item('R7', 'AC35 deliberate mid-game reconnect (resumed, client gap < 5 s)', i.resumeAt !== undefined, q['R7']!, rr);
    if (i.resumeAt === undefined) {
      it.verdict = 'NO_VERDICT';
      it.notes.push('No --resume-at given; the deliberate reconnect is confirmed manually (V44).');
    } else {
      const resumed = scalar(rr['resumed']);
      const within = scalar(rr['withinTarget']);
      const reports = scalar(rr['reports']);
      const events = lokiEvents(rr['reconnectEvents']).map((e) => ({
        at: iso(e.ts),
        outcome: e.body['outcome'] ?? null,
        gap_s: e.body['gap_s'] ?? null,
        seq_behind: e.body['seq_behind'] ?? null,
      }));
      it.n = reports;
      it.numbers = { window: [iso(i.resumeAt - RESUME_BEFORE_SEC), iso(i.resumeAt + RESUME_AFTER_SEC)], resumed, withinTarget: within, reports, reconnectEvents: events };
      it.notes.push('A human still confirms "same state, back within 5 s" (V44); gap_s is null after a restart (D29).');
      if (failed(q['R7']!, rr, ['resumed', 'withinTarget', 'reports']) || resumed === null || within === null || reports === null) it.verdict = 'NO_DATA';
      else it.verdict = resumed >= 1 && within >= 1 && reports >= 1 ? 'PASS' : 'FAIL';
    }
    items.push(it);
  }

  /** Loki G3: no line at all for the environment in the window means the logs are missing (NO_DATA), not quiet. */
  const logsPresent = (rr: Results): boolean | null => {
    if (rr['anyLogLines'] === undefined || isError(rr['anyLogLines'])) return null;
    return (scalar(rr['anyLogLines']) ?? 0) > 0;
  };
  /** A LogQL count: with logs present, an empty result is a real 0. */
  const logCount = (rr: Results, key: string): number | null => (logsPresent(rr) && !isError(rr[key]) ? (scalar(rr[key]) ?? 0) : null);

  {
    const rr = r['R8']!;
    const it = item('R8', 'NFR9 availability: no 2 consecutive failed probes, no deploy or restart with games active', true, q['R8']!, rr);
    const probes = rr['probes'];
    const series = isError(probes) || probes === undefined ? [] : (probes as RangeRow[]);
    const verdicts = series.map((s) => probeSequence(s, i.from, i.to));
    const total = verdicts.reduce((n, x) => n + x.samples, 0);
    const passed = verdicts.reduce((n, x) => n + x.passed, 0);
    const missed = verdicts.reduce((n, x) => n + x.missed, 0);
    const adjacent = verdicts.some((x) => x.twoConsecutiveFailures);
    if (missed > 0) it.warnings.push(`${missed} probe(s) missing (a gap over ${PROBE_GAP_SEC} s between samples or at a window edge); counted as failed`);
    const lokiOk = logsPresent(rr);
    const forced = logCount(rr, 'deployForced');
    const restarts = logCount(rr, 'restartsWithGames');
    const active = rr['activeGames'];
    const activeTs = (isError(active) || active === undefined ? [] : (active as RangeRow[])).flatMap((s) => s.values.filter(([, x]) => Number(x) > 0).map(([t]) => t));
    const extent = activeTs.length === 0 ? null : { first: iso(Math.min(...activeTs)), last: iso(Math.max(...activeTs)) };
    if (activeTs.length > 0 && (Math.min(...activeTs) < i.from || Math.max(...activeTs) > i.to)) {
      it.warnings.push('games were active outside the declared window (v1.6: the window is declared or active > 0); consider widening --from/--to');
    }
    it.n = total;
    it.numbers = {
      probes: { series: series.length, samples: total, passed, missed, twoConsecutiveFailures: adjacent },
      failedProbes5mAtTo: scalar(rr['failedProbes5mAtTo']),
      logLinesInWindow: scalar(rr['anyLogLines']),
      deployForced: forced,
      restartsWithGamesActive: restarts,
      activeGameExtent: extent,
      context14d: { probes: scalar(rr['probes14d']), passed: scalar(rr['passed14d']), verdict: 'no verdict from one night' },
    };
    if (lokiOk !== true) it.notes.push('No log lines for this environment in the window (or no --loki-url): the deploy and restart checks have no data.');
    if (series.length === 0 || failed(q['R8']!, rr, ['probes', 'anyLogLines', 'deployForced', 'restartsWithGames']) || forced === null || restarts === null) {
      it.verdict = 'NO_DATA';
    } else it.verdict = !adjacent && forced === 0 && restarts === 0 ? 'PASS' : 'FAIL';
    items.push(it);
  }

  {
    const rr = r['R9']!;
    const it = item('R9', 'NFR10 games lost on restart = 0 (metric and logs agree)', true, q['R9']!, rr);
    const present = (scalar(rr['lostPresent']) ?? 0) > 0;
    const metric = present ? scalar(rr['lost']) : null;
    const logged = logCount(rr, 'logged');
    it.numbers = { metric, logged, serverStartsInWindow: logCount(rr, 'serverStarts'), logLinesInWindow: scalar(rr['anyLogLines']) };
    if (failed(q['R9']!, rr, ['lost', 'lostPresent', 'anyLogLines', 'logged']) || !present || metric === null || logged === null) it.verdict = 'NO_DATA';
    else if (metric !== logged) {
      it.verdict = 'FAIL';
      it.warnings.push(`the metric (${metric}) and the server.started logs (${logged}) disagree`);
    } else it.verdict = metric === 0 ? 'PASS' : 'FAIL';
    items.push(it);
  }

  {
    const rr = r['R10']!;
    const it = item('R10', 'Context (no verdict)', false, q['R10']!, rr);
    it.verdict = 'NO_VERDICT';
    it.numbers = {
      gamesFinished: scalar(rr['gamesFinished']),
      serverStartsByShutdown: byLabel(rr['serverStartsByShutdown'], 'shutdown'),
      clientErrorsByKind: byLabel(rr['clientErrorsByKind'], 'kind'),
      telemetryDropped: scalar(rr['telemetryDropped']),
    };
    it.notes.push('A human confirms a game reached finished without a blocking bug (AC34).');
    items.push(it);
  }
  return items;
}

/** G4: 1 on any FAIL (a confirmed breach); else 2 when the evidence is incomplete (a required NO_DATA or a failed query); else 0. */
export function exitCode(items: readonly Item[]): 0 | 1 | 2 {
  if (items.some((i) => i.verdict === 'FAIL')) return 1;
  if (incomplete(items).length > 0) return 2;
  return 0;
}

/** Items whose evidence is incomplete: a required item without data, or any failed query. */
export function incomplete(items: readonly Item[]): string[] {
  return items.filter((i) => (i.required && i.verdict === 'NO_DATA') || i.warnings.some((w) => w.startsWith('query '))).map((i) => i.id);
}

/** Runs every query against `backend` and evaluates them. A failed query is recorded, never thrown. */
export async function runReport(i: ReportInput, backend: Backend): Promise<{ items: Item[]; seriesCount: unknown }> {
  const q = buildQueries(i);
  const r: Record<string, Results> = {};
  for (const [id, specs] of Object.entries(q)) {
    r[id] = {};
    for (const s of specs) {
      try {
        if (s.kind === 'instant') r[id][s.key] = await backend.instant(s.expr, s.at!);
        else if (s.kind === 'samples') r[id][s.key] = await backend.samples(s.expr, s.at!);
        else if (s.kind === 'range') r[id][s.key] = await backend.range(s.expr, s.start!, s.end!, s.step!);
        else if (s.kind === 'loki' && backend.lokiInstant !== null) r[id][s.key] = await backend.lokiInstant(s.expr, s.at!);
        else if (s.kind === 'lines' && backend.lokiLines !== null) r[id][s.key] = await backend.lokiLines(s.expr, s.start!, s.end!);
      } catch (e) {
        r[id][s.key] = e instanceof Error ? e : new Error('query failed');
      }
    }
  }
  const items = evaluate(i, q, r);
  let seriesCount: unknown = null;
  if (backend.seriesCount !== null) {
    try {
      seriesCount = await backend.seriesCount();
    } catch (e) {
      seriesCount = { error: e instanceof Error ? e.message : 'failed' };
    }
  }
  const context = items.find((x) => x.id === 'R10');
  if (context) context.numbers['seriesCount'] = seriesCount;
  return { items, seriesCount };
}

/** The human-readable table: one line per item, then each item's numbers, notes, warnings and queries. */
export function renderTable(i: ReportInput, items: readonly Item[]): string {
  const lines = [`Game-night report  cluster=${i.cluster}  window=${iso(i.from)} … ${iso(i.to)} (${i.to - i.from} s)`, ''];
  const missing = incomplete(items);
  if (missing.length > 0) lines.push(`!! INCOMPLETE EVIDENCE: ${missing.join(', ')} (no data or a failed query; see below)`, '');
  for (const it of items) lines.push(`${it.id.padEnd(4)} ${it.verdict.padEnd(10)} n=${String(it.n ?? '-').padEnd(10)} ${it.title}`);
  for (const it of items) {
    lines.push('', `── ${it.id} ${it.title}: ${it.verdict}`, `   numbers: ${JSON.stringify(it.numbers)}`);
    for (const n of it.notes) lines.push(`   note: ${n}`);
    for (const w of it.warnings) lines.push(`   WARN: ${w}`);
    for (const s of it.queries) {
      const when = s.at !== undefined ? `@${iso(s.at)}` : `${iso(s.start!)} … ${iso(s.end!)}${s.step ? ` step ${s.step}s` : ''}`;
      lines.push(`   [${s.key}] ${s.kind} ${when}  (${s.source})`, `      ${s.expr}`);
    }
  }
  return lines.join('\n');
}

const parseTime = (name: string, v: string | undefined): number => {
  const t = v === undefined ? NaN : Date.parse(v);
  if (!Number.isFinite(t)) throw new Error(`--${name} must be an ISO 8601 UTC time`);
  return Math.floor(t / 1000);
};

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      'prom-url': { type: 'string' },
      'loki-url': { type: 'string' },
      cluster: { type: 'string', default: 'prod' },
      'probe-job': { type: 'string', default: 'catan-healthz' },
      'probe-instance': { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      'resume-at': { type: 'string' },
      json: { type: 'boolean', default: false },
      out: { type: 'string' },
    },
  });
  if (!values['prom-url']) throw new Error('--prom-url is required');
  if (!values['probe-instance']) throw new Error('--probe-instance is required (the probed /healthz URL)');
  const input: ReportInput = {
    cluster: values.cluster!,
    probeJob: values['probe-job']!,
    probeInstance: values['probe-instance'],
    from: parseTime('from', values.from),
    to: parseTime('to', values.to),
    ...(values['resume-at'] ? { resumeAt: parseTime('resume-at', values['resume-at']) } : {}),
  };
  if (input.to <= input.from) throw new Error('--to must be after --from');
  const promUrl = values['prom-url'];
  const lokiUrl = values['loki-url'];
  const backend: Backend = {
    instant: (expr, at) => promQuery(promUrl, expr, at),
    samples: (expr, at) => promSamplesQuery(promUrl, expr, at),
    range: (expr, start, end, step) => promRangeQuery(promUrl, expr, start, end, step),
    lokiInstant: lokiUrl ? (logql, at) => lokiInstantQuery(lokiUrl, logql, at) : null,
    lokiLines: lokiUrl ? (logql, start, end) => lokiQueryRange(lokiUrl, logql, start, end) : null,
    seriesCount: () => countSeries(promUrl.replace(/\/$/, ''), input.cluster),
  };
  const { items } = await runReport(input, backend);
  const code = exitCode(items);
  const json = { cluster: input.cluster, from: iso(input.from), to: iso(input.to), exitCode: code, items };
  if (values.out) writeFileSync(values.out, `${JSON.stringify(json, null, 2)}\n`);
  console.log(values.json ? JSON.stringify(json, null, 2) : renderTable(input, items));
  return code;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(2);
    },
  );
}
