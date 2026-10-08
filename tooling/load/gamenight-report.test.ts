// Post-game NFR report (task 7626d58c; Verify's query list R1–R10, G1–G6): query building against the dashboard
// (G1, G6), verdicts on seeded data including boundaries and NO_DATA (G3), exit codes (G4), no ids (G5), and
// credentials never reaching an output.
import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { dashboard } from '../../deploy/observability/dashboard';
import { CHECK_JOB } from '../../deploy/observability/synthetic-monitoring';
import { buildQueries, exitCode, renderTable, runReport, type Backend, type ReportInput } from './gamenight-report';
import { lokiInstantQuery, lokiQueryRange, promRangeQuery, promSamplesQuery, type LokiStream, type RangeRow, type Row } from './prom-client';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const FROM = Date.parse('2026-10-10T18:00:00Z') / 1000;
const TO = FROM + 3600;
const INPUT: ReportInput = { cluster: 'prod', probeJob: CHECK_JOB, probeInstance: 'https://play.example.org/healthz', from: FROM, to: TO };
const WITH_RESUME: ReportInput = { ...INPUT, resumeAt: FROM + 1800 };

// ── G1 / G6: the queries ─────────────────────────────────────────────────────

describe('queries (G1 single source, G6 no bare unions)', () => {
  const dash = dashboard({ ...INPUT, promUid: 'p', lokiUid: 'l', tempoUid: 't' }) as { panels: { title: string; targets?: { expr?: string }[] }[] };
  const panelExprs = (title: string): string[] => (dash.panels.find((p) => p.title === title)?.targets ?? []).map((t) => String(t.expr));
  /** The CLI's expression in the dashboard's form: the window range back to `range`, the cluster back to $env. */
  const asDashboard = (expr: string, range: string) => expr.replaceAll('[3600s]', `[${range}]`).replaceAll('cluster="prod"', 'cluster="$env"');

  it.each([
    ['R1', 'share', 'NFR1 actions ≤ 50 ms (share)', '$__range'],
    ['R1', 'p95', 'NFR1 p95 (all / ok)', '$__range'],
    ['R1', 'p95Ok', 'NFR1 p95 (all / ok)', '$__range'],
    ['R2', 'p95', 'NFR2 client action RTT p95 (verdict)', '$__range'],
    ['R3', 'errors', 'NFR3 server errors (A1 metric part, 15 min)', '15m'],
    ['R4', 'share', 'NFR4 rule/turn rejections (excl. auth)', '$__range'],
    ['R5', 'rate', 'NFR5 unplanned disconnects per player-hour', '$__range'],
    ['R6', 'success14d', 'NFR6 reconnect success (14 d)', '14d'],
    ['R6', 'gapShare14d', 'NFR6 network resume gaps < 5 s (verdict, 14 d)', '14d'],
    ['R8', 'failedProbes5mAtTo', 'NFR9 failed probes in 5 min', '5m'],
    ['R9', 'lost', 'NFR10 games lost on restart', '$__range'],
  ] as const)('%s.%s is the dashboard panel "%s" with the window filled in', (id, key, title, range) => {
    const spec = buildQueries(INPUT)[id]!.find((s) => s.key === key)!;
    expect(panelExprs(title)).toContain(asDashboard(spec.expr, range));
    expect(spec.source).toMatch(/^(sli|rules)\./);
  });

  it('the auth rejection queries are the dashboard auth panel\'s with the window instead of 1d', () => {
    const r4 = buildQueries(INPUT)['R4']!;
    for (const key of ['auth', 'authByReason']) {
      expect(panelExprs('Auth rejections (daily; not in NFR4)')).toContain(r4.find((s) => s.key === key)!.expr.replaceAll('[3600s]', '[1d]').replaceAll('cluster="prod"', 'cluster="$env"'));
    }
  });

  it('every query has the window filled in, no dashboard variable, and the cluster + namespace or the probe selector', () => {
    for (const specs of Object.values(buildQueries(WITH_RESUME))) {
      for (const s of specs) {
        expect(s.expr, s.key).not.toMatch(/\$__range|\$env|\$__rate_interval/);
        expect(s.expr.includes('cluster="prod",namespace="catan-server"') || s.expr.includes(`job="${CHECK_JOB}",instance="https://play.example.org/healthz"`), s.expr).toBe(true);
        if (s.kind === 'instant') expect(s.at, s.key).toBeDefined();
      }
    }
    expect(buildQueries(INPUT)['R1']!.find((s) => s.key === 'share')!.expr).toContain('[3600s]');
  });

  it('G6: every `or` in every expression (PromQL and LogQL) is ` or vector(0)`', () => {
    for (const specs of Object.values(buildQueries(WITH_RESUME))) {
      for (const s of specs) expect(s.expr.match(/\bor\b/g)?.length ?? 0, s.expr).toBe(s.expr.split(' or vector(0)').length - 1);
    }
  });

  it('R8 (a): the probe results are raw samples, an instant query of `probe_success{…}[R s]` at the window end', () => {
    expect(buildQueries(INPUT)['R8']!.find((s) => s.key === 'probes')).toMatchObject({
      kind: 'samples',
      at: TO,
      expr: `probe_success{job="${CHECK_JOB}",instance="https://play.example.org/healthz"}[3600s]`,
    });
  });

  it('Loki counts are instant `count_over_time` / `sum_over_time` queries over [R s] at the window end', () => {
    const q = buildQueries(INPUT);
    const loki = [...q['R8']!, ...q['R9']!].filter((s) => s.kind === 'loki');
    expect(loki.map((s) => s.key).sort()).toEqual(['anyLogLines', 'anyLogLines', 'deployForced', 'logged', 'restartsWithGames', 'serverStarts']);
    for (const s of loki) {
      expect(s.at, s.key).toBe(TO);
      expect(s.expr, s.key).toMatch(/^sum\((count|sum)_over_time\(.* \[3600s\]\)\)$/);
    }
    expect(loki.find((s) => s.key === 'logged')!.expr).toContain('| unwrap lost_on_restart [3600s]');
  });

  it('AC35 sub-window: instant queries at resume-at + 120 s over 150 s; without --resume-at there are none', () => {
    const r7 = buildQueries(WITH_RESUME)['R7']!;
    expect(r7.filter((s) => s.kind === 'instant').every((s) => s.at === FROM + 1800 + 120 && s.expr.includes('[150s]'))).toBe(true);
    expect(r7.find((s) => s.kind === 'lines')).toMatchObject({ start: FROM + 1800 - 30, end: FROM + 1800 + 120 });
    expect(buildQueries(INPUT)['R7']).toEqual([]);
  });
});

// ── seeded evaluation ───────────────────────────────────────────────────────

const v = (value: number, metric: Record<string, string> = {}): Row => ({ metric, value: [TO, String(value)] });
const line = (sec: number, body: Record<string, unknown>): LokiStream => ({ stream: {}, values: [[String(BigInt(sec) * 1_000_000_000n), JSON.stringify(body)]] });
const probeSeries = (values: (number | null)[]): RangeRow => ({
  metric: { job: CHECK_JOB },
  values: values.flatMap((x, k) => (x === null ? [] : [[FROM + k * 120, String(x)] as [number, string]])),
});
const PROBE_POINTS = 31; // FROM … TO at 120 s

type Seed = Record<string, Row[] | RangeRow[] | LokiStream[] | Error>;
/** A clean night: every required item has data and passes. Keys are `<item>.<query key>`. */
function cleanSeed(): Seed {
  return {
    'R1.share': [v(0.99)],
    'R1.n': [v(1000)],
    'R1.p95': [v(0.012)],
    'R1.p95Ok': [v(0.011)],
    'R2.share': [v(0.98)],
    'R2.n': [v(400)],
    'R2.p95': [v(0.12)],
    'R2.telemetryDropped': [v(0)],
    'R3.errors': [v(0)],
    'R3.uncleanStarts': [v(0)],
    'R3.errorsByComponent': [v(3, { component: 'telemetry' }), v(0, { component: 'ws' })],
    'R3.errorsPresent': [v(6)],
    'R3.startsPresent': [v(2)],
    'R4.rejected': [v(10)],
    'R4.n': [v(1000)],
    'R4.auth': [v(4)],
    'R5.unplanned': [v(2)],
    'R5.playerHours': [v(4)],
    'R5.byReason': [v(2, { reason: 'unplanned' }), v(9, { reason: 'client_backgrounded' })],
    'R6.byOutcome': [v(12, { outcome: 'resumed' })],
    'R6.attempts14d': [v(20)],
    'R7.resumed': [v(1)],
    'R7.withinTarget': [v(1)],
    'R7.reports': [v(1)],
    'R7.reconnectEvents': [line(FROM + 1805, { event: 'player.reconnected', game_id: 'g-SECRETGAME', seat: 2, outcome: 'resumed', gap_s: 2, seq_behind: 0, roomCode: 'QWERTY' })],
    'R8.probes': [probeSeries(Array(PROBE_POINTS).fill(1))],
    'R8.failedProbes5mAtTo': [v(0)],
    'R8.anyLogLines': [v(500)],
    'R8.deployForced': [],
    'R8.restartsWithGames': [],
    'R8.activeGames': [{ metric: {}, values: [[FROM + 60, '2'], [TO - 60, '1']] }],
    'R9.lost': [v(0)],
    'R9.lostPresent': [v(1)],
    'R9.anyLogLines': [v(500)],
    'R9.logged': [v(0)],
    'R9.serverStarts': [v(1)],
    'R10.gamesFinished': [v(2)],
  };
}

/** A Backend answering from a seed keyed by `<item>.<key>`, resolved through the report's own query list. */
function seeded(input: ReportInput, seed: Seed, opts: { loki?: boolean } = {}): Backend {
  const loki = opts.loki !== false;
  const byExpr = new Map<string, Seed[string]>();
  for (const [id, specs] of Object.entries(buildQueries(input))) for (const s of specs) if (`${id}.${s.key}` in seed) byExpr.set(`${s.kind}:${s.expr}`, seed[`${id}.${s.key}`]!);
  const answer = <T>(key: string): Promise<T> => {
    const r = byExpr.get(key);
    return r instanceof Error ? Promise.reject(r) : Promise.resolve((r ?? []) as T);
  };
  return {
    instant: (expr) => answer<Row[]>(`instant:${expr}`),
    samples: (expr) => answer<RangeRow[]>(`samples:${expr}`),
    range: (expr) => answer<RangeRow[]>(`range:${expr}`),
    lokiInstant: loki ? (expr) => answer<Row[]>(`loki:${expr}`) : null,
    lokiLines: loki ? (expr) => answer<LokiStream[]>(`lines:${expr}`) : null,
    seriesCount: null,
  };
}
const verdicts = async (input: ReportInput, seed: Seed, opts?: { loki?: boolean }) => {
  const { items } = await runReport(input, seeded(input, seed, opts));
  return { items, by: Object.fromEntries(items.map((i) => [i.id, i.verdict])), code: exitCode(items) };
};

describe('verdicts on seeded data (G3, G4)', () => {
  it('a clean night: every required item PASSes, NFR6 and context are NO_VERDICT, exit 0', async () => {
    const { by, code, items } = await verdicts(WITH_RESUME, cleanSeed());
    expect(by).toEqual({ R1: 'PASS', R2: 'PASS', R3: 'PASS', R4: 'PASS', R5: 'PASS', R6: 'NO_VERDICT', R7: 'PASS', R8: 'PASS', R9: 'PASS', R10: 'NO_VERDICT' });
    expect(code).toBe(0);
    expect(items.find((i) => i.id === 'R6')!.numbers['context14d']).toMatchObject({ reconnectSuccess: 'no verdict, n=20' });
  });

  it.each([
    ['R1', { 'R1.share': [v(0.9)] }],
    ['R2', { 'R2.share': [v(0.9)] }],
    ['R3', { 'R3.errors': [v(1)] }],
    ['R3', { 'R3.uncleanStarts': [v(1)] }],
    ['R4', { 'R4.rejected': [v(25)] }],
    ['R5', { 'R5.unplanned': [v(5)] }],
    ['R7', { 'R7.withinTarget': [v(0)] }],
    ['R7', { 'R7.resumed': [v(0)] }],
    ['R8', { 'R8.deployForced': [v(1)] }],
    ['R8', { 'R8.restartsWithGames': [v(1)] }],
    ['R9', { 'R9.lost': [v(1)], 'R9.logged': [v(1)] }],
  ] as const)('a breach of %s FAILs that item only (exit 1)', async (id, breach) => {
    const { by, code } = await verdicts(WITH_RESUME, { ...cleanSeed(), ...(breach as unknown as Seed) });
    expect(by[id]).toBe('FAIL');
    expect(Object.entries(by).filter(([, x]) => x === 'FAIL').map(([k]) => k)).toEqual([id]);
    expect(code).toBe(1);
  });

  it('boundaries: share exactly 0.95 passes; NFR4 exactly 2.0% and NFR5 exactly 1.0/h fail', async () => {
    expect((await verdicts(INPUT, { ...cleanSeed(), 'R1.share': [v(0.95)] })).by['R1']).toBe('PASS');
    expect((await verdicts(INPUT, { ...cleanSeed(), 'R4.rejected': [v(20)], 'R4.n': [v(1000)] })).by['R4']).toBe('FAIL');
    expect((await verdicts(INPUT, { ...cleanSeed(), 'R4.rejected': [v(19)], 'R4.n': [v(1000)] })).by['R4']).toBe('PASS');
    expect((await verdicts(INPUT, { ...cleanSeed(), 'R5.unplanned': [v(4)], 'R5.playerHours': [v(4)] })).by['R5']).toBe('FAIL');
  });

  it('NFR9 probes: alternating failures pass; two adjacent failures fail; a missing sample next to a failure fails with a WARN', async () => {
    const alternating = Array.from({ length: PROBE_POINTS }, (_, k) => (k % 2 === 0 ? 1 : 0));
    expect((await verdicts(INPUT, { ...cleanSeed(), 'R8.probes': [probeSeries(alternating)] })).by['R8']).toBe('PASS');
    const adjacent = Array(PROBE_POINTS).fill(1);
    adjacent[10] = 0;
    adjacent[11] = 0;
    expect((await verdicts(INPUT, { ...cleanSeed(), 'R8.probes': [probeSeries(adjacent)] })).by['R8']).toBe('FAIL');
    const gap = Array<number | null>(PROBE_POINTS).fill(1);
    gap[10] = 0;
    gap[11] = null;
    const r = await verdicts(INPUT, { ...cleanSeed(), 'R8.probes': [probeSeries(gap)] });
    expect(r.by['R8']).toBe('FAIL');
    expect(r.items.find((i) => i.id === 'R8')!.warnings.join()).toContain('1 probe(s) missing');
  });

  it('NFR9 probe gaps: ≤ 180 s is no gap; 240 s is one missed probe (PASS, WARN); 360 s is two (FAIL); edges count', async () => {
    const at = (offsets: number[]): RangeRow => ({ metric: {}, values: offsets.map((o) => [FROM + o, '1'] as [number, string]) });
    const every = (step: number, skip: (o: number) => boolean = () => false) =>
      Array.from({ length: Math.floor(3600 / step) + 1 }, (_, k) => k * step).filter((o) => !skip(o));
    const run = async (series: RangeRow) => {
      const r = await verdicts(INPUT, { ...cleanSeed(), 'R8.probes': [series] });
      const r8 = r.items.find((i) => i.id === 'R8')!;
      return { verdict: r8.verdict, missed: (r8.numbers['probes'] as { missed: number }).missed };
    };
    // 180 s apart: within the gap tolerance.
    expect(await run(at(every(180)))).toEqual({ verdict: 'PASS', missed: 0 });
    // One sample dropped: 240 s between neighbours.
    expect(await run(at(every(120, (o) => o === 1200)))).toEqual({ verdict: 'PASS', missed: 1 });
    // Two in a row dropped: 360 s.
    expect(await run(at(every(120, (o) => o === 1200 || o === 1320)))).toEqual({ verdict: 'FAIL', missed: 2 });
    // Nothing for the last 360 s of the window.
    expect(await run(at(every(120, (o) => o > 3240)))).toEqual({ verdict: 'FAIL', missed: 2 });
  });

  it('active games outside the declared window are WARNed', async () => {
    const { items } = await verdicts(INPUT, { ...cleanSeed(), 'R8.activeGames': [{ metric: {}, values: [[FROM - 600, '1'], [TO + 60, '1']] }] });
    expect(items.find((i) => i.id === 'R8')!.warnings.join()).toContain('active outside the declared window');
  });

  it('NFR10: metric and logs disagreeing is a FAIL with both values', async () => {
    const { items } = await verdicts(INPUT, { ...cleanSeed(), 'R9.logged': [v(1)] });
    const r9 = items.find((i) => i.id === 'R9')!;
    expect(r9.verdict).toBe('FAIL');
    expect(r9.numbers).toMatchObject({ metric: 0, logged: 1 });
  });

  it('NO_DATA is never PASS: an empty stack, or a zero denominator, gives NO_DATA and exit 2', async () => {
    const empty = await verdicts(INPUT, {});
    for (const id of ['R1', 'R2', 'R3', 'R4', 'R5', 'R8', 'R9']) expect(empty.by[id], id).toBe('NO_DATA');
    expect(empty.code).toBe(2);
    for (const zero of [{ 'R1.n': [v(0)] }, { 'R4.n': [v(0)] }, { 'R5.playerHours': [v(0)] }, { 'R2.n': [] }]) {
      const r = await verdicts(INPUT, { ...cleanSeed(), ...zero });
      expect(Object.values(r.by)).toContain('NO_DATA');
      expect(r.code).toBe(2);
    }
  });

  it('a zero-initialised counter at 0 is a real 0 (R3 present, no increase sample → PASS)', async () => {
    const seed = cleanSeed();
    delete seed['R3.errors'];
    delete seed['R3.uncleanStarts'];
    expect((await verdicts(INPUT, seed)).by['R3']).toBe('PASS');
  });

  it('without Loki, the log-backed items are NO_DATA (exit 2)', async () => {
    const r = await verdicts(INPUT, cleanSeed(), { loki: false });
    expect([r.by['R8'], r.by['R9']]).toEqual(['NO_DATA', 'NO_DATA']);
    expect(r.code).toBe(2);
  });

  it('Loki G3: no log line for the environment in the window makes every Loki item NO_DATA; with lines, an empty filter is a real 0', async () => {
    for (const none of [[], [v(0)]]) {
      const r = await verdicts(INPUT, { ...cleanSeed(), 'R8.anyLogLines': none, 'R9.anyLogLines': none });
      expect([r.by['R8'], r.by['R9']]).toEqual(['NO_DATA', 'NO_DATA']);
      expect(r.code).toBe(2);
    }
    const r = await verdicts(INPUT, { ...cleanSeed(), 'R9.logged': [] });
    expect(r.by['R9']).toBe('PASS');
    expect(r.items.find((i) => i.id === 'R8')!.numbers).toMatchObject({ deployForced: 0, restartsWithGamesActive: 0 });
  });

  it('G4: a FAIL exits 1 even with incomplete evidence, which the table prints at the top', async () => {
    const r = await verdicts(INPUT, { ...cleanSeed(), 'R1.share': [v(0.5)], 'R5.playerHours': new Error('Prometheus query to http://h/?… → HTTP 503') });
    expect(r.by['R1']).toBe('FAIL');
    expect(r.items.find((i) => i.id === 'R5')!.warnings.join()).toContain('query playerHours failed');
    expect(r.code).toBe(1);
    expect(renderTable(INPUT, r.items).split('\n')[2]).toBe('!! INCOMPLETE EVIDENCE: R5 (no data or a failed query; see below)');
  });

  it('G4: without a FAIL, a failed query or a required NO_DATA exits 2', async () => {
    expect((await verdicts(INPUT, { ...cleanSeed(), 'R5.playerHours': new Error('HTTP 503') })).code).toBe(2);
    expect((await verdicts(INPUT, { ...cleanSeed(), 'R1.n': [v(0)] })).code).toBe(2);
    const clean = await runReport(INPUT, seeded(INPUT, cleanSeed()));
    expect(renderTable(INPUT, clean.items)).not.toContain('INCOMPLETE EVIDENCE');
  });

  it('NFR2 WARNs when client telemetry was dropped', async () => {
    const { items } = await verdicts(INPUT, { ...cleanSeed(), 'R2.telemetryDropped': [v(3)] });
    expect(items.find((i) => i.id === 'R2')!.warnings.join()).toContain('client metrics are incomplete');
  });

  it('G5: no game id, room code or seat from the logs reaches the output', async () => {
    const { items } = await runReport(WITH_RESUME, seeded(WITH_RESUME, cleanSeed()));
    const out = JSON.stringify(items) + renderTable(WITH_RESUME, items);
    expect(out).not.toMatch(/SECRETGAME|QWERTY|"seat"/);
    expect(items.find((i) => i.id === 'R7')!.numbers['reconnectEvents']).toEqual([{ at: new Date((FROM + 1805) * 1000).toISOString(), outcome: 'resumed', gap_s: 2, seq_behind: 0 }]);
  });

  it('the table shows each verdict, n and every query with its source', async () => {
    const { items } = await runReport(INPUT, seeded(INPUT, cleanSeed()));
    const table = renderTable(INPUT, items);
    expect(table).toMatch(/^R1 {3}PASS {7}n=1000/m);
    expect(table).toContain('(sli.nfr1ShareExpr (dashboard "NFR1 actions ≤ 50 ms (share)"))');
    expect(table).toContain('[3600s]');
  });
});

// ── credentials ──────────────────────────────────────────────────────────────

describe('credentials never reach an output', () => {
  const SENTINEL = `SENTINEL-${Math.random().toString(36).slice(2)}`;
  const withSecrets = (base: string) => base.replace('://', `://user:${SENTINEL}-pw@`) + `/api?token=${SENTINEL}-q`;

  async function fakeServer(status: number, seen: string[] = []): Promise<string> {
    const server: Server = createServer((req: IncomingMessage, res) => {
      seen.push(`${req.url ?? ''} ${req.headers.authorization ?? ''}`);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: status === 200 ? 'success' : 'error', data: { resultType: 'vector', result: [] } }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    cleanups.push(() => new Promise((r) => server.close(r)));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it.each([
    ['range query', (u: string) => promRangeQuery(u, 'up', 0, 60, 30)],
    ['samples query', (u: string) => promSamplesQuery(u, 'up[60s]', 60)],
    ['Loki query', (u: string) => lokiQueryRange(u, '{a="b"}', 0, 60)],
    ['Loki instant query', (u: string) => lokiInstantQuery(u, 'sum(count_over_time({a="b"} [60s]))', 60)],
  ] as const)('%s errors carry no credential (refused, HTTP 401)', async (_n, call) => {
    for (const base of ['http://127.0.0.1:1', await fakeServer(401)]) {
      const err = await call(withSecrets(base)).then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(err!.message).not.toContain(SENTINEL);
    }
  });

  it('the Loki client sends userinfo as basic auth and nanosecond bounds, never the credential in the URL', async () => {
    const seen: string[] = [];
    await lokiQueryRange(withSecrets(await fakeServer(200, seen)), '{a="b"}', 10, 70);
    expect(seen[0]).toContain('/loki/api/v1/query_range?');
    expect(seen[0]).toContain('start=10000000000');
    expect(seen[0]!.split(' ')[0]).not.toContain(`${SENTINEL}-pw`);
    await lokiInstantQuery(withSecrets(await fakeServer(200, seen)), 'sum(count_over_time({a="b"} [60s]))', 70);
    expect(seen[1]).toContain('/loki/api/v1/query?');
    expect(seen[1]).toContain('time=70000000000');
    expect(seen[1]!.split(' ')[0]).not.toContain(`${SENTINEL}-pw`);
    expect(Buffer.from(seen[1]!.split(' ').at(-1)!, 'base64').toString()).toBe(`user:${SENTINEL}-pw`);
  });

  it('CLI: no credential on stdout or stderr, from the URLs or the environment, on failure or on an empty stack', async () => {
    const run = (prom: string, loki: string, env: Record<string, string>) =>
      new Promise<{ status: number | null; out: string }>((resolve) => {
        const child = execFile(
          process.execPath,
          [
            '--experimental-strip-types',
            '--no-warnings',
            '--import',
            path.join(root, 'tooling/ts-resolve-hook.mjs'),
            path.join(here, 'gamenight-report.ts'),
            ...['--prom-url', prom, '--loki-url', loki, '--cluster', 'prod', '--probe-instance', 'https://play.example.org/healthz'],
            ...['--from', '2026-10-10T18:00:00Z', '--to', '2026-10-10T19:00:00Z', '--json'],
          ],
          { encoding: 'utf8', cwd: root, env: { ...process.env, GRAFANA_SA_TOKEN: '', GRAFANA_BASIC_AUTH: '', ...env } },
          (_e, stdout, stderr) => resolve({ status: child.exitCode, out: stdout + stderr }),
        );
      });
    const empty = await fakeServer(200);
    for (const [prom, loki, env] of [
      [withSecrets('http://127.0.0.1:1'), withSecrets('http://127.0.0.1:1'), {}],
      [withSecrets(await fakeServer(401)), withSecrets(await fakeServer(401)), {}],
      [withSecrets(empty), withSecrets(empty), {}],
      [empty, empty, { GRAFANA_SA_TOKEN: `${SENTINEL}-token` }],
      [empty, empty, { GRAFANA_BASIC_AUTH: `user:${SENTINEL}-basic` }],
    ] as const) {
      const r = await run(prom, loki, env);
      expect(r.status, r.out.slice(0, 400)).toBe(2);
      expect(r.out).not.toContain(SENTINEL);
    }
  }, 120_000);
});
