// WebSocket close codes (design §3.11, ADR-0004).
// - 4001 SUPERSEDED, 4401 AUTH_FAILED and 4410 GAME_GONE are terminal: the client does not auto-reconnect.
// - 1006, 1008, 1012 and 4408 HEARTBEAT are followed by an automatic reconnect.
export const CloseCode = Object.freeze({
  NORMAL: 1000,
  GOING_AWAY: 1001,
  /** Sustained abuse, e.g. too many malformed frames or socket backpressure. */
  POLICY: 1008,
  /** Inbound frame above MAX_INBOUND_FRAME_BYTES. */
  TOO_BIG: 1009,
  /** Server drain (deploy/restart); the client reconnects and tags the resume gap 'server_restart'. */
  SERVICE_RESTART: 1012,
  /** The seat was opened on another socket (P6); sent after a `superseded` message. */
  SUPERSEDED: 4001,
  AUTH_FAILED: 4401,
  HEARTBEAT: 4408,
  /** The game is expired or purged. */
  GAME_GONE: 4410,
} as const);
export type CloseCode = (typeof CloseCode)[keyof typeof CloseCode];
