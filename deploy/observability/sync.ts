// Pushes the observability-as-code (alert rules, contact point, notification policy, the game-night time interval,
// the dashboard, game-night annotations and the Synthetic Monitoring check) to a Grafana stack through its HTTP APIs.
// Idempotent: every run replaces what the previous run created. deploy.sh runs it after each deploy, inside the
// catan-server image:  node --experimental-strip-types deploy/observability/sync.ts
//
// Environment (deploy/.env; secrets are never printed):
//   GRAFANA_URL               the stack, e.g. https://<stack>.grafana.net
//   GRAFANA_SA_TOKEN          a service-account token with alerting, dashboards and annotations write access
//   GRAFANA_BASIC_AUTH        user:password instead of a token (local validation Grafana only)
//   HEXLANDS_ENV              the cluster label (prod | loadtest)
//   HEXLANDS_SITE_ADDRESS     the public hostname; the probed URL is https://<it>/healthz
//   HEXLANDS_OPS_GAME_NIGHT_WINDOWS  JSON [{start, end}] (ops.gameNightWindows)
//   GRAFANA_PROM_UID / GRAFANA_LOKI_UID / GRAFANA_TEMPO_UID  data source uids (Grafana Cloud defaults)
//   GRAFANA_CONTACT_POINT     JSON {type, settings} replacing the placeholder contact point once Q11 is answered
//   SM_API_URL, SM_ACCESS_TOKEN, SM_PROBE_IDS  Synthetic Monitoring (skipped when unset)
//   GRAFANA_PROBE_INSTANCE    overrides the probed URL used in rule filters (local validation: blackbox target)
import { DASHBOARD_UID, dashboard } from './dashboard.ts';
import { FOLDER_UID, RULE_GROUP, ruleGroup, WINDOW_LABEL, type RuleContext } from './rules.ts';
import { CHECK_JOB, healthzCheck, healthzUrl } from './synthetic-monitoring.ts';
import { parseWindows, toAnnotations, toTimeRanges } from './windows.ts';

export const TIME_INTERVAL = 'game-night';
export const CONTACT_POINT_UID = 'catan-alerts';
/** A contact point that delivers nowhere, until the user picks email or a webhook (Q11). */
export const PLACEHOLDER_CONTACT = { type: 'webhook', settings: { url: 'https://q11-placeholder.invalid/catan-alerts' } };
/** Matches no time at all: the interval used while no game-night window is configured. */
const NEVER = [{ years: ['2000'], location: 'UTC' }];

const env = process.env;
const need = (k: string): string => {
  const v = env[k];
  if (v === undefined || v === '') throw new Error(`${k} is not set`);
  return v;
};

async function api(method: string, path: string, body?: unknown, ok: readonly number[] = []): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (env['GRAFANA_SA_TOKEN']) headers['Authorization'] = `Bearer ${env['GRAFANA_SA_TOKEN']}`;
  else if (env['GRAFANA_BASIC_AUTH']) headers['Authorization'] = `Basic ${Buffer.from(env['GRAFANA_BASIC_AUTH']).toString('base64')}`;
  const res = await fetch(new URL(path, need('GRAFANA_URL')), { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  if (!res.ok && !ok.includes(res.status)) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return { status: res.status, json: text === '' ? null : (JSON.parse(text) as unknown) };
}

/** PUT, falling back to POST on the collection when the resource does not exist yet. */
async function upsert(collection: string, name: string, body: unknown): Promise<void> {
  const put = await api('PUT', `${collection}/${encodeURIComponent(name)}`, body, [404]);
  if (put.status === 404) await api('POST', collection, body);
}

export function context(): RuleContext {
  const site = need('HEXLANDS_SITE_ADDRESS');
  return {
    cluster: env['HEXLANDS_ENV'] || 'prod',
    promUid: env['GRAFANA_PROM_UID'] || 'grafanacloud-prom',
    lokiUid: env['GRAFANA_LOKI_UID'] || 'grafanacloud-logs',
    tempoUid: env['GRAFANA_TEMPO_UID'] || 'grafanacloud-traces',
    probeJob: CHECK_JOB,
    probeInstance: env['GRAFANA_PROBE_INSTANCE'] || healthzUrl(site),
  };
}

export async function sync(): Promise<void> {
  const ctx = context();
  const windows = parseWindows(env['HEXLANDS_OPS_GAME_NIGHT_WINDOWS']);
  const log = (msg: string) => console.log(`[observability] ${msg}`);

  await api('POST', '/api/folders', { uid: FOLDER_UID, title: 'Catan' }, [409, 412]);
  log('folder catan');

  const ranges = toTimeRanges(windows);
  await upsert('/api/v1/provisioning/mute-timings', TIME_INTERVAL, { name: TIME_INTERVAL, time_intervals: ranges.length > 0 ? ranges : NEVER });
  log(`time interval ${TIME_INTERVAL}: ${windows.length} window(s)`);

  const contact = env['GRAFANA_CONTACT_POINT'] ? (JSON.parse(env['GRAFANA_CONTACT_POINT']) as typeof PLACEHOLDER_CONTACT) : PLACEHOLDER_CONTACT;
  await upsert('/api/v1/provisioning/contact-points', CONTACT_POINT_UID, { uid: CONTACT_POINT_UID, name: 'catan-alerts', ...contact });
  log(`contact point (${env['GRAFANA_CONTACT_POINT'] ? contact.type : 'placeholder, Q11'})`);

  await api('PUT', '/api/v1/provisioning/policies', {
    receiver: 'catan-alerts',
    group_by: ['alertname'],
    group_wait: '30s',
    group_interval: '5m',
    repeat_interval: '4h',
    routes: [
      {
        receiver: 'catan-alerts',
        object_matchers: Object.entries(WINDOW_LABEL).map(([k, v]) => [k, '=', v]),
        active_time_intervals: [TIME_INTERVAL],
      },
    ],
  });
  log('notification policy (grouped, repeat 4 h; the NFR9 window rule only inside game-night)');

  await api('PUT', `/api/v1/provisioning/folder/${FOLDER_UID}/rule-groups/${RULE_GROUP}`, ruleGroup(ctx));
  log(`rule group ${RULE_GROUP}`);

  await api('POST', '/api/dashboards/db', { dashboard: dashboard(ctx), folderUid: FOLDER_UID, overwrite: true });
  log(`dashboard ${DASHBOARD_UID}`);

  const old = (await api('GET', '/api/annotations?tags=catan&tags=game-night&matchAny=false&limit=1000')).json as { id: number }[];
  for (const a of old) await api('DELETE', `/api/annotations/${a.id}`);
  for (const a of toAnnotations(windows)) await api('POST', '/api/annotations', { ...a, tags: ['catan', 'game-night'] });
  log(`game-night annotations: ${windows.length}`);

  await syncSyntheticMonitoring(ctx.probeInstance, log);
}

async function syncSyntheticMonitoring(target: string, log: (m: string) => void): Promise<void> {
  const url = env['SM_API_URL'];
  const token = env['SM_ACCESS_TOKEN'];
  if (!url || !token) return log('synthetic monitoring: skipped (SM_API_URL / SM_ACCESS_TOKEN unset)');
  const probes = (env['SM_PROBE_IDS'] ?? '').split(',').filter((p) => p !== '').map(Number);
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(new URL(path, url), {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) throw new Error(`SM ${method} ${path} → ${res.status}`);
    return (await res.json()) as unknown;
  };
  const existing = ((await call('GET', '/api/v1/check/list')) as { id: number; tenantId: number; job: string; target: string }[]).find(
    (c) => c.job === CHECK_JOB && c.target === target,
  );
  const check = healthzCheck(target, probes);
  if (existing) await call('POST', '/api/v1/check/update', { ...check, id: existing.id, tenantId: existing.tenantId });
  else await call('POST', '/api/v1/check/add', check);
  log(`synthetic monitoring: ${CHECK_JOB} → ${target} every 120 s`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  sync().catch((err: unknown) => {
    console.error(`[observability] sync failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
