// Test-only exports of @hexlands/protocol (D6). Application code must not import this entry
// (dependency-cruiser rule no-protocol-testing-in-apps).
import { buildServerSchemas } from '../server-schemas';

const strict = buildServerSchemas('strict');

/**
 * serverMsgSchema with every object strict and only known log kinds. CI parses real server and engine outputs with it,
 * so a field or event kind the protocol does not describe fails before deploy instead of being silently tolerated.
 */
export const serverMsgSchemaStrict = strict.serverMsgSchema;
export const playerViewWireSchemaStrict = strict.playerViewWireSchema;
export const roomViewSchemaStrict = strict.roomViewSchema;
