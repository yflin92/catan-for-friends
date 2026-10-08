import { describe, expect, it } from 'vitest';
import { DASHBOARD_UID, dashboard, dashboardQueries } from '../deploy/observability/dashboard.ts';
import { FOLDER_UID, RULE_GROUP, SECRET_LINE_REGEX, ruleGroup, type RuleContext } from '../deploy/observability/rules.ts';
import { CHECK_JOB, FREQUENCY_MS, healthzCheck, healthzUrl } from '../deploy/observability/synthetic-monitoring.ts';
import { parseWindows, toAnnotations, toTimeRanges } from '../deploy/observability/windows.ts';

const ctx: RuleContext = {
  cluster: 'prod',
  promUid: 'grafanacloud-prom',
  lokiUid: 'grafanacloud-logs',
  tempoUid: 'grafanacloud-traces',
  probeJob: CHECK_JOB,
  probeInstance: 'https://play.example.org/healthz',
};

type Rule = { uid: string; title: string; condition: string; data: { refId: string; datasourceUid: string; model: Record<string, unknown> }[]; labels: Record<string, string> };
const rules = () => ruleGroup(ctx)['rules'] as Rule[];

describe('game-night windows → Grafana time interval (X-alerts item 2)', () => {
  it('parses the configured windows and rejects malformed ones', () => {
    expect(parseWindows(undefined)).toEqual([]);
    expect(parseWindows('')).toEqual([]);
    expect(parseWindows('[{"start":"2026-10-09T18:00:00Z","end":"2026-10-09T23:00:00Z"}]')).toHaveLength(1);
    expect(() => parseWindows('{}')).toThrow();
    expect(() => parseWindows('[{"start":"2026-10-09T18:00:00Z"}]')).toThrow();
    expect(() => parseWindows('[{"start":"2026-10-09T18:00:00Z","end":"2026-10-09T17:00:00Z"}]')).toThrow();
  });

  it('turns a window into a UTC day entry, splitting at midnight and ending at 24:00', () => {
    const ranges = toTimeRanges(parseWindows('[{"start":"2026-10-10T20:00:00-02:00","end":"2026-10-11T04:30:00Z"}]'));
    expect(ranges).toEqual([
      { times: [{ start_time: '22:00', end_time: '24:00' }], days_of_month: ['10'], months: ['10'], years: ['2026'], location: 'UTC' },
      { times: [{ start_time: '00:00', end_time: '04:30' }], days_of_month: ['11'], months: ['10'], years: ['2026'], location: 'UTC' },
    ]);
  });

  it('gives one region annotation per window', () => {
    expect(toAnnotations(parseWindows('[{"start":"2026-10-09T18:00:00Z","end":"2026-10-09T23:00:00Z"}]'))).toEqual([
      { time: Date.parse('2026-10-09T18:00:00Z'), timeEnd: Date.parse('2026-10-09T23:00:00Z'), text: 'game night' },
    ]);
  });
});

describe('alert rules (X-alerts item 4)', () => {
  it('provisions A1–A3, the optional A4–A8 and the two NFR9 window rules in one group', () => {
    const group = ruleGroup(ctx);
    expect([group['title'], group['folderUid']]).toEqual([RULE_GROUP, FOLDER_UID]);
    expect(rules().map((r) => r.uid)).toEqual([
      'catan-a1-server-errors',
      'catan-a2-down',
      'catan-a3-lost-games',
      'catan-a4-job-stale',
      'catan-a5-latency',
      'catan-a6-series',
      'catan-a7-room-slots',
      'catan-a8-disk',
      'catan-nfr9-window',
      'catan-nfr9-active',
    ]);
    for (const uid of ['catan-a4-job-stale', 'catan-a5-latency', 'catan-a6-series', 'catan-a7-room-slots', 'catan-a8-disk']) {
      expect(rules().find((r) => r.uid === uid)!.title, uid).toContain('optional, from 5cf2796b');
    }
  });

  it('filters every data query on cluster + namespace, or on the probe job + instance', () => {
    for (const r of rules()) {
      for (const q of r.data.filter((d) => d.datasourceUid !== '__expr__')) {
        const expr = String(q.model['expr']);
        const scoped = expr.includes('cluster="prod",namespace="catan-server"') || expr.includes(`job="${CHECK_JOB}",instance="${ctx.probeInstance}"`);
        expect(scoped, `${r.uid}/${q.refId}: ${expr}`).toBe(true);
      }
    }
  });

  it('every condition references queries that exist', () => {
    for (const r of rules()) {
      const refs = new Set(r.data.map((d) => d.refId));
      expect(refs.has(r.condition)).toBe(true);
      for (const d of r.data.filter((x) => x.datasourceUid === '__expr__')) {
        const expression = String(d.model['expression']);
        for (const m of expression.matchAll(/\$(\w+)/g)) expect(refs.has(m[1]!), `${r.uid}: $${m[1]}`).toBe(true);
        if (d.model['type'] === 'reduce') expect(refs.has(expression)).toBe(true);
      }
    }
  });

  it('A1 covers internal_error rejections, catan.errors, non-drain 5xx, the secret-shape LogQL and the bundle mismatch', () => {
    const exprs = rules()[0]!.data.map((d) => String(d.model['expr'] ?? ''));
    const all = exprs.join('\n');
    for (const needle of ['catan_actions_rejected_total', 'reason_code="internal_error"', 'catan_errors_total', 'catan_http_responses_5xx_total', 'event="server.bundle_version_mismatch"', SECRET_LINE_REGEX]) {
      expect(all).toContain(needle);
    }
  });

  it('A3 and A4 do not depend on a counter increase alone (first event after a restart)', () => {
    const a3 = rules()[2]!.data.map((d) => String(d.model['expr'] ?? '')).join('\n');
    expect(a3).toContain('event="game.lost"');
    expect(a3).toContain('previous_shutdown="unclean"');
    const a4 = rules()[3]!.data.map((d) => String(d.model['expr'] ?? '')).join('\n');
    expect(a4).toContain('absent(catan_job_abandonment_last_success_seconds');
    expect(a4).toContain('catan_runtime_uptime_seconds');
  });

  it('only the scheduled NFR9 rule carries the game-night routing label', () => {
    expect(rules().filter((r) => r.labels['window'] === 'game-night').map((r) => r.uid)).toEqual(['catan-nfr9-window']);
  });
});

describe('alert rules on an empty stack (bug 30598267; Evolve 5cf2796b R1–R5)', () => {
  const inputs = (r: Rule) => r.data.filter((q) => q.datasourceUid !== '__expr__');
  const byUid = (uid: string) => rules().find((r) => r.uid === uid)!;

  /** Splits `expr` at top-level occurrences of ` + ` / ` * ` (outside parentheses and quotes). */
  function topLevel(expr: string): { operands: string[]; ops: string[] } {
    const operands: string[] = [];
    const ops: string[] = [];
    let depth = 0;
    let quote: string | null = null;
    let start = 0;
    for (let i = 0; i < expr.length; i++) {
      const c = expr[i]!;
      if (quote) {
        if (c === quote && expr[i - 1] !== '\\') quote = null;
      } else if (c === '"' || c === '`') quote = c;
      else if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (depth === 0 && (expr.startsWith(' + ', i) || expr.startsWith(' * ', i))) {
        operands.push(expr.slice(start, i));
        ops.push(expr[i + 1]!);
        start = i + 3;
        i += 2;
      }
    }
    operands.push(expr.slice(start));
    return { operands, ops };
  }
  const isTerm = (x: string) => /^\(sum\(.*\) or vector\(0\)\)$/s.test(x) && topLevel(x.slice(1, -1)).operands.length === 1;
  /** A no-data-safe expression: a term, or a parenthesised / + / * combination of no-data-safe expressions. */
  function safe(expr: string): boolean {
    const { operands, ops } = topLevel(expr);
    if (new Set(ops).size > 1) return false; // + and * never mix unparenthesised
    if (operands.length > 1) return operands.every(safe);
    if (isTerm(expr)) return true;
    return expr.startsWith('(') && expr.endsWith(')') && safe(expr.slice(1, -1));
  }

  it('every rule input is one query of `(sum(… bool …) or vector(0))` terms joined by + or *, never both unparenthesised', () => {
    for (const r of rules()) {
      for (const q of inputs(r)) expect(safe(String(q.model['expr'])), `${r.uid}/${q.refId}: ${String(q.model['expr'])}`).toBe(true);
      expect(inputs(r).length, r.uid).toBeLessThanOrEqual(4);
    }
  });

  it('every rule has noDataState OK and fires on `(…) > 0` over its inputs', () => {
    for (const r of rules() as (Rule & { noDataState: string })[]) {
      expect(r.noDataState, r.uid).toBe('OK');
      const fire = r.data.find((q) => q.refId === r.condition)!;
      expect(String(fire.model['expression'])).toMatch(/^\(.+\) > 0$/);
    }
  });

  /** Seed key meaning "the probe check is reporting": A2's absent_over_time term is then 0, otherwise 1. */
  const PROBES_REPORTING = 'probes reporting';

  /**
   * The rule as Grafana evaluates it once every input returns one sample: each term is 1 when a seeded key occurs in
   * its text, else its `or vector(0)` fallback (A2's absent_over_time term is 1 unless the probes are reporting);
   * + and * as in PromQL; then the `fire` math.
   */
  function evaluate(r: Rule, seeded: readonly string[]): number {
    const value = (expr: string): number => {
      const { operands, ops } = topLevel(expr);
      if (operands.length > 1) {
        let acc = value(operands[0]!);
        ops.forEach((op, i) => (acc = op === '+' ? acc + value(operands[i + 1]!) : acc * value(operands[i + 1]!)));
        return acc;
      }
      if (isTerm(expr) && expr.includes('absent_over_time(')) return seeded.includes(PROBES_REPORTING) ? 0 : 1;
      if (isTerm(expr)) return seeded.some((k) => expr.includes(k)) ? 1 : 0;
      return value(expr.slice(1, -1));
    };
    const vars = new Map(inputs(r).map((q) => [`${q.refId}N`, value(String(q.model['expr']))]));
    const fire = String(r.data.find((q) => q.refId === r.condition)!.model['expression']);
    return Number(new Function(`return ${fire.replace(/\$(\w+)/g, (_, n: string) => String(vars.get(n)))};`)());
  }

  it('on an empty stack every rule evaluates to 0, not no data, except A2, which fires because no probe reports', () => {
    for (const r of rules()) expect(evaluate(r, []), r.uid).toBe(r.uid === 'catan-a2-down' ? 1 : 0);
    for (const r of rules()) expect(evaluate(r, [PROBES_REPORTING]), r.uid).toBe(0);
  });

  it('A2 fires when the probe series disappears: an explicit absent_over_time term over 5 min, not noDataState', () => {
    const expr = String(inputs(byUid('catan-a2-down'))[0]!.model['expr']);
    expect(expr).toContain(`(sum(absent_over_time(probe_success{job="${CHECK_JOB}",instance="https://play.example.org/healthz"}[5m])) or vector(0))`);
  });

  it('probe selectors use only the SM check job and instance (SM series carry no cluster/namespace)', () => {
    for (const r of rules()) {
      for (const q of inputs(r)) {
        for (const [selector] of String(q.model['expr']).matchAll(/probe_success\{[^}]*\}/g)) {
          expect(selector, r.uid).toBe(`probe_success{job="${CHECK_JOB}",instance="https://play.example.org/healthz"}`);
        }
      }
    }
  });

  it.each([
    ['catan-a1-server-errors', ['reason_code="internal_error"']],
    ['catan-a1-server-errors', ['catan_errors_total']],
    ['catan-a1-server-errors', ['catan_http_responses_5xx_total']],
    ['catan-a1-server-errors', ['(roomCode|seatToken']],
    ['catan-a1-server-errors', ['server.bundle_version_mismatch']],
    ['catan-a2-down', [PROBES_REPORTING, '>= bool 3', '== bool 0']],
    ['catan-a2-down', []],
    ['catan-a3-lost-games', ['catan_games_lost_on_restart_total']],
    ['catan-a3-lost-games', ['event="game.lost"']],
    ['catan-a3-lost-games', ['shutdown="unclean"', 'state="active"']],
    ['catan-a3-lost-games', ['previous_shutdown="unclean"', 'state="active"']],
    ['catan-a4-job-stale', ['(time() - max(']],
    ['catan-a4-job-stale', ['absent(']],
    ['catan-a4-job-stale', ['result="error"']],
    ['catan-nfr9-window', ['>= bool 2']],
    ['catan-nfr9-active', ['>= bool 2', 'state="active"']],
    ['catan-a5-latency', ['< bool 0.95', '>= bool 50']],
    ['catan-a6-series', ['> bool 450']],
    ['catan-a7-room-slots', ['result="capacity_reached"']],
    ['catan-a7-room-slots', ['result="rate_limited"']],
    ['catan-a7-room-slots', ['result="rate_limited_auth"']],
    ['catan-a8-disk', ['< bool 2e9']],
    ['catan-a8-disk', ['absent(catan_disk_free_bytes', '> bool 300']],
  ] as const)('%s fires on %j alone, every other term empty', (uid, seeded) => {
    expect(evaluate(byUid(uid), seeded)).toBeGreaterThan(0);
  });

  it.each([
    ['catan-a2-down', [PROBES_REPORTING]],
    ['catan-a2-down', [PROBES_REPORTING, '>= bool 3']],
    ['catan-a3-lost-games', ['shutdown="unclean"']],
    ['catan-a3-lost-games', ['previous_shutdown="unclean"']],
    ['catan-nfr9-active', ['>= bool 2']],
    // A5: slow but quiet (under 50 commands), or busy but fast.
    ['catan-a5-latency', ['< bool 0.95']],
    ['catan-a5-latency', ['>= bool 50']],
    // A8 (Evolve): no disk reading but the server has been up under 5 min, or up 5 min with a reading present.
    ['catan-a8-disk', ['absent(catan_disk_free_bytes']],
    ['catan-a8-disk', ['> bool 300']],
  ] as const)('%s does not fire on %j (an AND partner missing, or healthy probes)', (uid, seeded) => {
    expect(evaluate(byUid(uid), seeded)).toBe(0);
  });

  it('A5–A8 carry a runbook line; A7 names each refused result in its summary', () => {
    const optional = (ruleGroup(ctx)['rules'] as (Rule & { annotations: Record<string, string> })[]).filter((r) => /^catan-a[5-8]-/.test(r.uid));
    expect(optional).toHaveLength(4);
    for (const r of optional) expect(r.annotations['runbook'], r.uid).toMatch(/\w/);
    const a7 = optional.find((r) => r.uid === 'catan-a7-room-slots')!;
    for (const result of ['capacity_reached', 'rate_limited', 'rate_limited_auth']) expect(a7.annotations['summary']).toContain(`$values.${result}N.Value`);
  });

  it('A8 watches the disk gauge itself: absent(disk_free) AND uptime > 300 s, each a summed term', () => {
    expect(String(inputs(byUid('catan-a8-disk'))[0]!.model['expr'])).toContain(
      '((sum(absent(catan_disk_free_bytes{cluster="prod",namespace="catan-server"}) == bool 1) or vector(0)) * (sum(max(catan_runtime_uptime_seconds{cluster="prod",namespace="catan-server"}) > bool 300) or vector(0)))',
    );
  });

  it('A1 (D31): a telemetry-component error alone does not fire it; an internal_error outcome does', () => {
    const a1 = byUid('catan-a1-server-errors');
    const metrics = String(inputs(a1).find((q) => q.refId === 'metrics')!.model['expr']);
    const errorTerms = topLevel(metrics).operands.filter((t) => t.includes('catan_errors_total'));
    expect(errorTerms).toEqual([
      '(sum(sum(increase(catan_errors_total{cluster="prod",namespace="catan-server",component!="telemetry"}[15m])) > bool 0) or vector(0))',
    ]);
    // No A1 term sees catan.errors{component="telemetry"}, so seeding only that leaves every term at its fallback.
    expect(evaluate(a1, [])).toBe(0);
    expect(evaluate(a1, ['reason_code="internal_error"'])).toBe(1);
  });

  it('A4 never-path: absent() is matched to the uptime gate with on() and summed, so it is one label-less sample', () => {
    expect(String(inputs(byUid('catan-a4-job-stale'))[0]!.model['expr'])).toContain(
      '(sum(absent(catan_job_abandonment_last_success_seconds{cluster="prod",namespace="catan-server"}) * on() (max(catan_runtime_uptime_seconds{cluster="prod",namespace="catan-server"}) > bool 900)) or vector(0))',
    );
  });
});

describe('production secret LogQL (G4)', () => {
  const re = new RegExp(SECRET_LINE_REGEX);
  const token = 'Ab3_' + 'x'.repeat(35) + '-9Zq';

  it.each([
    ['a seat-token-shaped value', `{"event":"x","value":"${token}"}`],
    ['an unredacted forbidden key', '{"roomCode":"ABCDEF"}'],
    ['an unredacted token key', '{"seatToken":"abc"}'],
    ['a passphrase key', '{"passphrase":"open sesame"}'],
    ['a rejoin link fragment', 'link https://play.example.org/#seat=ABCDEF.xyz'],
    ['a join link fragment', 'https://play.example.org/#join=ABCDEF'],
  ])('matches %s', (_name, line) => {
    expect(token).toHaveLength(43);
    expect(re.test(line)).toBe(true);
  });

  it.each([
    ['a redacted key', '{"roomCode":"[Redacted]","seatToken":"[Redacted]"}'],
    ['a 64-hex state hash', `{"state_hash":"${'a1'.repeat(32)}"}`],
    ['a UUID game id', '{"game_id":"3b241101-e2bb-4255-8caf-4136c566a962"}'],
    ['trace and span ids', '{"trace_id":"4bf92f3577b34da6a3ce929d0e0e4736","span_id":"00f067aa0ba902b7"}'],
    ['a normal event', '{"timestamp":"2026-10-08T05:55:58.677Z","severity_text":"INFO","event":"server.started","games_restored":0}'],
  ])('does not match %s', (_name, line) => {
    expect(re.test(line)).toBe(false);
  });
});

describe('dashboard "Catan — game night" (X-alerts item 5)', () => {
  const d = dashboard(ctx);
  const titles = (d['panels'] as { title: string }[]).map((p) => p.title);

  it('has a panel for every NFR SLI and the extra panels', () => {
    expect(d['uid']).toBe(DASHBOARD_UID);
    for (const prefix of ['NFR1 ', 'NFR2 ', 'NFR3 ', 'NFR4 ', 'NFR5 ', 'NFR6 ', 'NFR9 ', 'NFR10 ', 'NFR12 ', 'NFR13 ']) {
      expect(titles.some((t) => t.startsWith(prefix)), prefix).toBe(true);
    }
    for (const t of ['Auth rejections (daily; not in NFR4)', 'Slots used (lobby + active, of 10)', 'Disk free', 'Rooms created, by result', 'Per-action-type p95 (TraceQL)', 'Lobbies never started', 'Resume gaps — server_restart (own panel)']) {
      expect(titles).toContain(t);
    }
    for (const row of ['Live', 'Connections', 'Lifecycle', 'Ops', 'Logs']) expect(titles).toContain(row);
  });

  it('filters every query on {cluster="$env", namespace="catan-server"} or the probe check', () => {
    for (const q of dashboardQueries(d)) {
      const scoped = q.includes('cluster="$env",namespace="catan-server"') || q.includes(`job="${CHECK_JOB}"`) || q.includes('resource.cluster = "$env"');
      expect(scoped, q).toBe(true);
    }
  });

  it('TraceQL action panels measure player-facing spans only (kind = server, D28(c)); system work has its own kind = internal panel', () => {
    const traceQueries = (d['panels'] as { title: string; targets?: { query?: string }[] }[]).flatMap((p) => (p.targets ?? []).map((t) => [p.title, t.query ?? ''] as const)).filter(([, q]) => q.startsWith('{'));
    const actions = traceQueries.filter(([, q]) => q.includes('name = "catan.action"'));
    expect(actions.map(([t]) => t)).toEqual(['Per-action-type p95 (TraceQL)', 'Slow actions (> 50 ms, TraceQL)']);
    for (const [, q] of actions) expect(q).toContain('kind = server');
    expect(traceQueries.find(([t]) => t === 'Slow actions (> 50 ms, TraceQL)')![1]).toContain('duration > 50ms');
    expect(traceQueries.find(([t]) => t.startsWith('System work by span'))![1]).toMatch(/kind = internal \} \| rate\(\) by \(name\)$/);
  });

  it('NFR6 gap verdict (D30) is within_target / reports for cause="network", gated on ≥ 100 reports; the histogram p95 is diagnostic', () => {
    const panels = d['panels'] as { title: string; type: string; targets?: { expr: string }[] }[];
    const F = 'cluster="$env",namespace="catan-server"';
    const reports = (cause: string) => `sum(increase(catan_ws_resume_gap_reports_total{${F},cause="${cause}"}[14d]))`;
    const share = (cause: string) => `sum(increase(catan_ws_resume_gap_within_target_total{${F},cause="${cause}"}[14d])) / ${reports(cause)}`;
    const verdict = panels.find((p) => p.title === 'NFR6 network resume gaps < 5 s (verdict, 14 d)')!;
    expect(verdict.targets![0]!.expr).toBe(`${share('network')} and on() (${reports('network')} >= 100)`);
    expect(panels.find((p) => p.title === 'Resume gaps — server_restart < 5 s (14 d)')!.targets![0]!.expr).toBe(share('server_restart'));
    expect(panels.find((p) => p.title === 'NFR6 network resume gap p95 (diagnostic)')!.type).toBe('timeseries');
    expect(titles).not.toContain('NFR6 network resume gap p95 (14 d)');
    const nfr3 = panels.find((p) => p.title.startsWith('NFR3 '))!;
    expect(nfr3.targets![0]!.expr).toContain('catan_errors_total{cluster="$env",namespace="catan-server",component!="telemetry"}');
  });

  it('NFR6 individual gaps are the client-measured network histogram; player.reconnected logs are labelled server-side', () => {
    const panels = d['panels'] as { title: string; type: string; targets?: { expr: string }[] }[];
    const dist = panels.find((p) => p.title.startsWith('Network resume gaps — 14 d distribution'))!;
    expect(dist.type).toBe('bargauge');
    expect(dist.targets![0]!.expr).toBe(
      'sum by (le) (increase(catan_ws_resume_gap_seconds_bucket{cluster="$env",namespace="catan-server",cause="network"}[14d]))',
    );
    expect(titles).toContain('Reconnect events (server-side gap; null = unknown)');
    expect(titles).not.toContain('Individual network resume gaps');
    for (const q of dashboardQueries(d)) if (q.includes('unwrap gap_s')) expect(q).toContain('| gap_s != ""');
  });

  it('marks deploys from server.started, server.draining and deploy.forced', () => {
    const deploys = (d['annotations'] as { list: { name: string; expr?: string }[] }).list.find((a) => a.name === 'Deploys')!;
    expect(deploys.expr).toContain('event=~"server.started|server.draining|deploy.forced"');
  });

  it('NFR6 shows no verdict while fewer than 100 attempts exist', () => {
    const nfr6 = (d['panels'] as { title: string; targets?: { expr: string }[] }[]).filter((p) => p.title.startsWith('NFR6 ') && p.title.includes('14 d)'));
    for (const p of nfr6.filter((x) => !x.title.includes('raw counts'))) expect(p.targets![0]!.expr).toContain('>= 100');
  });
});

describe('Synthetic Monitoring /healthz check (X-alerts item 3)', () => {
  it('probes the public /healthz every 120 s with the job A2 and NFR9 filter on', () => {
    expect(healthzUrl('play.example.org')).toBe('https://play.example.org/healthz');
    expect(healthzUrl('http://localhost/')).toBe('http://localhost/healthz');
    expect(healthzCheck('https://play.example.org/healthz', [1, 2])).toMatchObject({ job: CHECK_JOB, frequency: FREQUENCY_MS, probes: [1, 2], enabled: true });
    expect(FREQUENCY_MS).toBe(120_000);
  });
});
