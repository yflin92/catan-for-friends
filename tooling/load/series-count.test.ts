import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { promQuery, redactUrl } from './prom-client';
import { ALLOY_SELF, ALLOY_SELF_PREFIXES, countSeries } from './series-count';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** A Prometheus query API stand-in: `answer` maps the PromQL text to a result vector. */
async function fakeProm(answer: (query: string, req: IncomingMessage) => { status?: number; rows?: unknown[] }): Promise<string> {
  const server: Server = createServer((req, res) => {
    const query = new URL(req.url ?? '/', 'http://x').searchParams.get('query') ?? '';
    const { status = 200, rows = [] } = answer(query, req);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: status === 200 ? 'success' : 'error', data: { resultType: 'vector', result: rows } }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise((r) => server.close(r)));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const v = (n: number, metric: Record<string, string> = {}) => ({ metric, value: [0, String(n)] });

interface Env {
  app: number;
  targetInfo: Record<string, string> | null;
}

/** Answers series-count's queries for one environment named "loadtest". */
function envAnswers(env: Env) {
  return (q: string) => {
    if (q.startsWith('count by (__name__)')) return { rows: env.app > 0 ? [v(env.app, { __name__: 'catan_actions_total' })] : [] };
    if (q.startsWith('count({cluster="loadtest"} or')) return { rows: [v(env.app + (env.targetInfo ? 1 : 0))] };
    if (q.includes('__name__=~"catan_.*"}')) return { rows: env.app > 0 ? [v(env.app)] : [] };
    if (q.startsWith('target_info')) return { rows: env.targetInfo ? [v(1, { __name__: 'target_info', ...env.targetInfo })] : [] };
    return { rows: [] };
  };
}

const fullTargetInfo = {
  job: 'catan-server',
  instance: 'catan-1',
  service_version: 'abc1234',
  deployment_environment: 'loadtest',
  cluster: 'loadtest',
  namespace: 'catan-server',
};

describe('series-count checks (bug 12281256)', () => {
  it('passes an environment with app series and a fully labelled target_info', async () => {
    const r = await countSeries(await fakeProm(envAnswers({ app: 216, targetInfo: fullTargetInfo })), 'loadtest');
    expect(r).toMatchObject({ ok: true, environmentSeries: 217, appSeries: 216, missingResourceLabels: [] });
  });

  it('fails when target_info lacks cluster and namespace (Alloy setting them on datapoints only)', async () => {
    const withoutClusterLabels = Object.fromEntries(Object.entries(fullTargetInfo).filter(([k]) => k !== 'cluster' && k !== 'namespace'));
    const r = await countSeries(await fakeProm(envAnswers({ app: 216, targetInfo: withoutClusterLabels })), 'loadtest');
    expect(r).toMatchObject({ ok: false, missingResourceLabels: ['cluster', 'namespace'] });
  });

  it('fails an environment with target_info but no app series', async () => {
    const r = await countSeries(await fakeProm(envAnswers({ app: 0, targetInfo: fullTargetInfo })), 'loadtest');
    expect(r).toMatchObject({ ok: false, appSeries: 0 });
  });

  it('fails at 500 environment series or more', async () => {
    const r = await countSeries(await fakeProm(envAnswers({ app: 499, targetInfo: fullTargetInfo })), 'loadtest');
    expect(r).toMatchObject({ ok: false, environmentSeries: 500 });
  });
});

describe('Alloy self-metrics (bug 12281256)', () => {
  const names = readFileSync(path.join(here, '__fixtures__/alloy-v1.11.3-self-metrics.txt'), 'utf8').split('\n').filter((l) => l !== '');
  const re = new RegExp(`^(${ALLOY_SELF_PREFIXES.join('|')})`);

  it('ALLOY_SELF matches every self-metric name of a live Alloy v1.11.3 scrape, idle and under load', () => {
    expect(names.length).toBeGreaterThan(100);
    expect(names.filter((n) => !re.test(n))).toEqual([]);
    expect(ALLOY_SELF).toBe(`__name__=~"(${ALLOY_SELF_PREFIXES.join('|')}).*"`);
  });

  it('matches no app series name', () => {
    for (const n of ['catan_actions_total', 'catan_runtime_uptime_seconds', 'target_info']) expect(re.test(n), n).toBe(false);
  });
});

describe('credentials never reach an output (bug 12281256)', () => {
  const SENTINEL = `SENTINEL-${Math.random().toString(36).slice(2)}`;
  const withSecrets = (base: string) => base.replace('://', `://user:${SENTINEL}-pw@`) + `/api/prom?token=${SENTINEL}-q`;

  it('redactUrl drops userinfo and query', () => {
    expect(redactUrl(`https://u:${SENTINEL}@h.example/p?token=${SENTINEL}`)).toBe('https://h.example/p?…');
  });

  it.each([
    ['connection refused', () => Promise.resolve('http://127.0.0.1:1')],
    ['DNS failure', () => Promise.resolve('http://does-not-exist.invalid')],
    ['HTTP 401', () => fakeProm(() => ({ status: 401 }))],
  ] as const)('%s: the thrown message carries no credential', async (_name, base) => {
    const url = withSecrets(await base());
    const err = await promQuery(url, 'up').then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).not.toContain(SENTINEL);
  });

  it('userinfo is sent as basic auth, not in the URL', async () => {
    let auth = '';
    let requested = '';
    const base = await fakeProm((_q, req) => {
      auth = req.headers.authorization ?? '';
      requested = req.url ?? '';
      return { rows: [] };
    });
    await promQuery(withSecrets(base), 'up');
    expect(Buffer.from(auth.replace('Basic ', ''), 'base64').toString()).toBe(`user:${SENTINEL}-pw`);
    expect(requested).not.toContain(`${SENTINEL}-pw`);
  });

  it.each(['series-count.ts', 'server-report.ts'])('%s CLI: no credential on stdout or stderr when the query fails', async (script) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hexlands-sentinel-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const report = path.join(dir, 'load-report.json');
    writeFileSync(report, JSON.stringify({ startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:01:00Z' }));
    for (const base of ['http://127.0.0.1:1', await fakeProm(() => ({ status: 401 }))]) {
      const r = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
        const child = execFile(
        process.execPath,
        [
          '--experimental-strip-types',
          '--no-warnings',
          '--import',
          path.join(root, 'tooling/ts-resolve-hook.mjs'),
          path.join(here, script),
          '--prom-url',
          withSecrets(base),
          '--cluster',
          'loadtest',
          ...(script === 'server-report.ts' ? ['--report', report, '--settle-sec', '0'] : []),
        ],
        { encoding: 'utf8', cwd: root, env: { ...process.env, GRAFANA_SA_TOKEN: '', GRAFANA_BASIC_AUTH: '' } },
        (_error, stdout, stderr) => resolve({ status: child.exitCode, stdout, stderr }),
        );
      });
      expect(r.status, `${script} ${r.stderr}`).toBe(1);
      expect(r.stdout + r.stderr).not.toContain(SENTINEL);
      expect(r.stderr).toMatch(/Prometheus query to http:\/\/127\.0\.0\.1:\d+\/api\/prom\?… (failed|→ HTTP 401)/);
    }
  }, 60_000);
});
