// Disconnect classification (design §9.4): one shared enum, used as the catan.ws.disconnects label and by NFR5.
// Rules are checked in table order; only sockets bound to a seat are counted as disconnects.
import { CloseCode, type DisconnectReason, type UnplannedCause } from '@hexlands/protocol';

/** Why the server itself closed or killed a socket, when it did. */
export type ServerCloseCause = 'drain' | 'superseded' | 'revoked' | 'heartbeat_timeout' | 'backpressure' | 'policy' | 'shutdown';

export interface DisconnectFacts {
  /** Set when the server initiated the close. */
  readonly serverCause: ServerCloseCause | null;
  /** The close code observed on the socket (1006 when the connection dropped without a close frame). */
  readonly code: number;
  /** When the client last reported visibility 'hidden' with no later 'visible'; null otherwise. */
  readonly hiddenSince: number | null;
  readonly now: number;
  readonly backgroundGraceMs: number;
}

export interface DisconnectClass {
  readonly reason: DisconnectReason;
  /** Only for reason 'unplanned'; a log field, never a metric label. */
  readonly cause?: UnplannedCause;
}

export function classifyDisconnect(f: DisconnectFacts): DisconnectClass {
  if (f.serverCause === 'drain' || f.serverCause === 'shutdown' || f.code === CloseCode.SERVICE_RESTART) {
    return { reason: 'server_restart' };
  }
  if (f.serverCause === 'superseded' || f.serverCause === 'revoked') return { reason: 'superseded' };
  if (f.hiddenSince !== null && f.now - f.hiddenSince <= f.backgroundGraceMs) return { reason: 'client_backgrounded' };
  if (f.serverCause === null && (f.code === CloseCode.NORMAL || f.code === CloseCode.GOING_AWAY)) {
    return { reason: 'client_closed' };
  }
  if (f.serverCause === 'heartbeat_timeout') return { reason: 'unplanned', cause: 'heartbeat_timeout' };
  if (f.serverCause === 'backpressure') return { reason: 'unplanned', cause: 'backpressure' };
  return { reason: 'unplanned', cause: 'abnormal_close' };
}
