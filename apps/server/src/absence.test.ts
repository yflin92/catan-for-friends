// Absent players, server side (design §5.10, ADR-0014; AC28): waitingOn / skippable, control skipAbsent, the turn_timer
// policy, and the drain stop. FakeClock drives every threshold. Games start from an injected preRoll state (setup
// phases are never skippable).
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AbsencePolicy, GameState } from '@hexlands/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { startServer, type RunningServer } from './server';
import { openGameStore, type SqliteGameStore } from './store/sqlite';
import { FakeClock } from './testing';

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
let n = 0;
const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const settle = () => new Promise((r) => setTimeout(r, 40));
type Msg = Record<string, unknown>;

class Client {
  readonly frames: Msg[] = [];
  closeCode: number | null = null;
  private waiters = new Map<string, (m: Msg) => void>();
  private constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as Msg;
      this.frames.push(m);
      if (m['t'] === 'outcome') this.waiters.get(String(m['actionId']))?.(m);
      // Answer heartbeats so FakeClock advances never time a socket out.
      if (m['t'] === 'ping') ws.send(JSON.stringify({ t: 'pong', id: m['id'] }));
    });
    ws.on('close', (c) => (this.closeCode = c));
  }
  static async open(port: number): Promise<Client> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    cleanups.push(() => ws.terminate());
    await new Promise((r, j) => ws.once('open', r).once('error', j));
    return new Client(ws);
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
  /** The seat token from the last seatToken frame. */
  token(): string {
    return [...this.frames].reverse().find((f) => f['t'] === 'seatToken')!['seatToken'] as string;
  }
  skip(seat: number) {
    return this.cmd({ t: 'control', op: { kind: 'skipAbsent', seat } });
  }
  lastRoom(): { waitingOn: { seat: number; disconnectedForSec: number | null }[]; skippable: number[] } {
    const r = [...this.frames].reverse().find((f) => f['t'] === 'room') ?? this.frames.find((f) => f['t'] === 'welcome');
    return r!['room'] as never;
  }
  async close(): Promise<void> {
    this.ws.close(1000);
    await new Promise((r) => this.ws.once('close', r));
    await settle();
  }
}

function createRoom(port: number): Promise<{ roomCode: string; seatToken: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/api/rooms', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as { roomCode: string; seatToken: string }));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ displayName: 'Ana' }));
  });
}

interface Table {
  s: RunningServer;
  clock: FakeClock;
  store: SqliteGameStore;
  roomCode: string;
  tokens: string[];
  clients: Client[];
  gameId: string;
}

/** A 3-player game started from preRoll with seat 0 (the host) active, under `policy`. */
async function table(policy: Partial<AbsencePolicy> = {}): Promise<Table> {
  const dir = mkdtempSync(path.join(tmpdir(), 'hexlands-absence-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const clock = new FakeClock(1_000_000);
  const preRoll = (_code: string, created: GameState): GameState => ({ ...created, phase: { name: 'preRoll' }, turn: { ...created.turn, number: 1, active: 0 } });
  const s = await startServer({ port: 0, dbPath: path.join(dir, 'db'), telemetry: 'memory', clock, testHooks: { initialState: preRoll } });
  const store = openGameStore(path.join(dir, 'db'));
  cleanups.push(() => s.close(), () => store.close());
  const { roomCode, seatToken } = await createRoom(s.port);
  const host = await Client.open(s.port);
  await host.hello(roomCode, { seatToken });
  const clients = [host];
  const tokens = [seatToken];
  for (const name of ['Bo', 'Cy']) {
    const c = await Client.open(s.port);
    await c.hello(roomCode);
    await c.cmd({ t: 'lobby', op: { kind: 'join', displayName: name } });
    tokens.push(c.token());
    clients.push(c);
  }
  if (Object.keys(policy).length > 0) {
    expect(await host.cmd({ t: 'lobby', op: { kind: 'setConfig', absencePolicy: policy } })).toMatchObject({ result: 'ok' });
  }
  expect(await host.cmd({ t: 'lobby', op: { kind: 'start' } })).toMatchObject({ result: 'ok' });
  await settle();
  return { s, clock, store, roomCode, tokens, clients, gameId: store.findByRoomCode(roomCode)!.id };
}

/**
 * Advances the FakeClock in 5 s steps, letting sockets answer heartbeats in between (one big jump would fire the 25 s
 * pong deadline before any pong could arrive).
 */
async function advance(clock: FakeClock, ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 5_000) {
    clock.advance(Math.min(5_000, left));
    await settle();
  }
}

const events = (s: RunningServer, name: string) =>
  s.telemetry
    .logs()
    .map((r) => JSON.parse(r.body as string) as Record<string, unknown>)
    .filter((e) => e['event'] === name);

describe('waitingOn and skippable (design §5.10)', () => {
  it('waitingOn lists the eligible seats with disconnectedForSec; a disconnected waited seat becomes skippable at exactly skipAfterSec', async () => {
    const t = await table();
    const [host, bo] = t.clients as [Client, Client];
    expect(bo.lastRoom().waitingOn).toEqual([{ seat: 0, disconnectedForSec: null }]);
    await host.close();
    expect(bo.lastRoom()).toMatchObject({ waitingOn: [{ seat: 0, disconnectedForSec: 0 }], skippable: [] });
    await advance(t.clock, 59_999);
    expect(bo.lastRoom().skippable).toEqual([]);
    await advance(t.clock, 1);
    expect(bo.lastRoom()).toMatchObject({ waitingOn: [{ seat: 0, disconnectedForSec: 60 }], skippable: [0] });
    // The seat comes back: no longer skippable.
    const again = await Client.open(t.s.port);
    await again.hello(t.roomCode, { seatToken: t.tokens[0] });
    await settle();
    expect(bo.lastRoom()).toMatchObject({ waitingOn: [{ seat: 0, disconnectedForSec: null }], skippable: [] });
  });

  it('pause never offers a skip; turn_timer offers none either (its timer skips)', async () => {
    for (const mode of ['pause', 'turn_timer'] as const) {
      const t = await table(mode === 'pause' ? { mode } : { mode, turnTimerSec: 600 });
      const [host, bo] = t.clients as [Client, Client];
      await host.close();
      await advance(t.clock, 120_000);
      // No threshold to cross, so no new room: the client counts disconnectedForSec up from the last one.
      expect(bo.lastRoom()).toMatchObject({ waitingOn: [{ seat: 0, disconnectedForSec: 0 }], skippable: [] });
      expect(await bo.skip(0)).toMatchObject({ result: 'rule', reasonCode: 'skip_not_allowed' });
    }
  });
});

describe('control skipAbsent (design §5.10)', () => {
  it('before the threshold → skip_not_allowed; a connected non-host while the host is connected → not_host', async () => {
    const t = await table();
    const [host, bo, cy] = t.clients as [Client, Client, Client];
    await bo.close();
    expect(await host.skip(1)).toMatchObject({ result: 'rule', reasonCode: 'skip_not_allowed' });
    expect(await cy.skip(0)).toMatchObject({ result: 'auth', reasonCode: 'not_host' });
    expect(t.s.stateHash(t.roomCode)?.seq).toBe(0);
  });

  it('the host disconnected past the threshold: any connected seated player skips it; seq+1, seat.skipped, room updated', async () => {
    const t = await table();
    const [host, bo, cy] = t.clients as [Client, Client, Client];
    await host.close();
    await advance(t.clock, 60_000);
    const out = await bo.skip(0);
    expect(out).toMatchObject({ result: 'ok', seq: 1 });
    await settle();
    expect(t.s.stateHash(t.roomCode)?.seq).toBe(1);
    expect(events(t.s, 'seat.skipped')).toEqual([
      expect.objectContaining({ game_id: t.gameId, seat: 0, reason: 'host', was_active: true, resolved: expect.arrayContaining(['roll']) }),
    ]);
    // The turn moved on to seat 1, who is connected: nothing is skippable, and every client got the new room.
    expect(cy.lastRoom()).toMatchObject({ waitingOn: [{ seat: 1, disconnectedForSec: null }], skippable: [] });
    expect(await bo.skip(0)).toMatchObject({ result: 'rule', reasonCode: 'skip_not_allowed' });
  });

  it('D23: a skipAbsent control is ONE catan.action span (skipAbsent, control, the committed seq); no skipSeat span of its own', async () => {
    const t = await table();
    const [host, bo] = t.clients as [Client, Client];
    await host.close();
    await advance(t.clock, 60_000);
    const before = t.s.telemetry.spans().length;
    expect(await bo.skip(0)).toMatchObject({ result: 'ok', seq: 1 });
    const spans = t.s.telemetry.spans().slice(before);
    expect(spans.map((sp) => [sp.name, sp.attributes['catan.action.type']])).toEqual([['catan.action', 'skipAbsent']]);
    expect(spans[0]!.attributes).toMatchObject({ 'catan.action.group': 'control', 'catan.result': 'ok', 'catan.seq': 1 });
    expect(spans[0]!.parentSpanContext).toBeUndefined();
    const dump = JSON.stringify(spans[0]!.attributes);
    for (const secret of [t.roomCode, ...t.tokens]) expect(dump).not.toContain(secret);
  });

  it('skipBy host_only: a non-host is refused even while the host is away', async () => {
    const t = await table({ skipBy: 'host_only' });
    const [host, bo] = t.clients as [Client, Client];
    await host.close();
    await advance(t.clock, 60_000);
    expect(await bo.skip(0)).toMatchObject({ result: 'auth', reasonCode: 'not_host' });
  });
});

describe('turn_timer (design §5.10)', () => {
  it('skips the waited seat with reason timer after turnTimerSec; a commit re-arms it', async () => {
    const t = await table({ mode: 'turn_timer', turnTimerSec: 30 });
    const [host] = t.clients as [Client];
    await advance(t.clock, 20_000);
    // The active seat acts: the timer re-arms for the next state.
    expect(await host.cmd({ t: 'action', baseSeq: 0, action: { type: 'rollDice' } })).toMatchObject({ result: 'ok', seq: 1 });
    const afterRoll = t.s.stateHash(t.roomCode)!.seq;
    await advance(t.clock, 29_999);
    expect(t.s.stateHash(t.roomCode)!.seq).toBe(afterRoll);
    await advance(t.clock, 1);
    expect(t.s.stateHash(t.roomCode)!.seq).toBeGreaterThan(afterRoll);
    expect(events(t.s, 'seat.skipped')).toContainEqual(expect.objectContaining({ seat: 0, reason: 'timer' }));
    // The timer skip is its own catan.action span: type skipSeat, group system.
    const spans = t.s.telemetry.spans().filter((sp) => sp.attributes['catan.action.type'] === 'skipSeat');
    expect(spans).toHaveLength(1);
    expect(spans[0]!.attributes).toMatchObject({ 'catan.action.group': 'system', 'catan.result': 'ok', 'catan.seq': afterRoll + 1 });
    expect(spans[0]!.parentSpanContext).toBeUndefined();
    // No control span: nobody sent one.
    expect(t.s.telemetry.spans().some((sp) => sp.attributes['catan.action.type'] === 'skipAbsent')).toBe(false);
    const dump = JSON.stringify(spans[0]!.attributes);
    for (const secret of [t.roomCode, ...t.tokens]) expect(dump).not.toContain(secret);
  });

  it('no skip is committed after the drain begins (timers stop at drain step 3)', async () => {
    const t = await table({ mode: 'turn_timer', turnTimerSec: 30 });
    const before = t.s.stateHash(t.roomCode)!.seq;
    const store = t.store;
    await t.s.drain();
    await advance(t.clock, 120_000);
    expect(store.findByRoomCode(t.roomCode)!.headSeq).toBe(before);
    expect(events(t.s, 'seat.skipped')).toEqual([]);
  });
});
