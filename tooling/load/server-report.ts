// X-load server-side numbers (AC32): queries the run's window [startedAt, endedAt] from a load report against a
// Prometheus HTTP API — a local Prometheus (deploy/validate) or Grafana's datasource proxy for Grafana Cloud — scoped
// to {cluster, namespace="catan-server"}. Credentials come from the environment (GRAFANA_SA_TOKEN as a bearer token,
// or GRAFANA_BASIC_AUTH as user:password) and are never printed.
//
//   node --experimental-strip-types --no-warnings --import ./tooling/ts-resolve-hook.mjs tooling/load/server-report.ts \
//     --prom-url http://127.0.0.1:3000/api/datasources/proxy/uid/prometheus --cluster local --report load-report.json
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

/** The PromQL behind each reported number; `{S}` is the selector and `[R]` the run window. */
export const QUERIES: Readonly<Record<string, string>> = {
  nfr1ActionP95Sec: 'histogram_quantile(0.95, sum by (le) (increase(catan_action_duration_seconds_bucket{S}[R])))',
  nfr1ShareWithin50ms:
    'sum(increase(catan_action_duration_seconds_bucket{S,le="0.05"}[R])) / sum(increase(catan_action_duration_seconds_count{S}[R]))',
  actionsByResult: 'sum by (result) (increase(catan_actions_total{S}[R]))',
  rejectedByReason: 'sum by (reason_code) (increase(catan_actions_rejected_total{S}[R]))',
  errorsByComponent: 'sum by (component) (increase(catan_errors_total{S}[R]))',
  http5xx: 'sum(increase(catan_http_responses_5xx_total{S}[R]))',
  disconnectsByReason: 'sum by (reason) (increase(catan_ws_disconnects_total{S}[R]))',
  reconnectsByOutcome: 'sum by (outcome) (increase(catan_ws_reconnects_total{S}[R]))',
  resumeGapsByCause: 'sum by (cause) (increase(catan_ws_resume_gap_seconds_count{S}[R]))',
  resumeGapP95SecByCause: 'histogram_quantile(0.95, sum by (le, cause) (increase(catan_ws_resume_gap_seconds_bucket{S}[R])))',
  clientActionRttP95Sec: 'histogram_quantile(0.95, sum by (le) (increase(catan_client_action_rtt_seconds_bucket{S}[R])))',
  clientActionRttSamples: 'sum(increase(catan_client_action_rtt_seconds_count{S}[R]))',
  telemetryDropped: 'sum(increase(catan_telemetry_dropped_total{S}[R]))',
  serverStartsByShutdown: 'sum by (shutdown) (increase(catan_server_starts_total{S}[R]))',
};

/**
 * Raw counter totals at the end of the window (since the last server start), for the connection counters. increase()
 * cannot see a series' first sample, and these series are created at their first event, which after a restart is
 * exactly when the restart's disconnects, reconnects and resume gaps happen; the totals show what increase() misses.
 */
export const AT_END_QUERIES: Readonly<Record<string, string>> = {
  disconnectsByReasonAtEnd: 'sum by (reason) (catan_ws_disconnects_total{S})',
  reconnectsByOutcomeAtEnd: 'sum by (outcome) (catan_ws_reconnects_total{S})',
  resumeGapsByCauseAtEnd: 'sum by (cause) (catan_ws_resume_gap_seconds_count{S})',
};

/** The query with its selector and window filled in. */
export function expand(query: string, cluster: string, windowSec: number): string {
  const selector = `cluster="${cluster}",namespace="catan-server"`;
  return query.replaceAll('{S}', `{${selector}}`).replaceAll('{S,', `{${selector},`).replaceAll('[R]', `[${windowSec}s]`);
}

export function authHeader(): Record<string, string> {
  const token = process.env['GRAFANA_SA_TOKEN'];
  if (token) return { Authorization: `Bearer ${token}` };
  const basic = process.env['GRAFANA_BASIC_AUTH'];
  if (basic) return { Authorization: `Basic ${Buffer.from(basic).toString('base64')}` };
  return {};
}

type Value = number | Record<string, number> | null;

/** One instant query at `atSec`; a single unlabelled series becomes a number, labelled series a label → value map. */
async function instant(promUrl: string, query: string, atSec: number): Promise<Value> {
  const url = `${promUrl}/api/v1/query?query=${encodeURIComponent(query)}&time=${atSec}`;
  const res = await fetch(url, { headers: authHeader() });
  if (!res.ok) throw new Error(`Prometheus query → ${res.status}`);
  const body = (await res.json()) as { data: { result: { metric: Record<string, string>; value: [number, string] }[] } };
  const rows = body.data.result.map((r) => ({ label: Object.values(r.metric).join(',') || '', value: Number(r.value[1]) }));
  if (rows.length === 0) return null;
  const round = (v: number) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : v);
  if (rows.length === 1 && rows[0]!.label === '') return round(rows[0]!.value);
  return Object.fromEntries(rows.map((r) => [r.label, round(r.value)]));
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'prom-url': { type: 'string' },
      cluster: { type: 'string', default: 'loadtest' },
      report: { type: 'string', default: 'load-report.json' },
      out: { type: 'string' },
      // Extra seconds after endedAt, so the last remote-write (60 s interval) is included.
      'settle-sec': { type: 'string', default: '90' },
    },
  });
  if (!values['prom-url']) throw new Error('--prom-url is required');
  const run = JSON.parse(readFileSync(values.report!, 'utf8')) as { startedAt: string; endedAt: string };
  const start = Date.parse(run.startedAt) / 1000;
  const end = Date.parse(run.endedAt) / 1000 + Number(values['settle-sec']);
  const windowSec = Math.ceil(end - start);
  // The window ends settle-sec after the run, so the last remote-write lands first: wait until then if it is ahead.
  const waitMs = end * 1000 - Date.now();
  if (waitMs > 0) {
    console.error(`waiting ${Math.ceil(waitMs / 1000)} s for the settle window`);
    await new Promise((r) => setTimeout(r, waitMs));
  }
  const out: Record<string, Value> = {};
  const promUrl = values['prom-url'].replace(/\/$/, '');
  for (const [name, q] of Object.entries({ ...QUERIES, ...AT_END_QUERIES })) out[name] = await instant(promUrl, expand(q, values.cluster!, windowSec), Math.floor(end));
  const result = { cluster: values.cluster, windowStart: run.startedAt, windowSec, ...out };
  if (values.out) writeFileSync(values.out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    () => process.exit(0),
    (e: unknown) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    },
  );
}
