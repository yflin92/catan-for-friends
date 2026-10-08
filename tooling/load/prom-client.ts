// Prometheus and Loki HTTP API client for the load-test and report tools (server-report.ts, series-count.ts,
// gamenight-report.ts). Credentials never reach an output: they come from the environment (GRAFANA_SA_TOKEN as a
// bearer token, GRAFANA_BASIC_AUTH as user:password) or from the URL's userinfo, which is moved into the
// Authorization header before the request. Every error names the URL with its userinfo and query removed, and carries
// only an error code, never the underlying message (Node's fetch echoes the full URL in its own errors).

/** The URL without userinfo or query: what errors may show. */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname}${u.search === '' ? '' : '?…'}`;
  } catch {
    return '<unparseable URL>';
  }
}

/** Authorization from the environment, or from userinfo in the URL. */
function authFor(u: URL): Record<string, string> {
  const token = process.env['GRAFANA_SA_TOKEN'];
  if (token) return { Authorization: `Bearer ${token}` };
  const basic = process.env['GRAFANA_BASIC_AUTH'];
  if (basic) return { Authorization: `Basic ${Buffer.from(basic).toString('base64')}` };
  if (u.username !== '' || u.password !== '') {
    const pair = `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`;
    return { Authorization: `Basic ${Buffer.from(pair).toString('base64')}` };
  }
  return {};
}

export type Row = { metric: Record<string, string>; value: [number, string] };
export type RangeRow = { metric: Record<string, string>; values: [number, string][] };
export type LokiStream = { stream: Record<string, string>; values: [string, string][] };

/**
 * GET `<base><apiPath>?<params>` with the credentials as headers, never in the URL. `kind` names the backend in errors.
 * Throws an Error whose message holds no credential.
 */
async function getJson(kind: string, base: string, apiPath: string, query: Record<string, string>): Promise<unknown> {
  let u: URL;
  try {
    // The API path goes after the base URL's path; any query string on the base URL is kept as parameters.
    u = new URL(base);
    u.pathname = `${u.pathname.replace(/\/$/, '')}${apiPath}`;
  } catch {
    throw new Error(`${kind} URL ${redactUrl(base)} is not valid`);
  }
  const headers = authFor(u);
  const params = new URLSearchParams(u.search);
  for (const [k, v] of Object.entries(query)) params.set(k, v);
  const target = `${u.protocol}//${u.host}${u.pathname}?${params.toString()}`;
  let res: Response;
  try {
    res = await fetch(target, { headers });
  } catch (e) {
    const code = (e as { cause?: { code?: unknown } }).cause?.code;
    // The caught error is deliberately not attached: its message holds the full URL, credentials included, and Node
    // prints an uncaught error's cause chain.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(`${kind} query to ${redactUrl(base)} failed${typeof code === 'string' ? ` (${code})` : ''}`);
  }
  if (!res.ok) throw new Error(`${kind} query to ${redactUrl(base)} → HTTP ${res.status}`);
  return res.json();
}

/** One instant query; `atSec` defaults to now. Throws an Error whose message holds no credential. */
export async function promQuery(promUrl: string, query: string, atSec?: number): Promise<Row[]> {
  const json = (await getJson('Prometheus', promUrl, '/api/v1/query', { query, ...(atSec !== undefined ? { time: String(atSec) } : {}) })) as {
    data: { result: Row[] };
  };
  return json.data.result;
}

/** One range query over [startSec, endSec] at `stepSec`. Throws an Error whose message holds no credential. */
export async function promRangeQuery(promUrl: string, query: string, startSec: number, endSec: number, stepSec: number): Promise<RangeRow[]> {
  const json = (await getJson('Prometheus', promUrl, '/api/v1/query_range', {
    query,
    start: String(startSec),
    end: String(endSec),
    step: String(stepSec),
  })) as { data: { result: RangeRow[] } };
  return json.data.result;
}

/**
 * Log lines of one LogQL query in [startSec, endSec], oldest first, at most `limit`. `lokiUrl` is a Loki base URL (or
 * Grafana's datasource proxy for it). Throws an Error whose message holds no credential.
 */
export async function lokiQueryRange(lokiUrl: string, query: string, startSec: number, endSec: number, limit = 5000): Promise<LokiStream[]> {
  const json = (await getJson('Loki', lokiUrl, '/loki/api/v1/query_range', {
    query,
    start: String(BigInt(Math.floor(startSec)) * 1_000_000_000n),
    end: String(BigInt(Math.floor(endSec)) * 1_000_000_000n),
    limit: String(limit),
    direction: 'forward',
  })) as { data: { result: LokiStream[] } };
  return json.data.result;
}

/** One instant query of a range vector (raw samples per series). Throws an Error whose message holds no credential. */
export async function promSamplesQuery(promUrl: string, query: string, atSec: number): Promise<RangeRow[]> {
  const json = (await getJson('Prometheus', promUrl, '/api/v1/query', { query, time: String(atSec) })) as { data: { result: RangeRow[] } };
  return json.data.result;
}

/** One instant LogQL metric query (e.g. count_over_time) at `atSec`. Throws an Error whose message holds no credential. */
export async function lokiInstantQuery(lokiUrl: string, query: string, atSec: number): Promise<Row[]> {
  const json = (await getJson('Loki', lokiUrl, '/loki/api/v1/query', {
    query,
    time: String(BigInt(Math.floor(atSec)) * 1_000_000_000n),
  })) as { data: { result: Row[] } };
  return json.data.result;
}
