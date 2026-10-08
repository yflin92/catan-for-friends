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
  it('provisions A1–A3, the optional A4 and the two NFR9 window rules in one group', () => {
    const group = ruleGroup(ctx);
    expect([group['title'], group['folderUid']]).toEqual([RULE_GROUP, FOLDER_UID]);
    expect(rules().map((r) => r.uid)).toEqual([
      'catan-a1-server-errors',
      'catan-a2-down',
      'catan-a3-lost-games',
      'catan-a4-job-stale',
      'catan-nfr9-window',
      'catan-nfr9-active',
    ]);
    expect(rules().find((r) => r.uid === 'catan-a4-job-stale')!.title).toContain('optional, from 5cf2796b');
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
