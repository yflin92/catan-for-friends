// Grafana Synthetic Monitoring HTTP check on /healthz (X-alerts item 3): every 120 s from the configured probes. Its
// probe_success series carry job = the check's job name and instance = the probed URL, which A2 and the NFR9 rules
// filter on. Runs only on Grafana Cloud; the local validation stack emulates it with blackbox-exporter.

export const CHECK_JOB = 'catan-healthz';
export const FREQUENCY_MS = 120_000;

/** The probed URL for a site address such as play.example.org or http://localhost. */
export function healthzUrl(siteAddress: string): string {
  const base = /^https?:\/\//.test(siteAddress) ? siteAddress : `https://${siteAddress}`;
  return `${base.replace(/\/+$/, '')}/healthz`;
}

/** The check body for the Synthetic Monitoring API (check/add and check/update). */
export function healthzCheck(target: string, probeIds: readonly number[]): Record<string, unknown> {
  return {
    job: CHECK_JOB,
    target,
    frequency: FREQUENCY_MS,
    timeout: 10_000,
    enabled: true,
    probes: probeIds,
    labels: [{ name: 'app', value: 'catan' }],
    basicMetricsOnly: true,
    alertSensitivity: 'none',
    settings: { http: { method: 'GET', validStatusCodes: [200], failIfNotSSL: target.startsWith('https://'), noFollowRedirects: true } },
  };
}
