// zod schemas for every wire message (design §3.11; TH17). Client messages are validated strictly (unknown keys and
// shapes are malformed_action); values whose meaning is a game rule (counts, ids on or off the board, names, config
// ranges) are left to the engine and server so they get their specific reason codes.
import type {
  AbsencePolicy,
  Action,
  EdgeId,
  GameRules,
  HexId,
  LegalActions,
  LogEntry,
  Phase,
  PlayerViewData,
  ReasonCode as ReasonCodeT,
  Seat,
  VertexId,
} from '@hexlands/engine';
import { ReasonCode } from '@hexlands/engine';
import { z } from 'zod';
import { CLIENT_ERROR_KINDS, RESUME_GAP_CAUSES } from './enums';
import type {
  AckMsg,
  ActionMsg,
  ClientMsg,
  ControlMsg,
  ControlOp,
  HelloMsg,
  LobbyMsg,
  LobbyOp,
  PongMsg,
  ResyncMsg,
  RoomView,
  ServerMsgWire,
  TelemetryMsg,
  VisibilityMsg,
} from './messages';

/** Inbound frames larger than this are refused with close 1009 (F10). */
export const MAX_INBOUND_FRAME_BYTES = 16 * 1024;

/** Telemetry batch limits enforced by the server's telemetry handler (G2). */
export const TELEMETRY_MAX_SAMPLES_PER_ARRAY = 100;
export const TELEMETRY_ACTION_RTT_MS_MAX = 60_000;
export const TELEMETRY_RESUME_GAP_MS_MAX = 600_000;
export const TELEMETRY_MIN_BATCH_INTERVAL_MS = 5_000;

// ── primitives ───────────────────────────────────────────────────────────────

const RESOURCE_NAMES = ['brick', 'lumber', 'wool', 'grain', 'ore'] as const;
const DEV_CARD_KINDS = ['knight', 'roadBuilding', 'yearOfPlenty', 'monopoly', 'victoryPoint'] as const;
const PHASE_NAMES = [
  'setupSettlement',
  'setupRoad',
  'preRoll',
  'discard',
  'moveRobber',
  'main',
  'roadBuilding',
  'gameOver',
] as const;

const HEX_ID = /^h:-?\d+,-?\d+$/;
const VERTEX_ID = /^v:-?\d+,-?\d+,(N|S)$/;
const EDGE_ID = /^e:-?\d+,-?\d+,(NE|NW|W)$/;

/** Shape of a hex id; whether it is on the board is the engine's call (invalid_location / invalid_robber_hex). */
export const hexIdSchema = z.custom<HexId>((v) => typeof v === 'string' && HEX_ID.test(v), 'hex id');
export const vertexIdSchema = z.custom<VertexId>((v) => typeof v === 'string' && VERTEX_ID.test(v), 'vertex id');
export const edgeIdSchema = z.custom<EdgeId>((v) => typeof v === 'string' && EDGE_ID.test(v), 'edge id');
export const seatSchema: z.ZodType<Seat> = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
export const resourceSchema = z.enum(RESOURCE_NAMES);
/** Any finite number per resource; integrality and sign are rule checks (invalid_trade, wrong_discard_count). */
export const resourceCountsSchema = z.strictObject({
  brick: z.number(),
  lumber: z.number(),
  wool: z.number(),
  grain: z.number(),
  ore: z.number(),
});
/** Client UUIDv4. */
export const actionIdSchema = z.uuidv4();
const reasonCodeSchema = z.enum(Object.keys(ReasonCode) as [ReasonCodeT, ...ReasonCodeT[]]);
const outcomeResultSchema = z.enum(['ok', 'rule', 'turn', 'auth', 'error']);

// ── actions ──────────────────────────────────────────────────────────────────

export const actionSchema: z.ZodType<Action> = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('placeSettlement'), vertex: vertexIdSchema }),
  z.strictObject({ type: z.literal('placeRoad'), edge: edgeIdSchema }),
  z.strictObject({ type: z.literal('buildCity'), vertex: vertexIdSchema }),
  z.strictObject({ type: z.literal('rollDice') }),
  z.strictObject({ type: z.literal('discard'), cards: resourceCountsSchema }),
  z.strictObject({ type: z.literal('moveRobber'), hex: hexIdSchema, victim: seatSchema.nullable() }),
  z.strictObject({ type: z.literal('buyDevCard') }),
  z.strictObject({ type: z.literal('playKnight') }),
  z.strictObject({ type: z.literal('playRoadBuilding') }),
  z.strictObject({ type: z.literal('playYearOfPlenty'), take: z.tuple([resourceSchema, resourceSchema]) }),
  z.strictObject({ type: z.literal('playMonopoly'), resource: resourceSchema }),
  z.strictObject({ type: z.literal('maritimeTrade'), give: resourceSchema, receive: resourceSchema, count: z.number() }),
  z.strictObject({ type: z.literal('proposeTrade'), give: resourceCountsSchema, get: resourceCountsSchema }),
  z.strictObject({ type: z.literal('respondTrade'), tradeId: z.number(), accept: z.boolean() }),
  z.strictObject({ type: z.literal('confirmTrade'), tradeId: z.number(), partner: seatSchema }),
  z.strictObject({ type: z.literal('cancelTrade'), tradeId: z.number() }),
  z.strictObject({ type: z.literal('endTurn') }),
]);

// ── lobby and control ────────────────────────────────────────────────────────

const gameRulesShape = {
  vpTarget: z.number(),
  discardLimit: z.number(),
  boardConstraints: z.strictObject({ noAdjacentRedNumbers: z.boolean() }),
  friendlyRobber: z.strictObject({ enabled: z.boolean(), maxPublicVp: z.number() }),
};
const absencePolicyShape = {
  mode: z.enum(['pause', 'pause_host_skip', 'turn_timer']),
  skipAfterSec: z.number(),
  turnTimerSec: z.number().nullable(),
  skipBy: z.enum(['host_or_any_if_host_absent', 'host_only']),
  seatRelinkEnabled: z.boolean(),
};
const gameRulesSchema: z.ZodType<GameRules> = z.strictObject(gameRulesShape);
const absencePolicySchema: z.ZodType<AbsencePolicy> = z.strictObject(absencePolicyShape);

/** Display names are plain strings here; NFC/trim/length/control-char rules are the server's (invalid_name). */
export const lobbyOpSchema: z.ZodType<LobbyOp> = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('join'), displayName: z.string() }),
  z.strictObject({ kind: z.literal('rename'), displayName: z.string() }),
  z.strictObject({ kind: z.literal('reorderSeats'), order: z.array(seatSchema).max(4) }),
  z.strictObject({ kind: z.literal('shuffleSeats') }),
  z.strictObject({ kind: z.literal('removeSeat'), seat: seatSchema }),
  z.strictObject({
    kind: z.literal('setConfig'),
    rules: z
      .strictObject({
        vpTarget: gameRulesShape.vpTarget.exactOptional(),
        discardLimit: gameRulesShape.discardLimit.exactOptional(),
        boardConstraints: gameRulesShape.boardConstraints.exactOptional(),
        friendlyRobber: gameRulesShape.friendlyRobber.exactOptional(),
      })
      .exactOptional(),
    absencePolicy: z
      .strictObject({
        mode: absencePolicyShape.mode.exactOptional(),
        skipAfterSec: absencePolicyShape.skipAfterSec.exactOptional(),
        turnTimerSec: absencePolicyShape.turnTimerSec.exactOptional(),
        skipBy: absencePolicyShape.skipBy.exactOptional(),
        seatRelinkEnabled: absencePolicyShape.seatRelinkEnabled.exactOptional(),
      })
      .exactOptional(),
  }),
  z.strictObject({ kind: z.literal('start') }),
]);

export const controlOpSchema: z.ZodType<ControlOp> = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('skipAbsent'), seat: seatSchema }),
  z.strictObject({ kind: z.literal('resume') }),
  z.strictObject({ kind: z.literal('relinkSeat'), seat: seatSchema }),
]);

// ── client messages ──────────────────────────────────────────────────────────

/** roomCode and seatToken are bounded strings; their validity is an auth result (unknown_room, bad_seat_token, …). */
export const helloSchema = z.strictObject({
  t: z.literal('hello'),
  v: z.literal(1),
  actionId: actionIdSchema,
  roomCode: z.string().max(64),
  seatToken: z.string().max(256).exactOptional(),
  lastSeq: z.number().exactOptional(),
}) satisfies z.ZodType<HelloMsg>;

export const actionMsgSchema = z.strictObject({
  t: z.literal('action'),
  actionId: actionIdSchema,
  baseSeq: z.number(),
  action: actionSchema,
}) satisfies z.ZodType<ActionMsg>;

export const lobbyMsgSchema = z.strictObject({
  t: z.literal('lobby'),
  actionId: actionIdSchema,
  op: lobbyOpSchema,
}) satisfies z.ZodType<LobbyMsg>;

export const controlMsgSchema = z.strictObject({
  t: z.literal('control'),
  actionId: actionIdSchema,
  op: controlOpSchema,
}) satisfies z.ZodType<ControlMsg>;

export const resyncSchema = z.strictObject({ t: z.literal('resync') }) satisfies z.ZodType<ResyncMsg>;
export const ackSchema = z.strictObject({ t: z.literal('ack'), seq: z.number() }) satisfies z.ZodType<AckMsg>;
export const pongSchema = z.strictObject({ t: z.literal('pong'), id: z.number() }) satisfies z.ZodType<PongMsg>;
export const visibilitySchema = z.strictObject({
  t: z.literal('visibility'),
  state: z.enum(['hidden', 'visible']),
}) satisfies z.ZodType<VisibilityMsg>;

/** Shape and array-size limits only; clamping of out-of-range values is the server handler's job. */
export const telemetrySchema = z.strictObject({
  t: z.literal('telemetry'),
  resumeGaps: z
    .array(z.strictObject({ ms: z.number(), cause: z.enum(RESUME_GAP_CAUSES) }))
    .max(TELEMETRY_MAX_SAMPLES_PER_ARRAY)
    .exactOptional(),
  actionRttMs: z.array(z.number()).max(TELEMETRY_MAX_SAMPLES_PER_ARRAY).exactOptional(),
  errors: z
    .array(z.strictObject({ kind: z.enum(CLIENT_ERROR_KINDS), message: z.string() }))
    .max(TELEMETRY_MAX_SAMPLES_PER_ARRAY)
    .exactOptional(),
}) satisfies z.ZodType<TelemetryMsg>;

export const clientMsgSchema: z.ZodType<ClientMsg> = z.discriminatedUnion('t', [
  helloSchema,
  actionMsgSchema,
  lobbyMsgSchema,
  controlMsgSchema,
  resyncSchema,
  ackSchema,
  pongSchema,
  visibilitySchema,
  telemetrySchema,
]);

/** Signals never get an outcome and never change game state (P9). */
export const SIGNAL_TYPES = ['resync', 'ack', 'pong', 'visibility', 'telemetry'] as const;

// ── server messages (for the web client and test clients) ───────────────────
// Envelopes are strict. Everything under `view` is validated structurally with loose objects: unknown keys are kept,
// nothing is stripped, defaulted, coerced or transformed, so the parsed view is exactly what was sent and the client's
// viewHash / publicProjectionHash match the server's (D5).

const viewResourceCounts = z.looseObject({
  brick: z.number(),
  lumber: z.number(),
  wool: z.number(),
  grain: z.number(),
  ore: z.number(),
});
const viewGameRules = z.looseObject({
  ...gameRulesShape,
  boardConstraints: z.looseObject({ noAdjacentRedNumbers: z.boolean() }),
  friendlyRobber: z.looseObject({ enabled: z.boolean(), maxPublicVp: z.number() }),
});

const phaseNameSchema = z.enum(PHASE_NAMES);
const devCardKindSchema = z.enum(DEV_CARD_KINDS);
const playedDevSchema = z.looseObject({
  knight: z.number(),
  roadBuilding: z.number(),
  yearOfPlenty: z.number(),
  monopoly: z.number(),
});
const tradeOfferSchema = z.looseObject({
  id: z.number(),
  from: seatSchema,
  give: viewResourceCounts,
  get: viewResourceCounts,
  responses: z.array(z.enum(['pending', 'accepted', 'declined', 'self'])),
});
const round = z.union([z.literal(1), z.literal(2)]);
const resumeSchema = z.enum(['preRoll', 'main']);

const phaseSchema: z.ZodType<Phase> = z.discriminatedUnion('name', [
  z.looseObject({ name: z.literal('setupSettlement'), round }),
  z.looseObject({ name: z.literal('setupRoad'), round, from: vertexIdSchema }),
  z.looseObject({ name: z.literal('preRoll') }),
  z.looseObject({
    name: z.literal('discard'),
    owed: z.array(z.number()),
    then: z.enum(['moveRobber', 'autoRobberThenEnd']),
  }),
  z.looseObject({ name: z.literal('moveRobber'), resume: resumeSchema }),
  z.looseObject({ name: z.literal('main') }),
  z.looseObject({
    name: z.literal('roadBuilding'),
    remaining: z.union([z.literal(1), z.literal(2)]),
    resume: resumeSchema,
  }),
  z.looseObject({ name: z.literal('gameOver'), winner: seatSchema }),
]);

const gameEventSchema = z.discriminatedUnion('kind', [
  z.looseObject({
    kind: z.literal('diceRolled'),
    seat: seatSchema,
    dice: z.tuple([z.number(), z.number()]),
    gains: z.array(viewResourceCounts),
    shortage: z.array(resourceSchema),
    auto: z.boolean(),
  }),
  z.looseObject({ kind: z.literal('setupResources'), seat: seatSchema, gained: viewResourceCounts }),
  z.looseObject({
    kind: z.literal('built'),
    seat: seatSchema,
    piece: z.enum(['road', 'settlement', 'city']),
    at: z.union([vertexIdSchema, edgeIdSchema]),
    free: z.boolean(),
  }),
  z.looseObject({ kind: z.literal('discarded'), seat: seatSchema, cards: viewResourceCounts, auto: z.boolean() }),
  z.looseObject({
    kind: z.literal('robberMoved'),
    seat: seatSchema,
    hex: hexIdSchema,
    victim: seatSchema.nullable(),
    auto: z.boolean(),
  }),
  z.looseObject({ kind: z.literal('stole'), seat: seatSchema, victim: seatSchema }),
  z.looseObject({ kind: z.literal('stoleDetail'), seat: seatSchema, victim: seatSchema, resource: resourceSchema }),
  z.looseObject({ kind: z.literal('devBought'), seat: seatSchema }),
  z.looseObject({ kind: z.literal('devBoughtDetail'), seat: seatSchema, card: devCardKindSchema }),
  z.looseObject({
    kind: z.literal('devPlayed'),
    seat: seatSchema,
    card: z.enum(['knight', 'roadBuilding', 'yearOfPlenty', 'monopoly']),
    picks: z.array(resourceSchema).exactOptional(),
    taken: z.array(z.number()).exactOptional(),
  }),
  z.looseObject({
    kind: z.literal('maritimeTraded'),
    seat: seatSchema,
    give: resourceSchema,
    gave: z.number(),
    receive: resourceSchema,
    received: z.number(),
  }),
  z.looseObject({ kind: z.literal('tradeProposed'), offer: tradeOfferSchema, replaced: z.number().nullable() }),
  z.looseObject({ kind: z.literal('tradeResponded'), tradeId: z.number(), seat: seatSchema, accept: z.boolean() }),
  z.looseObject({
    kind: z.literal('tradeResolved'),
    tradeId: z.number(),
    outcome: z.enum(['confirmed', 'cancelled', 'replaced', 'withdrawn']),
    partner: seatSchema.nullable(),
    exitTo: phaseNameSchema.exactOptional(),
  }),
  z.looseObject({
    kind: z.literal('awardChanged'),
    award: z.enum(['longestRoad', 'largestArmy']),
    from: seatSchema.nullable(),
    to: seatSchema.nullable(),
  }),
  z.looseObject({ kind: z.literal('seatSkipped'), seat: seatSchema, reason: z.enum(['host', 'timer']) }),
  z.looseObject({
    kind: z.literal('turnEnded'),
    seat: seatSchema,
    turn: z.number(),
    reason: z.enum(['endTurn', 'skipped']),
  }),
  z.looseObject({ kind: z.literal('gameOver'), winner: seatSchema, vp: z.array(z.number()) }),
]);

const logEntrySchema: z.ZodType<LogEntry> = z.looseObject({
  n: z.number(),
  event: gameEventSchema,
  visibleTo: z.union([z.literal('all'), z.array(seatSchema)]),
});

const legalActionsSchema: z.ZodType<LegalActions> = z.looseObject({
  seat: seatSchema,
  phase: phaseNameSchema,
  placeSettlement: z.array(vertexIdSchema),
  placeRoad: z.array(edgeIdSchema),
  buildCity: z.array(vertexIdSchema),
  rollDice: z.boolean(),
  endTurn: z.boolean(),
  buyDevCard: z.boolean(),
  playKnight: z.boolean(),
  playRoadBuilding: z.boolean(),
  playYearOfPlenty: z.array(z.tuple([resourceSchema, resourceSchema])),
  playMonopoly: z.boolean(),
  discard: z.looseObject({ count: z.number() }).nullable(),
  moveRobber: z.array(z.looseObject({ hex: hexIdSchema, victims: z.array(seatSchema) })),
  maritime: z.partialRecord(resourceSchema, z.union([z.literal(2), z.literal(3), z.literal(4)])),
  bankStock: viewResourceCounts,
  proposeTrade: z.boolean(),
  respondTrade: z.looseObject({ tradeId: z.number(), canAccept: z.boolean() }).nullable(),
  confirmTrade: z.looseObject({ tradeId: z.number(), partners: z.array(seatSchema) }).nullable(),
  cancelTrade: z.number().nullable(),
});

/** Structural schema of a view as received (PlayerViewWire). */
export const playerViewWireSchema: z.ZodType<PlayerViewData> = z.looseObject({
  schemaVersion: z.literal(1),
  you: seatSchema,
  config: viewGameRules,
  playerCount: z.union([z.literal(3), z.literal(4)]),
  board: z.looseObject({
    hexes: z.array(
      z.looseObject({
        id: hexIdSchema,
        terrain: z.enum(['hills', 'forest', 'pasture', 'fields', 'mountains', 'desert']),
        token: z.number().nullable(),
      }),
    ),
    harbors: z.array(z.looseObject({ edge: edgeIdSchema, kind: z.enum(['generic', ...RESOURCE_NAMES]) })),
  }),
  robber: hexIdSchema,
  pieces: z.looseObject({
    settlements: z.record(vertexIdSchema, seatSchema),
    cities: z.record(vertexIdSchema, seatSchema),
    roads: z.record(edgeIdSchema, seatSchema),
  }),
  bank: viewResourceCounts,
  devDeckCount: z.number(),
  players: z.array(
    z.looseObject({
      seat: seatSchema,
      handCount: z.number(),
      devCardCount: z.number(),
      playedDev: playedDevSchema,
      publicVp: z.number(),
      supply: z.looseObject({ settlements: z.number(), cities: z.number(), roads: z.number() }),
      longestRoad: z.number(),
      discardOwed: z.number(),
    }),
  ),
  hand: viewResourceCounts,
  devCards: z.array(z.looseObject({ kind: devCardKindSchema, playableNow: z.boolean() })),
  vp: z.looseObject({ public: z.number(), total: z.number() }),
  turn: z.looseObject({
    number: z.number(),
    active: seatSchema,
    dice: z.tuple([z.number(), z.number()]).nullable(),
    devPlayed: z.boolean(),
    endsAfterDiscards: z.boolean(),
  }),
  phase: phaseSchema,
  trade: tradeOfferSchema.nullable(),
  awards: z.looseObject({ longestRoad: seatSchema.nullable(), largestArmy: seatSchema.nullable() }),
  log: z.array(logEntrySchema),
  legal: legalActionsSchema,
  reveal: z
    .looseObject({
      hands: z.array(viewResourceCounts),
      devCards: z.array(z.array(devCardKindSchema)),
      vp: z.array(z.number()),
    })
    .nullable(),
});

export const roomViewSchema: z.ZodType<RoomView> = z.strictObject({
  lifecycle: z.enum(['lobby', 'active', 'abandoned', 'finished', 'expired']),
  hostSeat: seatSchema,
  seats: z.array(z.strictObject({ seat: seatSchema, name: z.string().nullable(), connected: z.boolean() })),
  config: z.strictObject({ rules: gameRulesSchema, absencePolicy: absencePolicySchema }),
  waitingOn: z.array(z.strictObject({ seat: seatSchema, disconnectedForSec: z.number().nullable() })),
  skippable: z.array(seatSchema),
  buildVersion: z.string(),
});

export const serverMsgSchema: z.ZodType<ServerMsgWire> = z.discriminatedUnion('t', [
  z.strictObject({
    t: z.literal('welcome'),
    v: z.literal(1),
    seat: seatSchema.nullable(),
    isHost: z.boolean(),
    room: roomViewSchema,
    seq: z.number(),
    view: playerViewWireSchema.nullable(),
  }),
  z.strictObject({
    t: z.literal('seatToken'),
    seat: seatSchema,
    seatToken: z.string(),
    purpose: z.enum(['joined', 'relinked']),
  }),
  z.strictObject({ t: z.literal('state'), seq: z.number(), view: playerViewWireSchema }),
  z.strictObject({ t: z.literal('room'), rev: z.number(), room: roomViewSchema }),
  z.strictObject({
    t: z.literal('outcome'),
    actionId: z.string().nullable(),
    result: outcomeResultSchema,
    reasonCode: reasonCodeSchema.exactOptional(),
    seq: z.number().exactOptional(),
  }),
  z.strictObject({ t: z.literal('superseded') }),
  z.strictObject({ t: z.literal('ping'), id: z.number() }),
]);
