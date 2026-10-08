// zod schemas for client → server messages (design §3.11, D6; TH17). They are STRICT: an unknown key or shape fails,
// which the gateway answers with rule/malformed_action (hello/action/lobby/control) or drops silently (signals).
// Values whose meaning is a game rule (counts, ids on or off the board, names, config ranges) pass here and are left to
// the engine and server so they get their specific reason codes.
import type { Action } from '@hexlands/engine';
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
  TelemetryMsg,
  VisibilityMsg,
} from './messages';
import {
  absencePolicyShape,
  actionIdSchema,
  edgeIdSchema,
  gameRulesShape,
  hexIdSchema,
  resourceCountsSchema,
  resourceSchema,
  seatSchema,
  vertexIdSchema,
} from './primitives';

/** Inbound frames larger than this are refused with close 1009 (F10). */
export const MAX_INBOUND_FRAME_BYTES = 16 * 1024;

/** Telemetry batch limits enforced by the server's telemetry handler (G2). */
export const TELEMETRY_MAX_SAMPLES_PER_ARRAY = 100;
export const TELEMETRY_ACTION_RTT_MS_MAX = 60_000;
export const TELEMETRY_RESUME_GAP_MS_MAX = 600_000;
export const TELEMETRY_MIN_BATCH_INTERVAL_MS = 5_000;
/** Longest client error message the schema accepts; the client truncates to it before sending. */
export const TELEMETRY_ERROR_MESSAGE_MAX = 200;

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
    .array(z.strictObject({ kind: z.enum(CLIENT_ERROR_KINDS), message: z.string().max(TELEMETRY_ERROR_MESSAGE_MAX) }))
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
