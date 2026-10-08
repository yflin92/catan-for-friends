// V32 series count (verification plan V32; design §9.2, D30): how many active series one environment sends, against
// the < 500 limit and the app budget (worstCaseSeries(), the catalogue plus the runtime reservation), with a
// per-metric breakdown, and whether the resource attributes arrive. Queries a Prometheus HTTP API: the local one
// (deploy/validate) or Grafana's datasource proxy for Grafana Cloud. Credentials come from the environment or the URL
// (prom-client.ts) and never reach an output. Exits 1 when a check fails.
//
//   node --experimental-strip-types --no-warnings --import ./tooling/ts-resolve-hook.mjs tooling/load/series-count.ts \
//     --prom-url http://127.0.0.1:3000/api/datasources/proxy/uid/grafanacloud-prom --cluster loadtest
import { parseArgs } from 'node:util';
import { worstCaseSeries } from '../../apps/server/src/metrics';
import { promQuery, type Row } from './prom-client';

/** Verification plan V32: fewer than this many active series per environment, Alloy's own included. */
export const SERIES_LIMIT = 500;
/**
 * Name stems of every self-metric Alloy v1.11.3 exposes on /metrics with deploy/alloy/config.alloy, idle and under
 * load, in both spellings: underscored (classic negotiation) and dotted (Prometheus 3 negotiates UTF-8 names such as
 * http.server.request.duration_seconds). Fixture: tooling/load/__fixtures__/alloy-v1.11.3-self-metrics.txt.
 */
export const ALLOY_SELF_STEMS = [
  'alloy',
  'otelcol',
  'otel',
  'prometheus',
  'loki',
  'go',
  'process',
  'rpc',
  'http',
  'net[._]conntrack',
  'postgres[._]exporter',
  'deprecated[._]flags',
];
/**
 * A vector whose metric name is also a label. PromQL set operators match label sets WITHOUT __name__, so in `a or b`
 * a series of b is dropped when some series of a has the same other labels, even under a different name (e.g. up and
 * process_cpu_seconds_total of one target); naming every operand makes each union de-duplicate by full identity.
 */
export const named = (expr: string): string => `label_replace(${expr}, "series_name", "$1", "__name__", "(.+)")`;
/** Alloy's own metric names, in either spelling. */
export const ALLOY_SELF_NAMES = `__name__=~"(${ALLOY_SELF_STEMS.join('|')})[._].*"`;
/**
 * Every series an Alloy self-export adds: its own metrics, plus the up / scrape_* series Prometheus records for each
 * Alloy target (matched on job and instance against that target's alloy_build_info). They count against the limit
 * should Alloy ever export its own metrics; with G6 it exports none.
 */
export const ALLOY_SELF = `${named(`{${ALLOY_SELF_NAMES}}`)} or ${named('{__name__=~"up|scrape_.*"} and on(job, instance) {__name__=~"alloy[._]build[._]info"}')}`;
/**
 * Resource attributes on target_info, as Alloy's Prometheus exporter writes them: service.name → job,
 * service.instance.id → instance, service.version and deployment.environment from the server (§9.1), and cluster and
 * namespace, which Alloy sets on the resource as well as on every datapoint.
 */
export const RESOURCE_LABELS = ['job', 'instance', 'service_version', 'deployment_environment', 'cluster', 'namespace'] as const;

/** The environment's series; deployment_environment also finds a target_info that lacks the cluster label. */
export const environmentSelector = (cluster: string): string =>
  `${named(`{cluster="${cluster}"}`)} or ${named(`{deployment_environment="${cluster}"}`)}`;

/**
 * The limit's subject: the environment's series and Alloy's own as ONE union, so a self series that also carries
 * cluster=<env> is counted once (PromQL `or` keeps each label set once).
 */
export const totalExpr = (cluster: string): string => `count((${environmentSelector(cluster)}) or (${ALLOY_SELF}))`;

const query = (promUrl: string, q: string): Promise<Row[]> => promQuery(promUrl, q);

const scalar = (rows: Row[]): number => (rows.length === 0 ? 0 : Number(rows[0]!.value[1]));

export interface SeriesCount {
  cluster: string;
  environmentSeries: number;
  /** The environment and Alloy's own series as one union: what the limit applies to. */
  totalSeries: number;
  limit: number;
  appSeries: number;
  appBudget: number;
  alloySelfSeries: number;
  /** Series in this Prometheus that belong to no environment (e.g. the local SM emulation and Prometheus' own scrape series); not counted. */
  otherSeries: number;
  catanSeriesWithoutClusterOrNamespace: number;
  byMetric: Record<string, number>;
  targetInfo: Record<string, string>[];
  missingResourceLabels: string[];
  ok: boolean;
}

export async function countSeries(promUrl: string, cluster: string): Promise<SeriesCount> {
  const env = `cluster="${cluster}"`;
  const selector = environmentSelector(cluster);
  const byMetricRows = await query(promUrl, `count by (__name__) (${selector})`);
  const byMetric = Object.fromEntries(
    byMetricRows.map((r) => [r.metric['__name__'] ?? '', Number(r.value[1])] as const).sort(([a], [b]) => a.localeCompare(b)),
  );
  const environmentSeries = scalar(await query(promUrl, `count(${selector})`));
  const appSeries = scalar(await query(promUrl, `count({${env},__name__=~"catan_.*"})`));
  const alloySelfSeries = scalar(await query(promUrl, `count(${ALLOY_SELF})`));
  const totalSeries = scalar(await query(promUrl, totalExpr(cluster)));
  const unlabelled = scalar(await query(promUrl, 'count({__name__=~"catan_.*",cluster=""} or {__name__=~"catan_.*",namespace=""})'));
  const otherSeries = scalar(await query(promUrl, 'count({__name__!="",cluster="",deployment_environment=""})'));
  const targetInfo = (await query(promUrl, `target_info{deployment_environment="${cluster}"}`)).map((r) =>
    Object.fromEntries(RESOURCE_LABELS.filter((k) => r.metric[k] !== undefined).map((k) => [k, r.metric[k]!])),
  );
  const missingResourceLabels = RESOURCE_LABELS.filter((k) => targetInfo.length === 0 || targetInfo.some((t) => t[k] === undefined));
  const appBudget = worstCaseSeries();
  return {
    cluster,
    environmentSeries,
    totalSeries,
    limit: SERIES_LIMIT,
    appSeries,
    appBudget,
    alloySelfSeries,
    otherSeries,
    catanSeriesWithoutClusterOrNamespace: unlabelled,
    byMetric,
    targetInfo,
    missingResourceLabels,
    ok: totalSeries < SERIES_LIMIT && appSeries > 0 && appSeries <= appBudget && unlabelled === 0 && missingResourceLabels.length === 0,
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
