import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../../apps/server/src/server';
import { createGame, DEFAULT_GAME_CONFIG, reduce, view, type GameState, type Seat } from '../../packages/engine/src/index';
import { hasAction, pickIllegal, pickLegal } from './picker';
import { percentile, prng, run, type RunOptions } from './run';
import { expand, QUERIES } from './server-report';
import { TelemetryBuffer } from './telemetry';

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

describe('picker (X-load bot actions)', () => {
  it('every pick from a seat’s own view is accepted by the reducer, and every intended-illegal pick is rejected', () => {
    let legal = 0;
    let illegal = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const rand = prng(seed);
      const created = createGame({ config: DEFAULT_GAME_CONFIG.rules, playerCount: 4, seed: `load-${seed}` });
      if (!created.ok) throw new Error('createGame rejected');
      let state: GameState = created.state;
      for (let step = 0; step < 300 && state.phase.name !== 'gameOver'; step++) {
        const seats = ([0, 1, 2, 3] as Seat[]).filter((s) => hasAction(view(state, s).hand, view(state, s).legal));
        expect(seats.length, `seed ${seed} step ${step}`).toBeGreaterThan(0);
        const seat = seats[Math.floor(rand() * seats.length)]!;
        const v = view(state, seat);
        const bad = pickIllegal(v.legal);
        if (bad) {
          expect(reduce(state, { by: seat, action: bad }).ok, JSON.stringify(bad)).toBe(false);
          illegal++;
        }
        const action = pickLegal(v.hand, v.legal, rand)!;
        const r = reduce(state, { by: seat, action });
        expect(r.ok, `seed ${seed} step ${step}: ${JSON.stringify(action)}`).toBe(true);
        if (r.ok) state = r.state;
        legal++;
      }
    }
    expect(legal).toBeGreaterThan(2000);
    expect(illegal).toBeGreaterThan(1000);
  });
});

describe('TelemetryBuffer (web-client batches)', () => {
  it('rounds and clamps samples, caps each array at 100 and omits empty arrays', () => {
    const t = new TelemetryBuffer();
    expect(t.takeBatch()).toBeNull();
    for (let i = 0; i < 150; i++) t.addActionRtt(i + 0.4);
    t.addActionRtt(-5);
    t.addActionRtt(1e9);
    t.addResumeGap(1234.6, 'server_restart');
    const first = t.takeBatch()!;
    expect(first.actionRttMs).toHaveLength(100);
    expect(first.actionRttMs![0]).toBe(0);
    expect(first.resumeGaps).toEqual([{ ms: 1235, cause: 'server_restart' }]);
    const second = t.takeBatch()!;
    expect(second.actionRttMs!.slice(-2)).toEqual([0, 60_000]);
    expect(second).not.toHaveProperty('resumeGaps');
    expect(t.takeBatch()).toBeNull();
  });
});

describe('server-report queries', () => {
  it('scope every query to the cluster and namespace and to the run window', () => {
    for (const q of Object.values(QUERIES)) {
      const e = expand(q, 'loadtest', 600);
      expect(e).toContain('cluster="loadtest",namespace="catan-server"');
      expect(e).toContain('[600s]');
      expect(e).not.toMatch(/\{S|\[R\]/);
    }
    expect(expand(QUERIES['nfr1ShareWithin50ms']!, 'local', 60)).toContain('{cluster="local",namespace="catan-server",le="0.05"}');
  });

  it('percentile is nearest-rank', () => {
    expect(percentile([], 95)).toBeNull();
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([...Array(100).keys()], 95)).toBe(94);
  });
});

describe('load run against a real server (in process)', () => {
  async function boot(): Promise<{ s: RunningServer; logs: string[] }> {
    const dir = mkdtempSync(path.join(tmpdir(), 'hexlands-load-'));
    const logs: string[] = [];
    const s = await startServer({
      port: 0,
      dbPath: path.join(dir, 'db'),
      telemetry: 'memory',
      buildVersion: 'v-load',
      // A high message rate lets the slow consumer's resync requests fill its buffer within seconds.
      config: { ops: { maxMsgsPerSecPerConn: 1000, maxMsgBurstPerConn: 2000 } },
      logLine: (line) => logs.push(line),
    });
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => s.close());
    return { s, logs };
  }

  const sumPoints = (s: RunningServer, name: string, attrs: Record<string, string> = {}): number =>
    (s.telemetry.metrics()[name]?.points ?? [])
      .filter((p) => Object.entries(attrs).every(([k, v]) => p.attributes[k] === v))
      .reduce((n, p) => n + (p.value ?? p.count ?? 0), 0);

  it('bots play two games, a slow consumer is cut off by backpressure and resumes, and telemetry reaches the server', async () => {
    const { s, logs } = await boot();
    const o: RunOptions = {
      url: `http://127.0.0.1:${s.port}`,
      games: 2,
      players: 4,
      minutes: 0.25,
      paceMs: [20, 60],
      illegalRate: 0.05,
      slowBots: 1,
      slowAfterSec: 1,
      slowResyncPerSec: 400,
      hiddenEverySec: 3,
      hiddenForSec: [0.2, 0.5],
      telemetryIntervalSec: 2,
      seed: 7,
      botLocation: 'test',
      restartAtSec: null,
      restartCmd: null,
    };
    const r = await run(o);
    if (r.actions.sent <= 100 || r.slowConsumers[0]?.cutAfterMs == null) console.log(JSON.stringify(r, null, 2));

    expect(r.bots).toBe(8);
    expect(r.actions.sent).toBeGreaterThan(100);
    expect(r.actions.intendedIllegal).toBeGreaterThan(0);
    expect(r.actions.intendedIllegalRejected).toBe(r.actions.intendedIllegal);
    expect(r.actions.outcomes['error'] ?? 0).toBe(0);
    expect(r.actions.outcomes['auth'] ?? 0).toBe(0);

    const [slow] = r.slowConsumers;
    expect(slow).toMatchObject({ game: 1, gaveUp: false });
    expect(slow!.cutAfterMs).not.toBeNull();
    expect(r.connections.reconnects).toBeGreaterThanOrEqual(1);
    expect(r.connections.resumeGapsMs.network.count).toBeGreaterThanOrEqual(1);
    expect(r.connections.resumeGapsMs.server_restart.count).toBe(0);
    const cut = logs.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l['event'] === 'player.disconnected' && l['cause'] === 'backpressure');
    expect(cut).toHaveLength(1);
    expect(sumPoints(s, 'catan.ws.disconnects', { reason: 'unplanned' })).toBeGreaterThanOrEqual(1);

    expect(r.telemetry.batches).toBeGreaterThan(0);
    expect(sumPoints(s, 'catan.client.action_rtt')).toBeGreaterThan(0);
    expect(sumPoints(s, 'catan.ws.resume_gap', { cause: 'network' })).toBeGreaterThanOrEqual(1);
    expect(sumPoints(s, 'catan.errors')).toBe(0);
  }, 60_000);
});
