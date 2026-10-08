import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { viewHash } from '@hexlands/engine';
import { writeCredentials } from './fragment';
import { LogStore } from './log-store';
import { Store } from './store';
import { wireViewFixture } from './testing/view-fixture';
import { BACKOFF_MS, TELEMETRY_INTERVAL_MS, WsClient, type PageEnv, type SocketLike } from './ws-client';

const TOKEN = 'tok_abcdefghijklmnopqrstuvwxyz0123456789ABCDEF';
const ROOM = 'ABCDEF';

class FakeSocket implements SocketLike {
  readyState = 0;
  readonly sent: Record<string, unknown>[] = [];
  closedWith: number | undefined;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(code?: number): void {
    this.closedWith = code;
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  recv(msg: unknown): void {
    this.onmessage?.({ data: typeof msg === 'string' ? msg : JSON.stringify(msg) });
  }
  drop(code: number): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  of(t: string): Record<string, unknown>[] {
    return this.sent.filter((m) => m['t'] === t);
  }
}

class FakePage implements PageEnv {
  visible = true;
  online = true;
  private listener: ((e: 'visible' | 'hidden' | 'online' | 'offline') => void) | null = null;
  isVisible = () => this.visible;
  isOnline = () => this.online;
  href = () => `https://hex.example/#seat=${ROOM}.${TOKEN}`;
  subscribe(l: (e: 'visible' | 'hidden' | 'online' | 'offline') => void) {
    this.listener = l;
    return () => {
      this.listener = null;
    };
  }
  emit(e: 'visible' | 'hidden' | 'online' | 'offline') {
    if (e === 'visible') this.visible = true;
    if (e === 'hidden') this.visible = false;
    if (e === 'online') this.online = true;
    if (e === 'offline') this.online = false;
    this.listener?.(e);
  }
}

class MemoryStorage {
  readonly items = new Map<string, string>();
  getItem(k: string) {
    return this.items.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.items.set(k, v);
  }
}

const ROOM_VIEW = {
  lifecycle: 'active',
  hostSeat: 0,
  seats: [
    { seat: 0, name: 'Ann', connected: true },
    { seat: 1, name: 'Bo', connected: true },
    { seat: 2, name: 'Cy', connected: true },
  ],
  config: {
    rules: { vpTarget: 10, discardLimit: 7, boardConstraints: { noAdjacentRedNumbers: true }, friendlyRobber: { enabled: false, maxPublicVp: 2 } },
    absencePolicy: { mode: 'pause', skipAfterSec: 120, turnTimerSec: null, skipBy: 'host_or_any_if_host_absent', seatRelinkEnabled: false },
  },
  waitingOn: [],
  skippable: [],
  buildVersion: 'test-build',
};

function welcome(seq: number, view: unknown = wireViewFixture(), extra: Record<string, unknown> = {}) {
  return { t: 'welcome', v: 1, seat: 1, isHost: false, room: { ...ROOM_VIEW, ...extra }, seq, view };
}

function setup(opts: { random?: number; buildVersion?: string } = {}) {
  const sockets: FakeSocket[] = [];
  const store = new Store();
  const log = new LogStore();
  const storage = new MemoryStorage();
  const page = new FakePage();
  writeCredentials(storage, { roomCode: ROOM, seatToken: TOKEN });
  let id = 0;
  const client = new WsClient({
    url: 'ws://test/ws',
    createSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    store,
    log,
    storage,
    timers: {
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    },
    page,
    random: () => opts.random ?? 0.5,
    uuid: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
    buildVersion: opts.buildVersion ?? 'test-build',
  });
  const last = () => sockets[sockets.length - 1]!;
  /** Opens the newest socket and completes hello → welcome(seq). */
  const handshake = (seq: number, view?: unknown) => {
    const s = last();
    s.open();
    const hello = s.of('hello')[0]!;
    s.recv(welcome(seq, view));
    s.recv({ t: 'outcome', actionId: hello['actionId'], result: 'ok' });
    return s;
  };
  return { client, store, log, storage, page, sockets, last, handshake };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('hello and welcome', () => {
  it('sends hello {v:1, actionId, roomCode, seatToken} and adopts the welcome view exactly as received', () => {
    const t = setup();
    t.client.start(ROOM);
    const s = t.last();
    s.open();
    expect(s.sent).toEqual([{ t: 'hello', v: 1, actionId: expect.any(String), roomCode: ROOM, seatToken: TOKEN }]);
    const view = { ...wireViewFixture(), futureField: { x: 1 } };
    s.recv(welcome(5, view));
    const snap = t.store.getSnapshot();
    expect(snap.seq).toBe(5);
    expect(snap.view).toEqual(view);
    expect((snap.view as unknown as { futureField: unknown }).futureField).toEqual({ x: 1 });
    expect(snap.viewHash).toBe(viewHash(view));
    expect(snap.seat).toBe(1);
    expect(snap.connection).toEqual({ status: 'open', terminal: null });
    expect(t.log.getSnapshot().map((e) => e.n)).toEqual([1, 2]);
  });

  it('sends lastSeq on a reconnect hello', () => {
    const t = setup();
    t.client.start(ROOM);
    t.handshake(7);
    t.last().drop(1006);
    vi.advanceTimersByTime(0);
    t.last().open();
    expect(t.last().of('hello')[0]).toMatchObject({ lastSeq: 7, seatToken: TOKEN });
  });

  it('marks a stale bundle when room.buildVersion differs from this build', () => {
    const t = setup({ buildVersion: 'old-build' });
    t.client.start(ROOM);
    t.handshake(1);
    expect(t.store.getSnapshot().staleBundle).toBe(true);
    const fresh = setup();
    fresh.client.start(ROOM);
    fresh.handshake(1);
    expect(fresh.store.getSnapshot().staleBundle).toBe(false);
  });

  it('never marks a stale bundle when either side is a dev build (D12)', () => {
    const t = setup({ buildVersion: 'dev' });
    t.client.start(ROOM);
    t.handshake(1);
    expect(t.store.getSnapshot().staleBundle).toBe(false);
    t.last().recv({ t: 'room', rev: 2, room: { ...ROOM_VIEW, buildVersion: 'dev' }, yourSeat: 1 });
    expect(t.store.getSnapshot().staleBundle).toBe(false);
  });

  it('takes the seat from each room message (yourSeat), e.g. after a reorder', () => {
    const t = setup();
    t.client.start(ROOM);
    t.handshake(1);
    t.last().recv({ t: 'room', rev: 2, room: { ...ROOM_VIEW, lifecycle: 'lobby' }, yourSeat: 2 });
    expect(t.store.getSnapshot().seat).toBe(2);
    expect(t.store.getSnapshot().room?.lifecycle).toBe('lobby');
    t.last().recv({ t: 'room', rev: 3, room: ROOM_VIEW, yourSeat: null });
    expect(t.store.getSnapshot().seat).toBeNull();
  });

  it('stores a seatToken sent after a lobby join', () => {
    const t = setup();
    t.client.start(ROOM);
    t.handshake(1);
    t.last().recv({ t: 'seatToken', seat: 2, seatToken: 'new_token_abcdefghijklmnopqrstuvwxyz0123456', purpose: 'joined' });
    expect(JSON.parse(t.storage.getItem(`hexlands.seat.${ROOM}`)!)).toEqual({
      roomCode: ROOM,
      seatToken: 'new_token_abcdefghijklmnopqrstuvwxyz0123456',
    });
    expect(t.store.getSnapshot().seat).toBe(2);
  });
});

describe('monotonic rendering (AC21)', () => {
  it('adopts state only when seq > local, acks each applied state, and resyncs on a gap', () => {
    const t = setup();
    t.client.start(ROOM);
    const s = t.handshake(5);
    s.recv({ t: 'state', seq: 4, view: wireViewFixture() });
    s.recv({ t: 'state', seq: 5, view: wireViewFixture([9]) });
    expect(t.store.getSnapshot().seq).toBe(5);
    expect(t.store.getSnapshot().view?.log.map((e) => e.n)).toEqual([1, 2]);
    expect(s.of('ack')).toEqual([]);
    s.recv({ t: 'state', seq: 6, view: wireViewFixture([3]) });
    expect(t.store.getSnapshot().seq).toBe(6);
    expect(s.of('ack')).toEqual([{ t: 'ack', seq: 6 }]);
    expect(s.of('resync')).toEqual([]);
    s.recv({ t: 'state', seq: 9, view: wireViewFixture([4]) });
    expect(t.store.getSnapshot().seq).toBe(9);
    expect(s.of('ack')).toEqual([
      { t: 'ack', seq: 6 },
      { t: 'ack', seq: 9 },
    ]);
    expect(s.of('resync')).toEqual([{ t: 'resync' }]);
    expect(t.log.getSnapshot().map((e) => e.n)).toEqual([1, 2, 3, 4]);
  });

  it('adopts a welcome view when seq ≥ local and keeps the local view when it is older', () => {
    const t = setup();
    t.client.start(ROOM);
    t.handshake(9);
    t.last().drop(1006);
    vi.advanceTimersByTime(0);
    const same = wireViewFixture([7]);
    t.handshake(9, same);
    expect(t.store.getSnapshot().view).toEqual(same);
    t.last().drop(1006);
    vi.advanceTimersByTime(0);
    t.handshake(8, wireViewFixture([8]));
    expect(t.store.getSnapshot().seq).toBe(9);
    expect(t.store.getSnapshot().view).toEqual(same);
  });

  it('rejects envelopes with unknown keys and malformed views without crashing, reporting them', () => {
    const t = setup();
    t.client.start(ROOM);
    const s = t.handshake(1);
    s.recv({ t: 'state', seq: 2, view: wireViewFixture(), extra: 1 });
    s.recv('not json');
    s.recv({ t: 'state', seq: 3, view: { ...wireViewFixture(), hand: 'oops' } });
    expect(t.store.getSnapshot().seq).toBe(1);
    vi.advanceTimersByTime(TELEMETRY_INTERVAL_MS);
    const batch = s.of('telemetry')[0] as { errors: { kind: string }[] };
    expect(batch.errors.map((e) => e.kind)).toEqual(['ws_protocol', 'ws_protocol', 'ws_protocol']);
  });
});

describe('pending actions', () => {
  it('queues until welcome, then resends unanswered actions with their original ids, in order, after a reconnect', async () => {
    const t = setup();
    t.client.start(ROOM);
    const a = t.client.sendLobby({ kind: 'shuffleSeats' });
    expect(t.store.getSnapshot().pending.size).toBe(1);
    const s1 = t.handshake(1);
    const b = t.client.sendLobby({ kind: 'start' });
    const sent1 = s1.of('lobby').map((m) => m['actionId']);
    expect(sent1).toHaveLength(2);
    s1.drop(1006);
    vi.advanceTimersByTime(0);
    const s2 = t.handshake(1);
    expect(s2.of('lobby').map((m) => m['actionId'])).toEqual(sent1);
    expect(s2.of('lobby').map((m) => (m['op'] as { kind: string }).kind)).toEqual(['shuffleSeats', 'start']);
    s2.recv({ t: 'outcome', actionId: sent1[1], result: 'rule', reasonCode: 'not_enough_players' });
    s2.recv({ t: 'outcome', actionId: sent1[0], result: 'ok', seq: 2 });
    await expect(b).resolves.toMatchObject({ result: 'rule', reasonCode: 'not_enough_players' });
    await expect(a).resolves.toMatchObject({ result: 'ok' });
    expect(t.store.getSnapshot().pending.size).toBe(0);
  });

  it('samples action RTT only for outcomes on the connection the action was sent on, never for resends', () => {
    const t = setup();
    t.client.start(ROOM);
    const s1 = t.handshake(1);
    void t.client.sendAction({ type: 'endTurn' } as never);
    void t.client.sendAction({ type: 'rollDice' } as never);
    const [first, second] = s1.of('action').map((m) => m['actionId']);
    vi.advanceTimersByTime(120);
    s1.recv({ t: 'outcome', actionId: first, result: 'ok', seq: 2 });
    s1.drop(1006);
    vi.advanceTimersByTime(0);
    const s2 = t.handshake(2);
    vi.advanceTimersByTime(50);
    s2.recv({ t: 'outcome', actionId: second, result: 'ok', seq: 3 });
    vi.advanceTimersByTime(TELEMETRY_INTERVAL_MS);
    const rtts = [...s1.of('telemetry'), ...s2.of('telemetry')].flatMap((b) => (b['actionRttMs'] as number[] | undefined) ?? []);
    expect(rtts).toEqual([120]);
  });
});

describe('reconnect and close codes', () => {
  it('backs off 0, 250, 500, 1000, 2000, 4000, 4000 ms and resets after a welcome', () => {
    const t = setup();
    t.client.start(ROOM);
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      const before = t.sockets.length;
      t.last().drop(1006);
      let waited = 0;
      while (t.sockets.length === before) {
        vi.advanceTimersByTime(1);
        waited += 1;
      }
      delays.push(waited);
    }
    expect(delays).toEqual([1, 250, 500, 1000, 2000, 4000, 4000]);
    t.handshake(1);
    t.last().drop(1006);
    vi.advanceTimersByTime(0);
    expect(t.sockets).toHaveLength(9);
    expect(BACKOFF_MS).toEqual([0, 250, 500, 1000, 2000, 4000]);
  });

  it('applies ±20 % jitter', () => {
    for (const [random, expected] of [
      [0, 200],
      [1, 300],
    ] as const) {
      const t = setup({ random });
      t.client.start(ROOM);
      t.last().drop(1006);
      vi.advanceTimersByTime(0);
      t.last().drop(1006);
      vi.advanceTimersByTime(expected - 1);
      expect(t.sockets).toHaveLength(2);
      vi.advanceTimersByTime(1);
      expect(t.sockets).toHaveLength(3);
    }
  });

  it.each([
    [4001, 'superseded'],
    [4401, 'auth_failed'],
    [4410, 'game_gone'],
  ] as const)('close %i is terminal (%s): no auto-reconnect', (code, terminal) => {
    const t = setup();
    t.client.start(ROOM);
    t.handshake(1);
    t.last().drop(code);
    vi.advanceTimersByTime(60_000);
    t.page.emit('online');
    t.page.emit('visible');
    expect(t.sockets).toHaveLength(1);
    expect(t.store.getSnapshot().connection).toEqual({ status: 'stopped', terminal });
  });

  it('"Use here" after 4001 reconnects and supersedes the other device', () => {
    const t = setup();
    t.client.start(ROOM);
    t.handshake(3);
    t.last().recv({ t: 'superseded' });
    t.last().drop(4001);
    t.client.useHere();
    expect(t.sockets).toHaveLength(2);
    t.last().open();
    expect(t.last().of('hello')[0]).toMatchObject({ seatToken: TOKEN, lastSeq: 3 });
  });

  it.each([1006, 1008, 1012, 4408])('close %i reconnects', (code) => {
    const t = setup();
    t.client.start(ROOM);
    t.handshake(1);
    t.last().drop(code);
    vi.advanceTimersByTime(0);
    expect(t.sockets).toHaveLength(2);
    expect(t.store.getSnapshot().connection.status).toBe('reconnecting');
  });

  it('reconnects immediately on online and on visible instead of waiting for the backoff', () => {
    const t = setup();
    t.client.start(ROOM);
    for (let i = 0; i < 5; i++) {
      t.last().drop(1006);
      vi.advanceTimersByTime(4000);
    }
    t.last().drop(1006);
    expect(t.sockets).toHaveLength(6);
    t.page.emit('online');
    expect(t.sockets).toHaveLength(7);
    t.last().drop(1006);
    t.page.emit('visible');
    expect(t.sockets).toHaveLength(8);
  });

  it('stop() closes with 1000 and never reconnects', () => {
    const t = setup();
    t.client.start(ROOM);
    const s = t.handshake(1);
    t.client.stop();
    expect(s.closedWith).toBe(1000);
    vi.advanceTimersByTime(60_000);
    expect(t.sockets).toHaveLength(1);
  });
});

describe('hello rejected without a close (bug 13dc7dd14e75e851d52e5c20)', () => {
  function helloRejected(reasonCode: string, result: 'auth' | 'rule' | 'error') {
    const t = setup();
    t.client.start(ROOM);
    const s = t.last();
    s.open();
    s.recv({ t: 'outcome', actionId: s.of('hello')[0]!['actionId'], result, reasonCode });
    return { ...t, s };
  }

  it.each([
    ['bad_seat_token', 'auth', 'auth_failed'],
    ['seat_token_revoked', 'auth', 'auth_failed'],
    ['game_expired', 'rule', 'game_gone'],
  ] as const)('terminal: %s stops with a message and never reconnects', (code, result, terminal) => {
    const t = helloRejected(code, result);
    expect(t.s.closedWith).toBe(1000);
    expect(t.store.getSnapshot().connection).toEqual({ status: 'stopped', terminal });
    vi.advanceTimersByTime(60_000);
    t.page.emit('online');
    t.page.emit('visible');
    expect(t.sockets).toHaveLength(1);
  });

  it.each([
    ['rate_limited', 'error'],
    ['rate_limited_auth', 'auth'],
    ['server_draining', 'error'],
  ] as const)('retryable: %s shows "reconnecting" and retries with backoff', (code, result) => {
    const t = helloRejected(code, result);
    expect(t.s.closedWith).toBe(1000);
    expect(t.store.getSnapshot().connection).toEqual({ status: 'reconnecting', terminal: null });
    vi.advanceTimersByTime(0);
    expect(t.sockets).toHaveLength(2);
  });

  it('other codes stop with a generic error that the user can retry', () => {
    const t = helloRejected('internal_error', 'error');
    expect(t.store.getSnapshot().connection).toEqual({ status: 'stopped', terminal: 'connect_failed' });
    vi.advanceTimersByTime(60_000);
    expect(t.sockets).toHaveLength(1);
    t.client.useHere();
    expect(t.sockets).toHaveLength(2);
  });
});

describe('signals and telemetry', () => {
  it('answers ping with pong and reports visibility, resyncing on visible', () => {
    const t = setup();
    t.client.start(ROOM);
    const s = t.handshake(1);
    s.recv({ t: 'ping', id: 42 });
    t.page.emit('hidden');
    t.page.emit('visible');
    expect(s.sent.filter((m) => m['t'] !== 'hello')).toEqual([
      { t: 'pong', id: 42 },
      { t: 'visibility', state: 'hidden' },
      { t: 'visibility', state: 'visible' },
      { t: 'resync' },
    ]);
  });

  it('sends no signals before the welcome', () => {
    const t = setup();
    t.client.start(ROOM);
    const s = t.last();
    s.open();
    t.page.emit('hidden');
    s.recv({ t: 'ping', id: 1 });
    expect(s.sent.map((m) => m['t'])).toEqual(['hello']);
  });

  it.each([
    [1012, 'server_restart'],
    [1006, 'network'],
    [4408, 'network'],
  ] as const)('tags the resume gap after close %i as %s, counting only visible and online time', (code, cause) => {
    const t = setup();
    t.client.start(ROOM);
    t.handshake(1);
    t.last().drop(code);
    vi.advanceTimersByTime(0);
    vi.advanceTimersByTime(300);
    t.page.emit('hidden');
    vi.advanceTimersByTime(10_000);
    t.page.emit('visible');
    vi.advanceTimersByTime(200);
    t.handshake(1);
    const batch = t.last().of('telemetry')[0] as { resumeGaps: { ms: number; cause: string }[] };
    expect(batch.resumeGaps).toEqual([{ ms: 500, cause }]);
  });

  it('keeps the cause of the socket that was lost across failed reconnect attempts', () => {
    const t = setup();
    t.client.start(ROOM);
    t.handshake(1);
    t.last().drop(1012);
    vi.advanceTimersByTime(0);
    t.last().drop(1006);
    vi.advanceTimersByTime(250);
    t.handshake(1);
    const batch = t.last().of('telemetry')[0] as { resumeGaps: { cause: string }[] };
    expect(batch.resumeGaps.map((g) => g.cause)).toEqual(['server_restart']);
  });

  it('sends ≤ 100 samples per array per batch and at most one batch per 5 s per socket', () => {
    const t = setup();
    t.client.start(ROOM);
    const s = t.handshake(1);
    for (let i = 0; i < 150; i++) t.client.reportError('other', `e${i}`);
    vi.advanceTimersByTime(TELEMETRY_INTERVAL_MS);
    const first = s.of('telemetry');
    expect(first).toHaveLength(1);
    expect((first[0]!['errors'] as unknown[]).length).toBe(100);
    vi.advanceTimersByTime(TELEMETRY_INTERVAL_MS);
    const both = s.of('telemetry');
    expect(both).toHaveLength(2);
    expect((both[1]!['errors'] as unknown[]).length).toBe(50);
  });

  it('defers a reconnect batch that would come within 5 s of the previous one on the same socket', () => {
    const t = setup();
    t.client.start(ROOM);
    const s = t.handshake(1);
    t.client.reportError('other', 'a');
    vi.advanceTimersByTime(TELEMETRY_INTERVAL_MS);
    expect(s.of('telemetry')).toHaveLength(1);
    t.client.reportError('other', 'b');
    t.page.emit('hidden');
    t.page.emit('visible');
    vi.advanceTimersByTime(TELEMETRY_INTERVAL_MS - 1);
    expect(s.of('telemetry')).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(s.of('telemetry')).toHaveLength(2);
  });

  it('sanitises error messages: no URL, fragment, query or token-shaped strings', () => {
    const t = setup();
    t.client.start(ROOM);
    const s = t.handshake(1);
    t.client.reportError('js_error', `boom at https://hex.example/#seat=${ROOM}.${TOKEN} and #join=${ROOM} token ${TOKEN}`);
    vi.advanceTimersByTime(TELEMETRY_INTERVAL_MS);
    const msg = JSON.stringify(s.of('telemetry'));
    expect(msg).not.toContain(TOKEN);
    expect(msg).not.toContain('#seat=');
    expect(msg).not.toContain('#join=');
    expect(msg).not.toContain('hex.example');
  });
});
