// Crash oracle (verify-Va; S-7 V23/V24): kills a real child server with SIGTERM or SIGKILL at a random point while 3
// three-player games are being played, then checks the store and a restart against an independent oracle.
//
// Opt-in: runs only when HEXLANDS_CRASH_RUNS is set (number of runs per signal; default 0 = the suite is skipped).
//   HEXLANDS_CRASH_RUNS=50 HEXLANDS_CRASH_SEED=1000 pnpm vitest run apps/server/src/crash-oracle.test.ts
// With HEXLANDS_CRASH_ARTIFACTS_DIR set, a failing case copies its run directory (the SQLite file with its WAL) and a
// seed.json there before cleanup, so the nightly job can upload them.
// Seeds are deterministic (seed i drives the kill delay, 100–1300 ms after the 3 games start); the games themselves
// advance as fast as the server acks, so the exact kill point varies with machine speed.
//
// Inputs and assumptions:
// - apps/server/src/testing/child-server.ts is the child entry point: it reads HEXLANDS_CHILD={dbPath, config}, prints
//   "READY <port>" on stdout, and handles SIGTERM with the S-7 drain. tooling/ts-resolve-hook.mjs runs it from source.
// - Rate limits are lifted in the child (FAST) so the scripted players are never rate-limited.
// - Players act through the WS protocol only, choosing from their own legal actions (discard > setup > robber > roll >
//   city > endTurn); one action in flight per game. An action counts as ACKED when its outcome is ok with a seq.
// - Oracle, per game, from the SQLite file after the child has exited:
//   integrity_check = ok; event seqs are 1..n with no gap; every acked actionId is in events at its acked seq (no lost
//   acked action); actionIds are unique (no double apply); an independent replayFrom(earliest snapshot, commands)
//   reproduces every hash_after; a restart (in-process startServer on the same file) restores each game at seq n with
//   the replay's head hash; lost_on_restart = 0; every action still in flight at the kill is resent after the restart
//   and gets the committed seq if it was committed, without a second application. The restarted server runs on a
//   FakeClock and is closed in the case: no timer is left, and advancing an hour fires nothing into the closed store.
// - SIGTERM runs also check the drain: exit 0 within 13 s, a clean start marker, close 1012 to every socket, every game
//   snapshotted at its head, /healthz 200 or 503 while draining. SIGKILL runs check an unclean start.
// - The engine is required to be deterministic (replayFrom); the server's stateHash test hook must be on (NODE_ENV=test).
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { deserializeState, replayFrom, stateHash, type Command } from '@hexlands/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { startServer } from './server';
import { FakeClock } from './testing';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CHILD = path.join(REPO, 'apps/server/src/testing/child-server.ts');
const HOOK = path.join(REPO, 'tooling/ts-resolve-hook.mjs');
const FAST = { ops: { maxMsgsPerSecPerConn: 1000, maxMsgBurstPerConn: 1000 } };
const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });
// Wire frames and views are untyped JSON here; the oracle reads only the fields it checks.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Msg = Record<string, any>;
let idn = 0;
const newId = () => `00000000-0000-4000-b000-${String(++idn).padStart(12, '0')}`;
const R = ['brick', 'lumber', 'wool', 'grain', 'ore'] as const;

function lcg(seed: number) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32); }

class Sock {
  frames: Msg[] = [];
  closeCode: number | null = null;
  waiters = new Map<string, (m: Msg) => void>();
  onState: ((m: Msg) => void) | null = null;
  constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as Msg;
      this.frames.push(m);
      if (m['t'] === 'outcome') this.waiters.get(String(m['actionId']))?.(m);
      if (m['t'] === 'state') this.onState?.(m);
    });
    ws.on('close', (c) => { this.closeCode = c; });
    ws.on('error', () => undefined);
  }
  static open(port: number): Promise<Sock> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    cleanups.push(() => ws.terminate());
    return new Promise((res, rej) => ws.once('open', () => res(new Sock(ws))).once('error', rej));
  }
  cmd(msg: Msg, actionId = newId()): Promise<Msg> {
    const p = new Promise<Msg>((r) => this.waiters.set(actionId, r));
    this.ws.send(JSON.stringify({ ...msg, actionId }));
    return p;
  }
}
const http = (port: number, method: string, p: string, body?: unknown) => new Promise<{ status: number; json: Msg }>((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, path: p, method, headers: { 'Content-Type': 'application/json' } }, (res) => {
    const c: Buffer[] = []; res.on('data', (b: Buffer) => c.push(b));
    res.on('end', () => { let j: Msg = {}; try { j = JSON.parse(Buffer.concat(c).toString()) as Msg; } catch { /* not JSON */ } resolve({ status: res.statusCode!, json: j }); });
  });
  req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
});

async function spawnChild(dbPath: string) {
  const proc = spawn(process.execPath, ['--experimental-transform-types', '--no-warnings', '--import', HOOK, CHILD], {
    cwd: REPO, env: { ...process.env, NODE_ENV: 'test', HEXLANDS_CHILD: JSON.stringify({ dbPath, config: FAST }) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  cleanups.push(() => proc.kill('SIGKILL'));
  const exited = new Promise<{ code: number | null; signal: string | null; at: number }>((r) => proc.once('exit', (code, signal) => r({ code, signal, at: Date.now() })));
  const port = await new Promise<number>((resolve, reject) => {
    let out = ''; proc.stdout!.on('data', (d: Buffer) => { out += d; const m = /^READY (\d+)$/m.exec(out); if (m) resolve(Number(m[1])); });
    void exited.then(() => reject(new Error('child exited early')));
  });
  return { proc, port, exited };
}

interface Game { roomCode: string; tokens: string[]; socks: Sock[]; acked: Map<string, number>; pending: Map<string, Msg>; stop: boolean }

function chooseAction(views: (Msg | null)[]): { seat: number; action: Msg } | null {
  for (let s = 0; s < views.length; s++) {
    const l = views[s]?.legal; if (!l) continue;
    if (l.discard) {
      const hand = { ...views[s]!.hand }; const cards: Record<string, number> = { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 };
      for (let i = 0; i < l.discard.count; i++) { const r = R.reduce((b, x) => (hand[x] > hand[b] ? x : b)); hand[r] -= 1; cards[r] = (cards[r] ?? 0) + 1; }
      return { seat: s, action: { type: 'discard', cards } };
    }
  }
  for (let s = 0; s < views.length; s++) {
    const l = views[s]?.legal; if (!l) continue;
    if (l.placeSettlement?.length) return { seat: s, action: { type: 'placeSettlement', vertex: l.placeSettlement[0] } };
    if (l.placeRoad?.length && l.phase !== 'main') return { seat: s, action: { type: 'placeRoad', edge: l.placeRoad[0] } };
    if (l.moveRobber?.length) return { seat: s, action: { type: 'moveRobber', hex: l.moveRobber[0].hex, victim: l.moveRobber[0].victims[0] ?? null } };
    if (l.rollDice) return { seat: s, action: { type: 'rollDice' } };
    if (l.buildCity?.length) return { seat: s, action: { type: 'buildCity', vertex: l.buildCity[0] } };
    if (l.endTurn) return { seat: s, action: { type: 'endTurn' } };
  }
  return null;
}

async function startGame(port: number): Promise<Game> {
  const { json } = await http(port, 'POST', '/api/rooms', { displayName: 'Ana' });
  const host = await Sock.open(port);
  await host.cmd({ t: 'hello', v: 1, roomCode: json.roomCode, seatToken: json.seatToken });
  const socks = [host]; const tokens = [json.seatToken as string];
  for (const n of ['Bo', 'Cy']) {
    const c = await Sock.open(port); await c.cmd({ t: 'hello', v: 1, roomCode: json.roomCode });
    await c.cmd({ t: 'lobby', op: { kind: 'join', displayName: n } });
    tokens.push([...c.frames].reverse().find((f) => f['t'] === 'seatToken')!['seatToken']); socks.push(c);
  }
  const g: Game = { roomCode: json.roomCode, tokens, socks, acked: new Map(), pending: new Map(), stop: false };
  const views: (Msg | null)[] = [null, null, null];
  let head = 0; let busy = false;
  const step = () => {
    if (busy || g.stop) return;
    const c = chooseAction(views); if (!c) return;
    busy = true;
    const aid = newId(); const msg = { t: 'action', baseSeq: head, action: c.action };
    g.pending.set(aid, { seat: c.seat, msg });
    g.socks[c.seat]!.cmd(msg, aid).then((o) => {
      g.pending.delete(aid);
      if (o['result'] === 'ok') g.acked.set(aid, o['seq']);
      else if (o['reasonCode'] !== 'server_draining') g.pending.set(aid, { seat: c.seat, msg, rejected: o });
      busy = false; setImmediate(step);
    });
  };
  socks.forEach((s, i) => { s.onState = (m) => { if (m['seq'] >= head) { head = m['seq']; } views[i] = m['view']; setImmediate(step); }; });
  await host.cmd({ t: 'lobby', op: { kind: 'start' } });
  return g;
}

async function run(kind: 'SIGTERM' | 'SIGKILL', seed: number) {
  const rnd = lcg(seed);
  const dir = mkdtempSync(path.join(tmpdir(), 'vs7-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  lastRunDir = dir;
  const dbPath = path.join(dir, 'h.db');
  const child = await spawnChild(dbPath);
  const games = [await startGame(child.port), await startGame(child.port), await startGame(child.port)];
  await new Promise((r) => setTimeout(r, 100 + Math.floor(rnd() * 1200)));
  const health: number[] = [];
  const t0 = Date.now();
  child.proc.kill(kind);
  // poll /healthz while draining
  const poll = (async () => { for (let i = 0; i < 40; i++) { try { health.push((await http(child.port, 'GET', '/healthz')).status); } catch { break; } await new Promise((r) => setTimeout(r, 25)); } })();
  const ex = await child.exited; await poll;
  for (const g of games) g.stop = true;
  await new Promise((r) => setTimeout(r, 50));
  const closeCodes = games.flatMap((g) => g.socks.map((s) => s.closeCode));
  // store checks
  const db = new Database(dbPath);
  const integrity = db.pragma('integrity_check', { simple: true });
  const out: Msg = { kind, seed, exit: ex, ms: ex.at - t0, integrity, health: [...new Set(health)], closeCodes: [...new Set(closeCodes)], games: [] };
  for (const g of games) {
    const gid = (db.prepare('SELECT id FROM games WHERE room_code = ?').get(g.roomCode) as { id: string }).id;
    const ev = db.prepare('SELECT seq, action_id, command_json, hash_after FROM events WHERE game_id = ? ORDER BY seq').all(gid) as Msg[];
    const snaps = db.prepare('SELECT seq, state_json FROM snapshots WHERE game_id = ? ORDER BY seq').all(gid) as Msg[];
    const seqsOk = ev.every((e, i) => e['seq'] === i + 1);
    const byAid = new Map(ev.map((e) => [e['action_id'], e['seq']]));
    const ackedOk = [...g.acked].every(([a, s]) => byAid.get(a) === s);
    const uniq = new Set(ev.map((e) => e['action_id'])).size === ev.length;
    // independent replay from the earliest snapshot
    const first = snaps[0]!; const parsed = deserializeState(first['state_json']); if (!parsed.ok) throw new Error('snap');
    const after = ev.filter((e) => e['seq'] > first['seq']);
    const rep = replayFrom(parsed.state, after.map((e) => JSON.parse(e['command_json']) as Command));
    const replayOk = after.every((e, i) => rep.results[i]?.ok && rep.hashes[i] === e['hash_after']);
    const headHash = after.length ? rep.hashes.at(-1) : stateHash(parsed.state);
    out.games.push({ gid, room: g.roomCode, events: ev.length, acked: g.acked.size, pending: [...g.pending.keys()], seqsOk, ackedOk, uniq, replayOk, headSnap: snaps.at(-1)!['seq'], headHash, byAid });
  }
  db.close();
  // restart in-process and check recovery + resends; on a FakeClock, so the teardown check below is deterministic
  const clock2 = new FakeClock(Date.now());
  const s2 = await startServer({ port: 0, dbPath, telemetry: 'memory', config: FAST, clock: clock2 });
  cleanups.push(() => s2.close());
  const m = s2.telemetry.metrics();
  // server.starts is zero-initialised for both kinds (T-1); only the kind that was counted matters.
  out.starts = m['catan.server.starts']?.points.filter((p: Msg) => p.value > 0).map((p: Msg) => p.attributes.shutdown);
  out.lost = m['catan.games.lost_on_restart']?.points.reduce((a: number, p: Msg) => a + p.value, 0) ?? 0;
  out.restored = m['catan.games.restored_on_start']?.points.reduce((a: number, p: Msg) => a + p.value, 0) ?? 0;
  out.resends = [] as Msg[];
  for (const [gi, g] of games.entries()) {
    const info = out.games[gi]; const h = s2.stateHash(g.roomCode)!;
    info.restartHashOk = h.seq === info.events && h.stateHash === info.headHash;
    for (const [aid, p] of g.pending) {
      if (p['rejected']) continue;
      const sock = await Sock.open(s2.port);
      await sock.cmd({ t: 'hello', v: 1, roomCode: g.roomCode, seatToken: g.tokens[p['seat']], lastSeq: 0 });
      const o = await sock.cmd(p['msg'], aid);
      const committedSeq = info.byAid.get(aid);
      out.resends.push({ committed: committedSeq !== undefined, ok: o['result'] === 'ok' && (committedSeq === undefined || o['seq'] === committedSeq), o: `${o['result']}/${o['reasonCode'] ?? ''}/${o['seq'] ?? ''}` });
      const h2 = s2.stateHash(g.roomCode)!;
      if (committedSeq !== undefined) expect(h2.seq, 'no double apply').toBe(info.events);
    }
    delete info.byAid;
  }
  // Teardown: close() leaves no timer, and an hour later nothing fires into the closed store (a throw fails the case).
  await s2.close();
  out.timersAfterClose = clock2.pendingTimers();
  clock2.advance(3_600_000);
  return out;
}


/** The current run's temporary directory, kept for the failure artifacts. */
let lastRunDir: string | null = null;
const ARTIFACTS = process.env['HEXLANDS_CRASH_ARTIFACTS_DIR'];
/** On failure, copies the run directory and its seed to ARTIFACTS/<kind>-<seed>, then rethrows. */
async function keepOnFailure(kind: string, seed: number, body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (err) {
    if (ARTIFACTS !== undefined && ARTIFACTS !== '' && lastRunDir !== null) {
      const to = path.join(ARTIFACTS, `${kind}-${seed}`);
      mkdirSync(to, { recursive: true });
      cpSync(lastRunDir, to, { recursive: true });
      writeFileSync(path.join(to, 'seed.json'), JSON.stringify({ kind, seed, error: String(err).slice(0, 2000) }, null, 2));
    }
    throw err;
  }
}

const RUNS = Number(process.env['HEXLANDS_CRASH_RUNS'] ?? '0');
const SEED = Number(process.env['HEXLANDS_CRASH_SEED'] ?? '100');
const CASES = [...Array(RUNS).keys()].flatMap((i) => [['SIGTERM', SEED + 2 * i], ['SIGKILL', SEED + 2 * i + 1]] as const);

describe.skipIf(RUNS === 0)('crash oracle (SIGTERM / SIGKILL at a random point)', () => {
  it.each(CASES)('%s seed %i', (kind, seed) => keepOnFailure(kind, seed, async () => {
    lastRunDir = null;
    const r = await run(kind, seed);
    console.log(JSON.stringify({ ...r, games: r.games.map((g: Msg) => ({ ev: g.events, acked: g.acked, pend: g.pending.length, ok: [g.seqsOk, g.ackedOk, g.uniq, g.replayOk, g.restartHashOk], headSnap: g.headSnap })) }));
    expect(r.integrity).toBe('ok');
    expect(r.lost).toBe(0);
    expect(r.timersAfterClose, 'no timer left after the restarted server closes').toBe(0);
    for (const g of r.games) {
      expect(g.seqsOk, 'event seqs 1..n').toBe(true);
      expect(g.ackedOk, 'no lost acked action').toBe(true);
      expect(g.uniq, 'no double apply').toBe(true);
      expect(g.replayOk, 'independent replay matches hash_after').toBe(true);
      expect(g.restartHashOk, 'restart hash = replay head').toBe(true);
      expect(g.acked).toBeGreaterThan(0);
    }
    for (const x of r.resends) expect(x.ok || !x.committed, JSON.stringify(x)).toBe(true);
    if (kind === 'SIGTERM') {
      expect(r.exit).toMatchObject({ code: 0, signal: null });
      expect(r.ms).toBeLessThan(13_000);
      expect(r.starts).toEqual(['clean']);
      expect(r.closeCodes).toEqual([1012]);
      for (const g of r.games) expect(g.headSnap).toBe(g.events);
      expect(r.health.every((h: number) => h === 200 || h === 503)).toBe(true);
    } else {
      expect(r.exit.signal).toBe('SIGKILL');
      expect(r.starts).toEqual(['unclean']);
    }
  }), 60_000);
});
