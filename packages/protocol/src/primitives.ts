// Shared schema building blocks for client and server message schemas (design §3.11).
import type { EdgeId, HexId, ReasonCode as ReasonCodeT, Seat, VertexId } from '@hexlands/engine';
import { ReasonCode } from '@hexlands/engine';
import { z } from 'zod';

export const RESOURCE_NAMES = ['brick', 'lumber', 'wool', 'grain', 'ore'] as const;
export const DEV_CARD_KINDS = ['knight', 'roadBuilding', 'yearOfPlenty', 'monopoly', 'victoryPoint'] as const;
export const PHASE_NAMES = [
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
export const reasonCodeSchema = z.enum(Object.keys(ReasonCode) as [ReasonCodeT, ...ReasonCodeT[]]);
export const outcomeResultSchema = z.enum(['ok', 'rule', 'turn', 'auth', 'error']);

export const gameRulesShape = {
  vpTarget: z.number(),
  discardLimit: z.number(),
  boardConstraints: z.strictObject({ noAdjacentRedNumbers: z.boolean() }),
  friendlyRobber: z.strictObject({ enabled: z.boolean(), maxPublicVp: z.number() }),
};
export const absencePolicyShape = {
  mode: z.enum(['pause', 'pause_host_skip', 'turn_timer']),
  skipAfterSec: z.number(),
  turnTimerSec: z.number().nullable(),
  skipBy: z.enum(['host_or_any_if_host_absent', 'host_only']),
  seatRelinkEnabled: z.boolean(),
};
