// AC30 secrets scan, CI part (design §3.12 TH12, §2.4, §7 F16, §9.5; Evolve G4; verification V31, V17). A scripted
// session runs against real servers:
// - create two rooms, join, start (seeded), and a full 4-player game replayed from V-a's golden v15-game-4p;
// - a reload, a device switch, rejected_auth attempts (bad token, unknown room, a token from the other room);
// - a SIGTERM-path drain (server.draining) and a restart on the same database, after which every seat says hello again.
// Captured: every log record (OTLP body) and stdout line, span names/attributes/events, metric labels, every HTTP
// response (status, headers, body), and every frame each socket received. Every SecretRegistry value and every invite
// and rejoin fragment built from them must appear nowhere, except the POST /api/rooms response to its creator and the
// seatToken frame to the socket that joined. The facade has no log level filter, so every severity is captured.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Command } from '@hexlands/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { startServer, type RunningServer, type ServerOptions } from './server';
import { RecordingSecrets } from './testing';
import { ENTROPY_THRESHOLD, entropy, findLeaks, findSecretShapes, needlesFor, type Artifact } from './testing/secret-scan';

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const GOLDEN = new URL('../../../packages/engine/src/__fixtures__/golden/v15-game-4p.json', import.meta.url);
interface GoldenGame {
  readonly init: { readonly seed: string };
  readonly steps: readonly { readonly command: Command }[];
}

let n = 0;
const id = () => `00000000-0000-4000-a000-${String(++n).padStart(12, '0')}`;
const tick = () => new Promise((r) => setTimeout(r, 20));
type Msg = Record<string, unknown>;

/** Everything a session produced, per channel. */
class Capture {
  readonly artifacts: Artifact[] = [];
  private sockets = 0;

  http(method: string, url: string, status: number, headers: unknown, body: string, allowed: readonly string[] = []): void {
    this.artifacts.push({ channel: 'http', where: `${method} ${url} ${status}`, text: `${JSON.stringify(headers)}\n${body}`, allowed });
  }

  server(s: RunningServer, label: string): void {
    for (const r of s.telemetry.logs()) this.artifacts.push({ channel: 'log', where: `${label} log`, text: String(r.body) + JSON.stringify(r.attributes) });
    for (const sp of s.telemetry.spans()) {
      this.artifacts.push({ channel: 'span', where: `${label} span ${sp.name}`, text: `${sp.name}\n${JSON.stringify(sp.attributes)}\n${JSON.stringify(sp.events)}` });
    }
    this.artifacts.push({ channel: 'metric', where: `${label} metrics`, text: JSON.stringify(s.telemetry.metrics()) });
  }

  stdout(lines: readonly string[], label: string): void {
    for (const l of lines) this.artifacts.push({ channel: 'stdout', where: `${label} stdout`, text: l });
  }

  socket(): number {
    return ++this.sockets;
  }
}

class Client {
  readonly frames: Msg[] = [];
  private waiters = new Map<string, (m: Msg) => void>();
  private constructor(
    readonly ws: WebSocket,
    readonly socketId: number,
    readonly label: string,
  ) {
    ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as Msg;
      this.frames.push(m);
      if (m['t'] === 'ping') ws.send(JSON.stringify({ t: 'pong', id: m['id'] }));
      if (m['t'] === 'outcome') this.waiters.get(String(m['actionId']))?.(m);
    });
  }
  static async open(port: number, cap: Capture, label: string): Promise<Client> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    cleanups.push(() => ws.terminate());
    await new Promise((r, j) => ws.once('open', r).once('error', j));
    return new Client(ws, cap.socket(), label);
  }
  cmd(msg: Msg): Promise<Msg> {
    const actionId = id();
    const done = new Promise<Msg>((r) => this.waiters.set(actionId, r));
    this.ws.send(JSON.stringify({ ...msg, actionId }));
    return done;
  }
  hello(roomCode: string, extra: Msg = {}) {
    return this.cmd({ t: 'hello', v: 1, roomCode, ...extra });
  }
  last(t: string): Msg | undefined {
    return [...this.frames].reverse().find((f) => f['t'] === t);
  }
  /** This socket's frames as artifacts; its own issuing seatToken frame may carry that token. */
  artifacts(): Artifact[] {
    return this.frames.map((f, i) => ({
      channel: 'frame' as const,
      where: `frame #${i} (${String(f['t'])}) → ${this.label} socket ${this.socketId}`,
      text: JSON.stringify(f),
      allowed: f['t'] === 'seatToken' ? [String(f['seatToken'])] : [],
    }));
  }
}

function parseJson(text: string): Msg {
  try {
    return JSON.parse(text) as Msg;
  } catch {
    return {};
  }
}

function http(cap: Capture, port: number, method: string, url: string, body?: unknown): Promise<{ status: number; json: Msg }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: url, method, headers: { 'Content-Type': 'application/json' } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const json = parseJson(text);
        // The create response is the one place a room code and the host's token are returned (to their creator).
        const allowed = method === 'POST' && res.statusCode === 201 ? [String(json['roomCode']), String(json['seatToken'])] : [];
        cap.http(method, url, res.statusCode ?? 0, res.headers, text, allowed);
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function boot(dbPath: string, secrets: RecordingSecrets, lines: string[], seed: string): Promise<RunningServer> {
  const opts: ServerOptions = {
    port: 0,
    dbPath,
    telemetry: 'memory',
    // The scripted clients send as fast as outcomes return; the per-socket message rate (P7) is not under test here.
    config: { ops: { maxMsgsPerSecPerConn: 10_000, maxMsgBurstPerConn: 10_000 } },
    secrets,
    logLine: (l) => lines.push(l),
    testHooks: { seedFor: () => ({ seed }) },
  };
  const s = await startServer(opts);
  cleanups.push(() => s.close());
  return s;
}

/** The scripted session; returns everything it captured and the registry of issued secrets. */
async function session(): Promise<{ cap: Capture; secrets: RecordingSecrets }> {
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as GoldenGame;
  const dir = mkdtempSync(path.join(tmpdir(), 'hexlands-ac30-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'db');
  const cap = new Capture();
  const secrets = new RecordingSecrets();
  const lines1: string[] = [];
  const s1 = await boot(dbPath, secrets, lines1, golden.init.seed);

  // Two rooms: A plays the full game, B supplies a token that is wrong for A.
  const a = await http(cap, s1.port, 'POST', '/api/rooms', { displayName: 'Ana' });
  const b = await http(cap, s1.port, 'POST', '/api/rooms', { displayName: 'Zed' });
  const roomA = String(a.json['roomCode']);
  const tokens: string[] = [String(a.json['seatToken'])];
  const clients: Client[] = [await Client.open(s1.port, cap, 'seat 0')];
  await clients[0]!.hello(roomA, { seatToken: tokens[0] });
  for (const [i, name] of ['Bo', 'Cy', 'Di'].entries()) {
    const c = await Client.open(s1.port, cap, `seat ${i + 1}`);
    await c.hello(roomA);
    await c.cmd({ t: 'lobby', op: { kind: 'join', displayName: name } });
    tokens.push(String(c.last('seatToken')!['seatToken']));
    clients.push(c);
  }
  const all: Client[] = [...clients];
  expect(await clients[0]!.cmd({ t: 'lobby', op: { kind: 'start' } })).toMatchObject({ result: 'ok' });
  await tick();

  // rejected_auth: a bad token, an unknown room, room B's token in room A.
  const intruder = await Client.open(s1.port, cap, 'intruder');
  all.push(intruder);
  await intruder.hello(roomA, { seatToken: 'A'.repeat(43) });
  const intruder2 = await Client.open(s1.port, cap, 'intruder');
  all.push(intruder2);
  await intruder2.hello('QQQQQQ', { seatToken: tokens[1] });
  const intruder3 = await Client.open(s1.port, cap, 'intruder');
  all.push(intruder3);
  await intruder3.hello(roomA, { seatToken: String(b.json['seatToken']) });
  await http(cap, s1.port, 'GET', '/healthz');

  let seq = 0;
  let server = s1;
  const play = async (from: number, to: number) => {
    for (const step of golden.steps.slice(from, to)) {
      const by = step.command.by as number;
      const out = await clients[by]!.cmd({ t: 'action', baseSeq: seq, action: step.command.action });
      expect(out, `step ${seq} by ${by}: ${JSON.stringify(out)} ${JSON.stringify(step.command.action)}`).toMatchObject({ result: "ok" });
      seq = Number(out['seq']);
    }
  };
  await play(0, 120);

  // A reload of seat 2 (new socket, same token, behind by a few seqs) and a device switch of seat 3.
  clients[2]!.ws.close(1000);
  const reloaded = await Client.open(server.port, cap, 'seat 2');
  expect(await reloaded.hello(roomA, { seatToken: tokens[2], lastSeq: seq - 3 })).toMatchObject({ result: 'ok' });
  clients[2] = reloaded;
  all.push(reloaded);
  const switched = await Client.open(server.port, cap, 'seat 3');
  expect(await switched.hello(roomA, { seatToken: tokens[3], lastSeq: seq })).toMatchObject({ result: 'ok' });
  clients[3] = switched;
  all.push(switched);
  await play(120, 240);

  // Host relink of seat 1: the old token is revoked (its socket closes, a hello with it is refused), the new one resumes.
  expect(await clients[0]!.cmd({ t: 'control', op: { kind: 'relinkSeat', seat: 1 } })).toMatchObject({ result: 'ok' });
  const relinked = clients[0]!.last('seatToken')!;
  expect(relinked).toMatchObject({ seat: 1, purpose: 'relinked' });
  const oldToken = tokens[1]!;
  tokens[1] = String(relinked['seatToken']);
  expect(tokens[1]).not.toBe(oldToken);
  const stale = await Client.open(server.port, cap, 'seat 1 (old link)');
  all.push(stale);
  expect(await stale.hello(roomA, { seatToken: oldToken, lastSeq: seq })).toMatchObject({ result: 'auth', reasonCode: 'seat_token_revoked' });
  const relinkedSeat = await Client.open(server.port, cap, 'seat 1');
  expect(await relinkedSeat.hello(roomA, { seatToken: tokens[1], lastSeq: seq })).toMatchObject({ result: 'ok' });
  clients[1] = relinkedSeat;
  all.push(relinkedSeat);

  // SIGTERM path: drain (server.draining), then a restart on the same database; every seat says hello again.
  await http(cap, server.port, 'GET', '/healthz');
  const draining = server.drain();
  await http(cap, server.port, 'GET', '/healthz').catch(() => undefined);
  await draining;
  cap.server(s1, 'server 1');
  cap.stdout(lines1, 'server 1');
  const lines2: string[] = [];
  server = await boot(dbPath, secrets, lines2, golden.init.seed);
  for (let seat = 0; seat < 4; seat++) {
    const c = await Client.open(server.port, cap, `seat ${seat}`);
    expect(await c.hello(roomA, { seatToken: tokens[seat], lastSeq: seq })).toMatchObject({ result: 'ok' });
    clients[seat] = c;
    all.push(c);
  }
  await play(240, golden.steps.length);
  await http(cap, server.port, 'GET', '/healthz');
  await tick();
  cap.server(server, 'server 2');
  cap.stdout(lines2, 'server 2');
  for (const c of all) cap.artifacts.push(...c.artifacts());

  // The session reached the end of the game and exercised the drain path.
  expect(seq).toBe(golden.steps.length);
  expect(cap.artifacts.some((x) => x.channel === 'log' && x.text.includes('"event":"server.draining"'))).toBe(true);
  return { cap, secrets };
}

describe('AC30: no issued room code, seat token or link fragment leaks (V31, V17)', () => {
  it('a scripted session (full seeded game, reload, device switch, rejected_auth, host relink, drain + restart) leaks nothing', async () => {
    const { cap, secrets } = await session();
    const recorded = secrets.all();
    expect(recorded.filter((r) => r.kind === 'roomCode')).toHaveLength(2);
    expect(recorded.filter((r) => r.kind === 'seatToken')).toHaveLength(6);
    const channels = new Set(cap.artifacts.map((x) => x.channel));
    expect([...channels].sort()).toEqual(['frame', 'http', 'log', 'metric', 'span', 'stdout']);
    expect(findLeaks(cap.artifacts, needlesFor(recorded))).toEqual([]);
    // Independent of the registry: no secret-shaped value anywhere a secret is not allowed.
    expect(findSecretShapes(cap.artifacts)).toEqual([]);
  }, 120_000);

  it('a seeded leak in any channel is reported (the scan can fail)', () => {
    const secrets = [
      { kind: 'roomCode', value: 'ABCDEF' },
      { kind: 'seatToken', value: 'T'.repeat(43) },
    ] as const;
    const needles = needlesFor(secrets);
    const planted: Artifact[] = [
      { channel: 'log', where: 'log', text: '{"event":"x","code":"ABCDEF"}' },
      { channel: 'stdout', where: 'stdout', text: `{"tok":"${'T'.repeat(43)}"}` },
      { channel: 'span', where: 'span', text: '{"catan.room":"ABCDEF"}' },
      { channel: 'metric', where: 'metric', text: '{"labels":{"x":"ABCDEF"}}' },
      { channel: 'http', where: 'GET /healthz 200', text: 'see https://h/#join=ABCDEF' },
      // A token in a frame to a socket that did not join with it, and the issuing frame itself (allowed).
      { channel: 'frame', where: 'frame → other seat', text: `{"t":"seatToken","seatToken":"${'T'.repeat(43)}"}` },
      { channel: 'frame', where: 'frame → owner', text: `{"t":"seatToken","seatToken":"${'T'.repeat(43)}"}`, allowed: ['T'.repeat(43)] },
    ];
    const leaks = findLeaks(planted, needles);
    expect(new Set(leaks.map((l) => l.channel))).toEqual(new Set(['log', 'stdout', 'span', 'metric', 'http', 'frame']));
    expect(leaks.filter((l) => l.where === 'frame → owner')).toEqual([]);
    expect(JSON.stringify(leaks)).not.toContain('ABCDEF');
  });
});

/** `length` pseudo-random base64url characters from a fixed seed (a high-entropy, secret-shaped string). */
function fabricate(length: number, seed: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let x = seed;
  let out = '';
  for (let i = 0; i < length; i++) {
    x = (x * 48271) % 2147483647;
    out += alphabet[x % 64];
  }
  return out;
}

describe('AC30 shape scan (G4 shapes + entropy)', () => {
  it('flags secret shapes the registry does not know: a token-shaped run, a secret key, a fragment, a high-entropy key', () => {
    // Fabricated at run time, so no secret-shaped literal sits in the source (gitleaks scans it).
    const unknownToken = fabricate(43, 7);
    const apiKey = `k_${fabricate(30, 11)}`;
    expect(entropy(apiKey)).toBeGreaterThan(ENTROPY_THRESHOLD);
    const planted: Artifact[] = [
      { channel: 'log', where: 'log', text: `{"event":"x","t":"${unknownToken}"}` },
      { channel: 'span', where: 'span', text: '{"roomCode":"ZZZZZZ"}' },
      { channel: 'http', where: 'http', text: 'location: /#seat=abc' },
      { channel: 'stdout', where: 'stdout', text: `{"k":"${apiKey}"}` },
      // Allowed: a redacted key, the owner's own token, hashes and UUIDs.
      { channel: 'frame', where: 'owner', text: `{"t":"seatToken","seatToken":"${unknownToken}"}`, allowed: [unknownToken] },
      { channel: 'log', where: 'clean', text: `{"seatToken":"[Redacted]","state_hash":"${'ab12'.repeat(16)}","action_id":"00000000-0000-4000-a000-000000000001"}` },
    ];
    const found = findSecretShapes(planted);
    expect(found.map((l) => `${l.where}:${l.needle}`).sort()).toEqual(
      ['http:shape:fragment:seat', 'log:shape:high-entropy', 'log:shape:seat-token', 'span:shape:key:roomCode', 'stdout:shape:high-entropy'].sort(),
    );
    expect(JSON.stringify(found)).not.toContain(unknownToken);
  });
});
