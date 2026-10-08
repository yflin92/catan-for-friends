// Prometheus HTTP API client for the load-test tools (server-report.ts, series-count.ts). Credentials never reach an
// output: they come from the environment (GRAFANA_SA_TOKEN as a bearer token, GRAFANA_BASIC_AUTH as user:password) or
// from the URL's userinfo, which is moved into the Authorization header before the request. Every error names the URL
// with its userinfo and query removed, and carries only an error code, never the underlying message (Node's fetch
// echoes the full URL in its own errors).

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

/** One instant query; `atSec` defaults to now. Throws an Error whose message holds no credential. */
export async function promQuery(promUrl: string, query: string, atSec?: number): Promise<Row[]> {
  let u: URL;
  try {
    u = new URL(`${promUrl.replace(/\/$/, '')}/api/v1/query`);
  } catch {
    throw new Error(`Prometheus URL ${redactUrl(promUrl)} is not valid`);
  }
  const headers = authFor(u);
  const params = new URLSearchParams(u.search);
  params.set('query', query);
  if (atSec !== undefined) params.set('time', String(atSec));
  const target = `${u.protocol}//${u.host}${u.pathname}?${params.toString()}`;
  let res: Response;
  try {
    res = await fetch(target, { headers });
  } catch (e) {
    const code = (e as { cause?: { code?: unknown } }).cause?.code;
    // The caught error is deliberately not attached: its message holds the full URL, credentials included, and Node
    // prints an uncaught error's cause chain.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(`Prometheus query to ${redactUrl(promUrl)} failed${typeof code === 'string' ? ` (${code})` : ''}`);
  }
  if (!res.ok) throw new Error(`Prometheus query to ${redactUrl(promUrl)} → HTTP ${res.status}`);
  return ((await res.json()) as { data: { result: Row[] } }).data.result;
}
