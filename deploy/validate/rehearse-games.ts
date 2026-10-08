// Local rehearsal helper (deploy/validate/rehearse.sh; never against a real host): plays games against a local stack
// through Caddy with tooling/load's protocol-client bots, fast-paced, until `--finished` games have reached gameOver;
// the other games are left mid-game (active). Writes the room codes and seat tokens it saw to `--secrets` (mode 0600,
// for the exact-value log scan) and a summary to `--out`; prints counts only, never a code or a token.
//
//   node --experimental-strip-types --no-warnings --import ./tooling/ts-resolve-hook.mjs deploy/validate/rehearse-games.ts \
//     --url http://localhost --games 2 --finished 1 --max-minutes 10 --out games.json --secrets secrets.json
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Bot } from '../../tooling/load/bot';
import { prng } from '../../tooling/load/run';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://localhost' },
    games: { type: 'string', default: '2' },
    players: { type: 'string', default: '3' },
    finished: { type: 'string', default: '1' },
    'max-minutes': { type: 'string', default: '10' },
    seed: { type: 'string', default: '7' },
    out: { type: 'string' },
    secrets: { type: 'string' },
  },
});
const url = values.url!.replace(/\/$/, '');
const games = Number(values.games);
const players = Number(values.players);
const wantFinished = Number(values.finished);
const deadline = Date.now() + Number(values['max-minutes']) * 60_000;
const seed = Number(values.seed);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const base = {
  wsUrl: `${url.replace(/^http/, 'ws')}/ws`,
  paceMs: [0, 3] as const,
  illegalRate: 0,
  telemetryIntervalMs: 15_000,
  hiddenEveryMs: null,
  hiddenForMs: [0, 0] as const,
};

/** The token a bot holds (its own after join; the host's from the create). */
const tokenOf = (bot: Bot): string | undefined => Reflect.get(bot, 'seatToken') as string | undefined;

const rooms: { roomCode: string; bots: Bot[] }[] = [];
for (let g = 0; g < games; g++) {
  const res = await fetch(`${url}/api/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName: `R${g}-1` }) });
  if (res.status !== 201) throw new Error(`POST /api/rooms → ${res.status}`);
  const { roomCode, seatToken } = (await res.json()) as { roomCode: string; seatToken: string };
  const host = new Bot({ ...base, roomCode, seatToken, displayName: `R${g}-1`, rand: prng(seed * 100 + g * 10) });
  await host.start();
  const bots = [host];
  for (let p = 2; p <= players; p++) {
    const bot = new Bot({ ...base, roomCode, displayName: `R${g}-${p}`, rand: prng(seed * 100 + g * 10 + p) });
    await bot.start();
    const joined = await bot.join();
    if (joined.result !== 'ok') throw new Error(`game ${g}: join → ${joined.result}`);
    bots.push(bot);
  }
  for (let i = 0; i < 50 && (host.room?.seats.filter((s) => s.name !== null).length ?? 0) < players; i++) await sleep(100);
  const started = await host.lobby({ kind: 'start' });
  if (started.result !== 'ok') throw new Error(`game ${g}: start → ${started.result}`);
  rooms.push({ roomCode, bots });
}

const finished = () => rooms.filter((r) => r.bots.some((b) => b.stats.gameOver)).length;
while (finished() < wantFinished && Date.now() < deadline) await sleep(500);
for (const r of rooms) for (const b of r.bots) b.stop();

const summary = {
  games,
  finished: finished(),
  active: rooms.length - finished(),
  actionsSent: rooms.flatMap((r) => r.bots).reduce((n, b) => n + b.stats.actionsSent, 0),
};
if (values.out) writeFileSync(values.out, JSON.stringify(summary));
if (values.secrets) {
  const secrets = { roomCodes: rooms.map((r) => r.roomCode), seatTokens: rooms.flatMap((r) => r.bots.map(tokenOf)).filter((t): t is string => !!t) };
  writeFileSync(values.secrets, JSON.stringify(secrets), { mode: 0o600 });
}
console.log(JSON.stringify(summary));
process.exit(summary.finished >= wantFinished ? 0 : 1);
