// zod schemas for server → client messages (design §3.11, D5, D6), built by one factory in two modes:
// - 'tolerant' (serverMsgSchema, used by the web client and test clients): ServerMsg envelopes are strict, but every
//   object under `view` and `room` is loose, so keys a newer server adds are preserved, and log events of unknown kinds
//   are accepted as UnknownGameEvent. A cached old bundle therefore keeps parsing frames from a redeployed server.
// - 'strict' (serverMsgSchemaStrict, test-only via @hexlands/protocol/testing): every object is strict and only known
//   log kinds pass, so CI fails loudly when the server emits a field or kind the protocol does not describe.
// In both modes known fields are type-checked exactly and nothing is defaulted, coerced, transformed or stripped: a
// parsed view is exactly what was sent, so client and server view hashes agree (D5).
import { z } from 'zod';
import { GAME_EVENT_KINDS } from './game-events';
import type { PlayerViewWire, RoomView, ServerMsgWire } from './messages';
import {
  DEV_CARD_KINDS,
  PHASE_NAMES,
  RESOURCE_NAMES,
  absencePolicyShape,
  edgeIdSchema,
  hexIdSchema,
  outcomeResultSchema,
  reasonCodeSchema,
  resourceSchema,
  seatSchema,
  vertexIdSchema,
} from './primitives';

export type ServerSchemaMode = 'tolerant' | 'strict';

export interface ServerSchemas {
  readonly serverMsgSchema: z.ZodType<ServerMsgWire>;
  readonly playerViewWireSchema: z.ZodType<PlayerViewWire>;
  readonly roomViewSchema: z.ZodType<RoomView>;
}

export function buildServerSchemas(mode: ServerSchemaMode): ServerSchemas {
  // Objects under view and room. The cast unifies the loose and strict object types; both validate the same shape.
  const obj = <S extends z.ZodRawShape>(shape: S) =>
    (mode === 'strict' ? z.strictObject(shape) : z.looseObject(shape)) as unknown as z.ZodObject<S>;

  const resourceCounts = obj({
    brick: z.number(),
    lumber: z.number(),
    wool: z.number(),
    grain: z.number(),
    ore: z.number(),
  });
  const gameRules = obj({
    vpTarget: z.number(),
    discardLimit: z.number(),
    boardConstraints: obj({ noAdjacentRedNumbers: z.boolean() }),
    friendlyRobber: obj({ enabled: z.boolean(), maxPublicVp: z.number() }),
  });
  const phaseName = z.enum(PHASE_NAMES);
  const devCardKind = z.enum(DEV_CARD_KINDS);
  const round = z.union([z.literal(1), z.literal(2)]);
  const resume = z.enum(['preRoll', 'main']);
  const tradeOffer = obj({
    id: z.number(),
    from: seatSchema,
    give: resourceCounts,
    get: resourceCounts,
    responses: z.array(z.enum(['pending', 'accepted', 'declined', 'self'])),
  });

  const phase = z.discriminatedUnion('name', [
    obj({ name: z.literal('setupSettlement'), round }),
    obj({ name: z.literal('setupRoad'), round, from: vertexIdSchema }),
    obj({ name: z.literal('preRoll') }),
    obj({ name: z.literal('discard'), owed: z.array(z.number()), then: z.enum(['moveRobber', 'autoRobberThenEnd']) }),
    obj({ name: z.literal('moveRobber'), resume }),
    obj({ name: z.literal('main') }),
    obj({ name: z.literal('roadBuilding'), remaining: z.union([z.literal(1), z.literal(2)]), resume }),
    obj({ name: z.literal('gameOver'), winner: seatSchema }),
  ]);

  const knownEvent = z.discriminatedUnion('kind', [
    obj({
      kind: z.literal('diceRolled'),
      seat: seatSchema,
      dice: z.tuple([z.number(), z.number()]),
      gains: z.array(resourceCounts),
      shortage: z.array(resourceSchema),
      auto: z.boolean(),
    }),
    obj({ kind: z.literal('setupResources'), seat: seatSchema, gained: resourceCounts }),
    obj({
      kind: z.literal('built'),
      seat: seatSchema,
      piece: z.enum(['road', 'settlement', 'city']),
      at: z.union([vertexIdSchema, edgeIdSchema]),
      free: z.boolean(),
    }),
    obj({ kind: z.literal('discarded'), seat: seatSchema, cards: resourceCounts, auto: z.boolean() }),
    obj({ kind: z.literal('robberMoved'), seat: seatSchema, hex: hexIdSchema, victim: seatSchema.nullable(), auto: z.boolean() }),
    obj({ kind: z.literal('stole'), seat: seatSchema, victim: seatSchema }),
    obj({ kind: z.literal('stoleDetail'), seat: seatSchema, victim: seatSchema, resource: resourceSchema }),
    obj({ kind: z.literal('devBought'), seat: seatSchema }),
    obj({ kind: z.literal('devBoughtDetail'), seat: seatSchema, card: devCardKind }),
    obj({
      kind: z.literal('devPlayed'),
      seat: seatSchema,
      card: z.enum(['knight', 'roadBuilding', 'yearOfPlenty', 'monopoly']),
      picks: z.array(resourceSchema).exactOptional(),
      taken: z.array(z.number()).exactOptional(),
    }),
    obj({
      kind: z.literal('maritimeTraded'),
      seat: seatSchema,
      give: resourceSchema,
      gave: z.number(),
      receive: resourceSchema,
      received: z.number(),
    }),
    obj({ kind: z.literal('tradeProposed'), offer: tradeOffer, replaced: z.number().nullable() }),
    obj({ kind: z.literal('tradeResponded'), tradeId: z.number(), seat: seatSchema, accept: z.boolean() }),
    obj({
      kind: z.literal('tradeResolved'),
      tradeId: z.number(),
      outcome: z.enum(['confirmed', 'cancelled', 'replaced', 'withdrawn']),
      partner: seatSchema.nullable(),
      exitTo: phaseName.exactOptional(),
    }),
    obj({
      kind: z.literal('awardChanged'),
      award: z.enum(['longestRoad', 'largestArmy']),
      from: seatSchema.nullable(),
      to: seatSchema.nullable(),
    }),
    obj({ kind: z.literal('seatSkipped'), seat: seatSchema, reason: z.enum(['host', 'timer']) }),
    obj({ kind: z.literal('turnEnded'), seat: seatSchema, turn: z.number(), reason: z.enum(['endTurn', 'skipped']) }),
    obj({ kind: z.literal('gameOver'), winner: seatSchema, vp: z.array(z.number()) }),
  ]);
  const known = new Set<string>(GAME_EVENT_KINDS);
  // Only kinds this build does not know fall back, so a known kind with a bad field still fails.
  const unknownEvent = z.looseObject({ kind: z.string().refine((k) => !known.has(k), 'known event kind') });
  const event = mode === 'strict' ? knownEvent : z.union([knownEvent, unknownEvent]);

  const logEntry = obj({
    n: z.number(),
    event,
    visibleTo: z.union([z.literal('all'), z.array(seatSchema)]),
  });

  const legal = obj({
    seat: seatSchema,
    phase: phaseName,
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
    discard: obj({ count: z.number() }).nullable(),
    moveRobber: z.array(obj({ hex: hexIdSchema, victims: z.array(seatSchema) })),
    maritime: z.partialRecord(resourceSchema, z.union([z.literal(2), z.literal(3), z.literal(4)])),
    bankStock: resourceCounts,
    proposeTrade: z.boolean(),
    respondTrade: obj({ tradeId: z.number(), canAccept: z.boolean() }).nullable(),
    confirmTrade: obj({ tradeId: z.number(), partners: z.array(seatSchema) }).nullable(),
    cancelTrade: z.number().nullable(),
  });

  const playerViewWireSchema = obj({
    schemaVersion: z.literal(1),
    you: seatSchema,
    config: gameRules,
    playerCount: z.union([z.literal(3), z.literal(4)]),
    board: obj({
      hexes: z.array(
        obj({
          id: hexIdSchema,
          terrain: z.enum(['hills', 'forest', 'pasture', 'fields', 'mountains', 'desert']),
          token: z.number().nullable(),
        }),
      ),
      harbors: z.array(obj({ edge: edgeIdSchema, kind: z.enum(['generic', ...RESOURCE_NAMES]) })),
    }),
    robber: hexIdSchema,
    pieces: obj({
      settlements: z.record(vertexIdSchema, seatSchema),
      cities: z.record(vertexIdSchema, seatSchema),
      roads: z.record(edgeIdSchema, seatSchema),
    }),
    bank: resourceCounts,
    devDeckCount: z.number(),
    players: z.array(
      obj({
        seat: seatSchema,
        handCount: z.number(),
        devCardCount: z.number(),
        playedDev: obj({ knight: z.number(), roadBuilding: z.number(), yearOfPlenty: z.number(), monopoly: z.number() }),
        publicVp: z.number(),
        supply: obj({ settlements: z.number(), cities: z.number(), roads: z.number() }),
        longestRoad: z.number(),
        discardOwed: z.number(),
      }),
    ),
    hand: resourceCounts,
    devCards: z.array(obj({ kind: devCardKind, playableNow: z.boolean() })),
    vp: obj({ public: z.number(), total: z.number() }),
    turn: obj({
      number: z.number(),
      active: seatSchema,
      dice: z.tuple([z.number(), z.number()]).nullable(),
      devPlayed: z.boolean(),
      endsAfterDiscards: z.boolean(),
    }),
    phase,
    trade: tradeOffer.nullable(),
    awards: obj({ longestRoad: seatSchema.nullable(), largestArmy: seatSchema.nullable() }),
    log: z.array(logEntry),
    legal,
    reveal: obj({
      hands: z.array(resourceCounts),
      devCards: z.array(z.array(devCardKind)),
      vp: z.array(z.number()),
    }).nullable(),
  }) satisfies z.ZodType<PlayerViewWire>;

  const roomViewSchema = obj({
    lifecycle: z.enum(['lobby', 'active', 'abandoned', 'finished', 'expired']),
    hostSeat: seatSchema,
    seats: z.array(obj({ seat: seatSchema, name: z.string().nullable(), connected: z.boolean() })),
    config: obj({ rules: gameRules, absencePolicy: obj(absencePolicyShape) }),
    waitingOn: z.array(obj({ seat: seatSchema, disconnectedForSec: z.number().nullable() })),
    skippable: z.array(seatSchema),
    /** The server's build id; a client whose own build differs shows a "new version available" notice. */
    buildVersion: z.string(),
  }) satisfies z.ZodType<RoomView>;

  // ServerMsg envelopes are strict in both modes; a new envelope field or message type is a PROTOCOL_VERSION bump.
  const serverMsgSchema = z.discriminatedUnion('t', [
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
  ]) satisfies z.ZodType<ServerMsgWire>;

  return { serverMsgSchema, playerViewWireSchema, roomViewSchema };
}

const tolerant = buildServerSchemas('tolerant');

/** Server → client messages as parsed by clients: strict envelopes, tolerant view and room (D6). */
export const serverMsgSchema: z.ZodType<ServerMsgWire> = tolerant.serverMsgSchema;
export const playerViewWireSchema: z.ZodType<PlayerViewWire> = tolerant.playerViewWireSchema;
export const roomViewSchema: z.ZodType<RoomView> = tolerant.roomViewSchema;
