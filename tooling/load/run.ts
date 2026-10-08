// X-load runner (AC32): creates `games` rooms over HTTP, seats `players` protocol-client bots in each, starts the games
// and lets the bots play at a human pace for `minutes`. Optionally one or more bots act as slow consumers, and a
// command (e.g. `docker compose restart catan-server`) restarts the server mid-run. Writes a JSON report and prints a
// summary. The report holds client-side numbers only; server-side numbers come from server-report.ts. Room codes and
// seat tokens are never printed or written.
//
//   node --experimental-strip-types --no-warnings --import ./tooling/ts-resolve-hook.mjs tooling/load/run.ts \
//     --url http://localhost --games 10 --players 4 --minutes 7 --report load-report.json
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Bot, type BotStats } from './bot';

export interface RunOptions {
  readonly url: string;
  readonly games: number;
  readonly players: number;
  readonly minutes: number;
  readonly paceMs: readonly [number, number];
  readonly illegalRate: number;
  readonly slowBots: number;
  readonly slowAfterSec: number;
  readonly slowResyncPerSec: number;
  /** How long a slow consumer stays stalled waiting for the server's cut-off before it resumes reading. */
  readonly slowMaxStallSec: number;
  readonly hiddenEverySec: number | null;
  /** How long a hidden spell lasts, uniform in [min, max] s. */
  readonly hiddenForSec: readonly [number, number];
  /** Telemetry flush interval; the web client uses 15 s. */
  readonly telemetryIntervalSec: number;
  readonly seed: number;
  readonly botLocation: string;
  readonly restartAtSec: number | null;
  readonly restartCmd: string | null;
}

/** mulberry32: a small seeded PRNG, so a run's choices are reproducible from its seed. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Creates a room; HEXLANDS_ROOMS_CREATE_PASSPHRASE from the environment is sent when the server requires one (D13). */
async function createRoom(url: string, displayName: string): Promise<{ roomCode: string; seatToken: string }> {
  const passphrase = process.env['HEXLANDS_ROOMS_CREATE_PASSPHRASE'];
  const body = JSON.stringify(passphrase ? { displayName, passphrase } : { displayName });
  const res = await fetch(`${url}/api/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  if (res.status !== 201) throw new Error(`POST /api/rooms → ${res.status} ${await res.text()}`);
  return (await res.json()) as { roomCode: string; seatToken: string };
}

const wsUrlOf = (url: string): string => `${url.replace(/^http/, 'ws').replace(/\/$/, '')}/ws`;

/** Sets up one game: host creates and connects, the others join, the host starts. Returns its bots, seat order. */
export async function setUpGame(o: RunOptions, game: number, slowLeft: { n: number }): Promise<Bot[]> {
  const base = {
    wsUrl: wsUrlOf(o.url),
    paceMs: o.paceMs,
    illegalRate: o.illegalRate,
    telemetryIntervalMs: o.telemetryIntervalSec * 1000,
    hiddenEveryMs: o.hiddenEverySec === null ? null : o.hiddenEverySec * 1000,
    hiddenForMs: [o.hiddenForSec[0] * 1000, o.hiddenForSec[1] * 1000] as const,
  };
  const { roomCode, seatToken } = await createRoom(o.url, `Bot ${game}-1`);
  const host = new Bot({ ...base, roomCode, seatToken, displayName: `Bot ${game}-1`, rand: prng(o.seed * 1000 + game * 10) });
  await host.start();
  const bots = [host];
  for (let p = 2; p <= o.players; p++) {
    const slow =
      p === o.players && slowLeft.n > 0
        ? { afterMs: o.slowAfterSec * 1000, resyncPerSec: o.slowResyncPerSec, pongEveryMs: 5000, maxStallMs: o.slowMaxStallSec * 1000 }
        : undefined;
    if (slow) slowLeft.n--;
    const bot = new Bot({ ...base, roomCode, displayName: `Bot ${game}-${p}`, rand: prng(o.seed * 1000 + game * 10 + p), ...(slow ? { slow } : {}) });
    await bot.start();
    const joined = await bot.join();
    if (joined.result !== 'ok') throw new Error(`game ${game}: join → ${joined.result}/${joined.reasonCode ?? '-'}`);
    bots.push(bot);
  }
  for (let i = 0; i < 50 && (host.room?.seats.filter((s) => s.name !== null).length ?? 0) < o.players; i++) await sleep(100);
  const started = await host.lobby({ kind: 'start' });
  if (started.result !== 'ok') throw new Error(`game ${game}: start → ${started.result}/${started.reasonCode ?? '-'}`);
  return bots;
}

function runCommand(cmd: string): Promise<number> {
  return new Promise((resolve) => execFile('sh', ['-c', cmd], (error) => resolve(error ? (typeof error.code === 'number' ? error.code : 1) : 0)));
}

const sum = (stats: readonly BotStats[], f: (s: BotStats) => number): number => stats.reduce((n, s) => n + f(s), 0);

function merge(records: readonly Record<string, number>[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of records) for (const [k, v] of Object.entries(r)) out[k] = (out[k] ?? 0) + v;
  return out;
}

export function report(o: RunOptions, startedAt: Date, endedAt: Date, games: readonly Bot[][], restart: { atSec: number; exitCode: number } | null) {
  const stats = games.flat().map((b) => b.stats);
  const outcomes = merge(stats.map((s) => s.outcomes));
  const answered = Object.values(outcomes).reduce((a, b) => a + b, 0);
  const rejectedExclAuth = (outcomes['rule'] ?? 0) + (outcomes['turn'] ?? 0) + (outcomes['error'] ?? 0);
  const sent = sum(stats, (s) => s.actionsSent);
  const intendedIllegal = sum(stats, (s) => s.intendedIllegal);
  const gaps = stats.flatMap((s) => s.gaps);
  const gapSummary = (cause: string) => {
    const ms = gaps.filter((g) => g.cause === cause).map((g) => g.ms);
    return { count: ms.length, p50: percentile(ms, 50), max: ms.length === 0 ? null : Math.max(...ms) };
  };
  const rtt = stats.flatMap((s) => s.rttMs);
  const pct = (n: number, d: number) => (d === 0 ? null : Math.round((n / d) * 10_000) / 100);
  return {
    tool: 'tooling/load/run.ts',
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationSec: Math.round((endedAt.getTime() - startedAt.getTime()) / 1000),
    botLocation: o.botLocation,
    games: o.games,
    playersPerGame: o.players,
    bots: stats.length,
    paceMs: o.paceMs,
    illegalRateTarget: o.illegalRate,
    seed: o.seed,
    actions: {
      sent,
      outcomes,
      intendedIllegal,
      intendedIllegalPct: pct(intendedIllegal, sent),
      intendedIllegalRejected: sum(stats, (s) => s.intendedIllegalRejected),
      intendedIllegalAccepted: sum(stats, (s) => s.intendedIllegalAccepted),
      intendedIllegalUnanswered: sum(stats, (s) => s.intendedIllegalUnanswered),
      unansweredAtStop: sum(stats, (s) => s.unansweredAtStop),
      unexpectedRejects: merge(stats.map((s) => s.unexpectedRejects)),
      rejectedExclAuthPct: pct(rejectedExclAuth, answered - (outcomes['auth'] ?? 0)),
    },
    clientActionRttMs: { samples: rtt.length, p50: percentile(rtt, 50), p95: percentile(rtt, 95), max: rtt.length === 0 ? null : Math.round(Math.max(...rtt)) },
    connections: {
      closes: merge(stats.map((s) => s.closes)),
      failedConnectAttempts: sum(stats, (s) => s.failedConnectAttempts),
      reconnects: sum(stats, (s) => s.reconnects),
      resumeGapsMs: { network: gapSummary('network'), server_restart: gapSummary('server_restart') },
    },
    telemetry: { batches: sum(stats, (s) => s.telemetryBatches), samples: sum(stats, (s) => s.telemetrySamples) },
    hiddenSpells: sum(stats, (s) => s.hiddenSpells),
    statesReceived: sum(stats, (s) => s.states),
    gamesFinished: games.filter((g) => g.some((b) => b.stats.gameOver)).length,
    slowConsumers: games.flatMap((g, i) =>
      g.flatMap((b) => {
        const slow = b.stats.slow;
        return slow ? [{ game: i + 1, ...slow }] : [];
      }),
    ),
    restart,
  };
}

export async function run(o: RunOptions): Promise<ReturnType<typeof report>> {
  const startedAt = new Date();
  const slowLeft = { n: o.slowBots };
  const games: Bot[][] = [];
  for (let g = 1; g <= o.games; g++) games.push(await setUpGame(o, g, slowLeft));
  let restart: { atSec: number; exitCode: number } | null = null;
  const restartCmd = o.restartCmd;
  if (o.restartAtSec !== null && restartCmd !== null) {
    void sleep(o.restartAtSec * 1000).then(async () => {
      const atSec = Math.round((Date.now() - startedAt.getTime()) / 1000);
      restart = { atSec, exitCode: await runCommand(restartCmd) };
    });
  }
  const stopEarly = new Promise<void>((r) => process.once('SIGINT', () => r()));
  await Promise.race([sleep(o.minutes * 60_000), stopEarly]);
  for (const b of games.flat()) b.stop();
  return report(o, startedAt, new Date(), games, restart);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      url: { type: 'string', default: 'http://localhost' },
      games: { type: 'string', default: '10' },
      players: { type: 'string', default: '4' },
      minutes: { type: 'string', default: '7' },
      'pace-min-ms': { type: 'string', default: '1000' },
      'pace-max-ms': { type: 'string', default: '5000' },
      illegal: { type: 'string', default: '0.005' },
      'slow-bots': { type: 'string', default: '1' },
      'slow-after-sec': { type: 'string', default: '60' },
      'slow-resync-per-sec': { type: 'string', default: '10' },
      'slow-max-stall-sec': { type: 'string', default: '300' },
      'hidden-every-sec': { type: 'string', default: '180' },
      'telemetry-interval-sec': { type: 'string', default: '15' },
      seed: { type: 'string', default: '1' },
      'bot-location': { type: 'string', default: 'unspecified' },
      'restart-at-sec': { type: 'string' },
      'restart-cmd': { type: 'string' },
      report: { type: 'string', default: 'load-report.json' },
    },
  });
  const n = (k: keyof typeof values) => Number(values[k]);
  const o: RunOptions = {
    url: values.url!.replace(/\/$/, ''),
    games: n('games'),
    players: n('players'),
    minutes: n('minutes'),
    paceMs: [n('pace-min-ms'), n('pace-max-ms')],
    illegalRate: n('illegal'),
    slowBots: n('slow-bots'),
    slowAfterSec: n('slow-after-sec'),
    slowResyncPerSec: n('slow-resync-per-sec'),
    slowMaxStallSec: n('slow-max-stall-sec'),
    hiddenEverySec: n('hidden-every-sec') > 0 ? n('hidden-every-sec') : null,
    hiddenForSec: [2, 8],
    telemetryIntervalSec: n('telemetry-interval-sec'),
    seed: n('seed'),
    botLocation: values['bot-location']!,
    restartAtSec: values['restart-at-sec'] === undefined ? null : n('restart-at-sec'),
    restartCmd: values['restart-cmd'] ?? null,
  };
  const r = await run(o);
  writeFileSync(values.report!, `${JSON.stringify(r, null, 2)}\n`);
  console.log(JSON.stringify(r, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    () => process.exit(0),
    (e: unknown) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    },
  );
}
