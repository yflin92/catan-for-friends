import type { PlayerView, PlayerViewData } from '@hexlands/engine';
import fc from 'fast-check';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  CloseCode,
  HTTP_REASON_CODES,
  MAX_INBOUND_FRAME_BYTES,
  PROTOCOL_VERSION,
  ReasonCode,
  SIGNAL_TYPES,
  TELEMETRY_ACTION_RTT_MS_MAX,
  TELEMETRY_MAX_SAMPLES_PER_ARRAY,
  TELEMETRY_MIN_BATCH_INTERVAL_MS,
  TELEMETRY_RESUME_GAP_MS_MAX,
  ackSchema,
  actionMsgSchema,
  actionSchema,
  clientMsgSchema,
  controlMsgSchema,
  helloSchema,
  lobbyMsgSchema,
  pongSchema,
  resyncSchema,
  serverMsgSchema,
  telemetrySchema,
  visibilitySchema,
  type ClientMsg,
  type HttpReasonCode,
  type ServerMsg,
  type ServerMsgWire,
} from './index';
import { VIEW_FIXTURE } from './fixtures/view';

const ID = '3b241101-e2bb-4255-8caf-4136c566a962';
const ok = (s: { safeParse(v: unknown): { success: boolean } }, v: unknown) => expect(s.safeParse(v).success).toBe(true);
const bad = (s: { safeParse(v: unknown): { success: boolean } }, v: unknown) => expect(s.safeParse(v).success).toBe(false);
const rc = { brick: 1, lumber: 0, wool: 0, grain: 0, ore: 0 };

const VALID_ACTIONS = [
  { type: 'placeSettlement', vertex: 'v:0,-2,N' },
  { type: 'placeRoad', edge: 'e:0,-2,NW' },
  { type: 'buildCity', vertex: 'v:1,-1,S' },
  { type: 'rollDice' },
  { type: 'discard', cards: rc },
  { type: 'moveRobber', hex: 'h:0,0', victim: 2 },
  { type: 'moveRobber', hex: 'h:-1,2', victim: null },
  { type: 'buyDevCard' },
  { type: 'playKnight' },
  { type: 'playRoadBuilding' },
  { type: 'playYearOfPlenty', take: ['ore', 'ore'] },
  { type: 'playMonopoly', resource: 'grain' },
  { type: 'maritimeTrade', give: 'wool', receive: 'ore', count: 1 },
  { type: 'proposeTrade', give: rc, get: { ...rc, brick: 0, ore: 1 } },
  { type: 'respondTrade', tradeId: 3, accept: true },
  { type: 'confirmTrade', tradeId: 3, partner: 0 },
  { type: 'cancelTrade', tradeId: 3 },
  { type: 'endTurn' },
] as const;

const VALID_CLIENT_MSGS: readonly ClientMsg[] = [
  { t: 'hello', v: 1, actionId: ID, roomCode: 'ABCDEF' },
  { t: 'hello', v: 1, actionId: ID, roomCode: 'ABCDEF', seatToken: 'x'.repeat(43), lastSeq: 17 },
  { t: 'action', actionId: ID, baseSeq: 4, action: { type: 'rollDice' } },
  { t: 'lobby', actionId: ID, op: { kind: 'join', displayName: 'Ana' } },
  { t: 'lobby', actionId: ID, op: { kind: 'rename', displayName: 'Bo' } },
  { t: 'lobby', actionId: ID, op: { kind: 'reorderSeats', order: [2, 0, 1] } },
  { t: 'lobby', actionId: ID, op: { kind: 'shuffleSeats' } },
  { t: 'lobby', actionId: ID, op: { kind: 'removeSeat', seat: 3 } },
  { t: 'lobby', actionId: ID, op: { kind: 'setConfig', rules: { vpTarget: 12 }, absencePolicy: { mode: 'turn_timer', turnTimerSec: 90 } } },
  { t: 'lobby', actionId: ID, op: { kind: 'setConfig' } },
  { t: 'lobby', actionId: ID, op: { kind: 'start' } },
  { t: 'control', actionId: ID, op: { kind: 'skipAbsent', seat: 1 } },
  { t: 'control', actionId: ID, op: { kind: 'resume' } },
  { t: 'control', actionId: ID, op: { kind: 'relinkSeat', seat: 2 } },
  { t: 'resync' },
  { t: 'ack', seq: 12 },
  { t: 'pong', id: 7 },
  { t: 'visibility', state: 'hidden' },
  { t: 'telemetry' },
  {
    t: 'telemetry',
    resumeGaps: [{ ms: 1200, cause: 'network' }, { ms: 300, cause: 'server_restart' }],
    actionRttMs: [12, 40],
    errors: [{ kind: 'render', message: 'oops' }],
  },
];

describe('client message schemas (TH17, V21)', () => {
  it('exports every schema individually and accepts each through the union', () => {
    for (const s of [helloSchema, actionMsgSchema, lobbyMsgSchema, controlMsgSchema, resyncSchema, ackSchema, pongSchema, visibilitySchema, telemetrySchema]) {
      expect(typeof s.safeParse).toBe('function');
    }
    for (const m of VALID_CLIENT_MSGS) ok(clientMsgSchema, m);
  });

  it('parses without adding, dropping or coercing anything', () => {
    for (const m of VALID_CLIENT_MSGS) expect(clientMsgSchema.parse(JSON.parse(JSON.stringify(m)))).toStrictEqual(m);
  });

  it('accepts every action type', () => {
    for (const a of VALID_ACTIONS) ok(actionSchema, a);
  });

  it.each([
    ['unknown t', { t: 'shout', actionId: ID }],
    ['missing actionId on action', { t: 'action', baseSeq: 1, action: { type: 'rollDice' } }],
    ['missing actionId on hello', { t: 'hello', v: 1, roomCode: 'ABCDEF' }],
    ['non-UUID actionId', { t: 'action', actionId: 'abc', baseSeq: 1, action: { type: 'rollDice' } }],
    ['wrong protocol version', { t: 'hello', v: 2, actionId: ID, roomCode: 'ABCDEF' }],
    ['extra envelope key', { t: 'ack', seq: 1, extra: true }],
    ['wrong field type', { t: 'ack', seq: '1' }],
    ['unknown action type', { t: 'action', actionId: ID, baseSeq: 1, action: { type: 'teleport' } }],
    ['malformed vertex id', { t: 'action', actionId: ID, baseSeq: 1, action: { type: 'placeSettlement', vertex: 'v:0,0,E' } }],
    ['hex id as edge', { t: 'action', actionId: ID, baseSeq: 1, action: { type: 'placeRoad', edge: 'h:0,0' } }],
    ['seat out of range', { t: 'control', actionId: ID, op: { kind: 'skipAbsent', seat: 4 } }],
    ['resource counts missing a key', { t: 'action', actionId: ID, baseSeq: 1, action: { type: 'discard', cards: { brick: 1 } } }],
    ['yearOfPlenty with one pick', { t: 'action', actionId: ID, baseSeq: 1, action: { type: 'playYearOfPlenty', take: ['ore'] } }],
    ['unknown lobby op', { t: 'lobby', actionId: ID, op: { kind: 'kick' } }],
    ['unknown setConfig rule', { t: 'lobby', actionId: ID, op: { kind: 'setConfig', rules: { turbo: true } } }],
    ['explicit undefined-like null for optional', { t: 'hello', v: 1, actionId: ID, roomCode: 'A', seatToken: null }],
    ['oversized room code', { t: 'hello', v: 1, actionId: ID, roomCode: 'A'.repeat(65) }],
    ['oversized seat token', { t: 'hello', v: 1, actionId: ID, roomCode: 'A', seatToken: 'x'.repeat(257) }],
    ['visibility value', { t: 'visibility', state: 'gone' }],
    ['resume gap without cause', { t: 'telemetry', resumeGaps: [{ ms: 10 }] }],
    ['resume gap with unknown cause', { t: 'telemetry', resumeGaps: [{ ms: 10, cause: 'wifi' }] }],
    ['non-numeric resume gap', { t: 'telemetry', resumeGaps: [{ ms: '10', cause: 'network' }] }],
    ['legacy resumeGapMs', { t: 'telemetry', resumeGapMs: [10] }],
    ['too many rtt samples', { t: 'telemetry', actionRttMs: new Array(101).fill(1) }],
    ['too many resume gaps', { t: 'telemetry', resumeGaps: new Array(101).fill({ ms: 1, cause: 'network' }) }],
    ['too many errors', { t: 'telemetry', errors: new Array(101).fill({ kind: 'other', message: '' }) }],
    ['unknown error kind', { t: 'telemetry', errors: [{ kind: 'crash', message: '' }] }],
    ['not an object', 'hello'],
    ['null', null],
  ])('rejects %s', (_name, msg) => {
    bad(clientMsgSchema, msg);
  });

  it('accepts exactly 100 samples per telemetry array', () => {
    ok(telemetrySchema, { t: 'telemetry', actionRttMs: new Array(100).fill(TELEMETRY_ACTION_RTT_MS_MAX + 1) });
  });

  it('leaves rule-level values to the engine (counts, off-board ids, names, lastSeq)', () => {
    ok(actionSchema, { type: 'maritimeTrade', give: 'wool', receive: 'wool', count: 1.5 });
    ok(actionSchema, { type: 'discard', cards: { brick: -1, lumber: 0, wool: 0, grain: 0, ore: 0 } });
    ok(actionSchema, { type: 'placeSettlement', vertex: 'v:9,9,N' });
    ok(lobbyMsgSchema, { t: 'lobby', actionId: ID, op: { kind: 'join', displayName: '' } });
    ok(helloSchema, { t: 'hello', v: 1, actionId: ID, roomCode: 'zz', lastSeq: -5 });
  });

  it('never throws on arbitrary JSON (V21 fuzz)', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        expect(() => clientMsgSchema.safeParse(v)).not.toThrow();
      }),
      { numRuns: 2000 },
    );
    fc.assert(
      fc.property(fc.constantFrom(...VALID_CLIENT_MSGS), fc.string(), fc.jsonValue(), (m, key, value) => {
        const mutated = { ...m, [key]: value } as Record<string, unknown>;
        const r = clientMsgSchema.safeParse(mutated);
        if (r.success) expect(r.data).toStrictEqual(mutated);
      }),
      { numRuns: 2000 },
    );
  });

  it('lists the signals', () => {
    expect([...SIGNAL_TYPES].sort()).toEqual(['ack', 'pong', 'resync', 'telemetry', 'visibility']);
  });
});

describe('server message schema (PlayerViewWire)', () => {
  const room = {
    lifecycle: 'active',
    hostSeat: 0,
    seats: [{ seat: 0, name: 'Ana', connected: true }, { seat: 1, name: null, connected: false }],
    config: {
      rules: VIEW_FIXTURE.config,
      absencePolicy: { mode: 'pause_host_skip', skipAfterSec: 60, turnTimerSec: null, skipBy: 'host_or_any_if_host_absent', seatRelinkEnabled: true },
    },
    waitingOn: [{ seat: 1, disconnectedForSec: 42 }],
    skippable: [],
    buildVersion: 'abc123',
  } as const;

  const VALID_SERVER_MSGS: readonly ServerMsgWire[] = [
    { t: 'welcome', v: 1, seat: 1, isHost: false, room, seq: 9, view: VIEW_FIXTURE },
    { t: 'welcome', v: 1, seat: null, isHost: false, room, seq: 0, view: null },
    { t: 'seatToken', seat: 2, seatToken: 'x'.repeat(43), purpose: 'joined' },
    { t: 'state', seq: 9, view: VIEW_FIXTURE },
    { t: 'room', rev: 3, room },
    { t: 'outcome', actionId: ID, result: 'ok', seq: 9 },
    { t: 'outcome', actionId: null, result: 'rule', reasonCode: 'malformed_action' },
    { t: 'superseded' },
    { t: 'ping', id: 1 },
  ];

  it('accepts every server message type', () => {
    for (const m of VALID_SERVER_MSGS) ok(serverMsgSchema, m);
  });

  // TODO(#6 W1-E3): compare engine viewHash(parsed) with viewHash(original) once #6 merges; key-exact deep equality
  // of the parsed view already implies equal hashes of any canonical serialisation.
  it('round-trips a view exactly: nothing added, dropped, defaulted or coerced (D5)', () => {
    const parsed = serverMsgSchema.parse(JSON.parse(JSON.stringify({ t: 'state', seq: 9, view: VIEW_FIXTURE })));
    if (parsed.t !== 'state') throw new Error('expected state');
    expect(parsed.view).toStrictEqual(VIEW_FIXTURE);
    expect(canonicalJson(parsed.view)).toBe(canonicalJson(VIEW_FIXTURE));
    const devPlayed = parsed.view.log.find((e) => e.n === 11)?.event;
    expect(devPlayed && 'picks' in devPlayed).toBe(false);
  });

  it('keeps unknown keys under view rather than stripping or rejecting them (D5 passthrough)', () => {
    const view = { ...VIEW_FIXTURE, extraTop: 1, players: VIEW_FIXTURE.players.map((p) => ({ ...p, extra: [1] })) };
    const parsed = serverMsgSchema.parse({ t: 'state', seq: 1, view });
    expect(parsed.t === 'state' && parsed.view).toStrictEqual(view);
  });

  it.each([
    ['unknown t', { t: 'hint' }],
    ['extra envelope key', { t: 'ping', id: 1, extra: 1 }],
    ['unknown outcome result', { t: 'outcome', actionId: null, result: 'maybe' }],
    ['unknown reason code', { t: 'outcome', actionId: null, result: 'auth', reasonCode: 'bad_passphrase' }],
    ['view missing a field', { t: 'state', seq: 1, view: { ...VIEW_FIXTURE, legal: undefined } }],
    ['view field of the wrong type', { t: 'state', seq: 1, view: { ...VIEW_FIXTURE, robber: 7 } }],
    ['extra key on the state envelope', { t: 'state', seq: 1, view: VIEW_FIXTURE, extra: 1 }],
  ])('rejects %s', (_name, msg) => {
    bad(serverMsgSchema, msg);
  });
});

describe('enums, constants and wire types', () => {
  it('HTTP_REASON_CODES is exactly the HttpReasonCode union, and bad_passphrase is not a ReasonCode', () => {
    const all: Record<HttpReasonCode, true> = {
      capacity_reached: true,
      rate_limited_auth: true,
      invalid_name: true,
      malformed_action: true,
      bad_passphrase: true,
    };
    expect([...HTTP_REASON_CODES].sort()).toEqual(Object.keys(all).sort());
    expect(Object.keys(ReasonCode)).toHaveLength(44);
    expect(Object.keys(ReasonCode)).not.toContain('bad_passphrase');
    for (const c of HTTP_REASON_CODES.filter((c) => c !== 'bad_passphrase')) expect(Object.keys(ReasonCode)).toContain(c);
  });

  it('exposes the close codes and limits of §3.11', () => {
    expect(CloseCode).toEqual({
      NORMAL: 1000,
      GOING_AWAY: 1001,
      POLICY: 1008,
      TOO_BIG: 1009,
      SERVICE_RESTART: 1012,
      SUPERSEDED: 4001,
      AUTH_FAILED: 4401,
      HEARTBEAT: 4408,
      GAME_GONE: 4410,
    });
    expect(PROTOCOL_VERSION).toBe(1);
    expect(MAX_INBOUND_FRAME_BYTES).toBe(16_384);
    expect([TELEMETRY_MAX_SAMPLES_PER_ARRAY, TELEMETRY_ACTION_RTT_MS_MAX, TELEMETRY_RESUME_GAP_MS_MAX, TELEMETRY_MIN_BATCH_INTERVAL_MS]).toEqual([
      100, 60_000, 600_000, 5_000,
    ]);
  });

  it('types: ServerMsg carries the branded PlayerView, ServerMsgWire the unbranded data', () => {
    type State = Extract<ServerMsg, { t: 'state' }>;
    type StateWire = Extract<ServerMsgWire, { t: 'state' }>;
    type Welcome = Extract<ServerMsg, { t: 'welcome' }>;
    type WelcomeWire = Extract<ServerMsgWire, { t: 'welcome' }>;
    expectTypeOf<State['view']>().toEqualTypeOf<PlayerView>();
    expectTypeOf<StateWire['view']>().toEqualTypeOf<PlayerViewData>();
    expectTypeOf<Welcome['view']>().toEqualTypeOf<PlayerView | null>();
    expectTypeOf<WelcomeWire['view']>().toEqualTypeOf<PlayerViewData | null>();
    expectTypeOf<PlayerViewData>().not.toExtend<PlayerView>();
  });
});

function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonicalJson(x)}`).join(',')}}`;
  }
  return JSON.stringify(v);
}
