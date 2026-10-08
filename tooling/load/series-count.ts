// V32 series count (verification plan V32; design §9.2, D30): how many active series one environment sends, against
// the < 500 limit and the app budget (worstCaseSeries(), the catalogue plus the runtime reservation), with a
// per-metric breakdown, and whether the resource attributes arrive. Queries a Prometheus HTTP API: the local one
// (deploy/validate) or Grafana's datasource proxy for Grafana Cloud. Credentials come from the environment
// (GRAFANA_SA_TOKEN or GRAFANA_BASIC_AUTH) and are never printed. Exits 1 when a check fails.
//
//   node --experimental-strip-types --no-warnings --import ./tooling/ts-resolve-hook.mjs tooling/load/series-count.ts \
//     --prom-url http://127.0.0.1:3000/api/datasources/proxy/uid/grafanacloud-prom --cluster loadtest
import { parseArgs } from 'node:util';
import { worstCaseSeries } from '../../apps/server/src/metrics';
import { authHeader } from './server-report';

/** Verification plan V32: fewer than this many active series per environment, Alloy's own included. */
export const SERIES_LIMIT = 500;
/** Alloy, OTel-collector and remote-write self-metric names, should Alloy ever export its own. */
export const ALLOY_SELF = '__name__=~"alloy_.*|otelcol_.*|prometheus_remote_storage_.*|prometheus_wal_.*"';
/** Resource attributes the server sets (§9.1), as Alloy's Prometheus exporter writes them on target_info. */
export const RESOURCE_LABELS = ['job', 'instance', 'service_version', 'deployment_environment', 'cluster', 'namespace'] as const;

type Row = { metric: Record<string, string>; value: [number, string] };

async function query(promUrl: string, q: string): Promise<Row[]> {
  const res = await fetch(`${promUrl}/api/v1/query?query=${encodeURIComponent(q)}`, { headers: authHeader() });
  if (!res.ok) throw new Error(`Prometheus query → ${res.status}`);
  return ((await res.json()) as { data: { result: Row[] } }).data.result;
}

const scalar = (rows: Row[]): number => (rows.length === 0 ? 0 : Number(rows[0]!.value[1]));

export interface SeriesCount {
  cluster: string;
  environmentSeries: number;
  limit: number;
  appSeries: number;
  appBudget: number;
  alloySelfSeries: number;
  catanSeriesWithoutClusterOrNamespace: number;
  byMetric: Record<string, number>;
  targetInfo: Record<string, string>[];
  missingResourceLabels: string[];
  ok: boolean;
}

export async function countSeries(promUrl: string, cluster: string): Promise<SeriesCount> {
  const env = `cluster="${cluster}"`;
  const byMetricRows = await query(promUrl, `count by (__name__) ({${env}})`);
  const byMetric = Object.fromEntries(
    byMetricRows.map((r) => [r.metric['__name__'] ?? '', Number(r.value[1])] as const).sort(([a], [b]) => a.localeCompare(b)),
  );
  const environmentSeries = scalar(await query(promUrl, `count({${env}})`));
  const appSeries = scalar(await query(promUrl, `count({${env},__name__=~"catan_.*"})`));
  const alloySelfSeries = scalar(await query(promUrl, `count({${ALLOY_SELF}})`));
  const unlabelled = scalar(await query(promUrl, 'count({__name__=~"catan_.*",cluster=""} or {__name__=~"catan_.*",namespace=""})'));
  const targetInfo = (await query(promUrl, `target_info{${env}}`)).map((r) =>
    Object.fromEntries(RESOURCE_LABELS.filter((k) => r.metric[k] !== undefined).map((k) => [k, r.metric[k]!])),
  );
  const missingResourceLabels = RESOURCE_LABELS.filter((k) => targetInfo.length === 0 || targetInfo.some((t) => t[k] === undefined));
  const appBudget = worstCaseSeries();
  const total = environmentSeries + alloySelfSeries;
  return {
    cluster,
    environmentSeries,
    limit: SERIES_LIMIT,
    appSeries,
    appBudget,
    alloySelfSeries,
    catanSeriesWithoutClusterOrNamespace: unlabelled,
    byMetric,
    targetInfo,
    missingResourceLabels,
    ok: total < SERIES_LIMIT && appSeries <= appBudget && unlabelled === 0 && missingResourceLabels.length === 0,
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { 'prom-url': { type: 'string' }, cluster: { type: 'string', default: 'loadtest' } } });
  if (!values['prom-url']) throw new Error('--prom-url is required');
  const r = await countSeries(values['prom-url'].replace(/\/$/, ''), values.cluster!);
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
