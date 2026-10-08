// Public entry point of @hexlands/protocol: wire message types, zod schemas, shared enums and close codes
// (design §2.2, §3.11). It never exposes GameState; views are PlayerView (server side) or PlayerViewWire (client side).
export * from './close-codes';
export * from './enums';
export * from './messages';
export * from './schemas';
