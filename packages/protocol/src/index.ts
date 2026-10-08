// Public entry point of @hexlands/protocol: wire message types, zod schemas, shared enums and close codes
// (design §2.2, §3.11). It never exposes GameState; views are PlayerView (server side) or PlayerViewWire (client side).
// Test-only schemas live in @hexlands/protocol/testing.
export * from './close-codes';
export * from './enums';
export * from './game-events';
export * from './messages';
export * from './schemas';
export { playerViewWireSchema, roomViewSchema, serverMsgSchema } from './server-schemas';
export {
  actionIdSchema,
  edgeIdSchema,
  hexIdSchema,
  resourceCountsSchema,
  resourceSchema,
  seatSchema,
  vertexIdSchema,
} from './primitives';
