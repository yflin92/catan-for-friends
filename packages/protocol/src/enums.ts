// Shared closed enums (design §3.8, §3.11, §9.4). Metric labels and the engine use these same definitions.
import type { ReasonCode } from '@hexlands/engine';

export { ReasonCode, reasonCategory } from '@hexlands/engine';
export type { OutcomeResult, ResultCategory } from '@hexlands/engine';

/** One shared enum: the catan.ws.disconnects label = the requirements NFR5 values. */
export const DISCONNECT_REASONS = [
  'unplanned',
  'client_backgrounded',
  'server_restart',
  'client_closed',
  'superseded',
] as const;
export type DisconnectReason = (typeof DISCONNECT_REASONS)[number];

/** Log field player.disconnected.cause only (reason = unplanned); never a metric label. */
export const UNPLANNED_CAUSES = ['heartbeat_timeout', 'abnormal_close', 'backpressure'] as const;
export type UnplannedCause = (typeof UNPLANNED_CAUSES)[number];

export const RECONNECT_OUTCOMES = ['resumed', 'failed_auth', 'failed_gone', 'failed_error'] as const;
export type ReconnectOutcome = (typeof RECONNECT_OUTCOMES)[number];

export const CLIENT_ERROR_KINDS = ['js_error', 'ws_protocol', 'render', 'other'] as const;
export type ClientErrorKind = (typeof CLIENT_ERROR_KINDS)[number];

/** Label of catan.ws.resume_gap: 'server_restart' iff the lost socket closed with 1012, else 'network' (G1). */
export const RESUME_GAP_CAUSES = ['network', 'server_restart'] as const;
export type ResumeGapCause = (typeof RESUME_GAP_CAUSES)[number];

/**
 * Reason codes of HTTP POST /api/rooms responses. 'bad_passphrase' is returned only when rooms.createPassphrase is set
 * (Q9). It is never sent over WS, is not a ReasonCode, and is never a catan.actions.rejected{reason_code} value.
 */
export type HttpReasonCode =
  | Extract<ReasonCode, 'capacity_reached' | 'rate_limited_auth' | 'invalid_name' | 'malformed_action'>
  | 'bad_passphrase';

export const HTTP_REASON_CODES: readonly HttpReasonCode[] = Object.freeze([
  'capacity_reached',
  'rate_limited_auth',
  'invalid_name',
  'malformed_action',
  'bad_passphrase',
] as const satisfies readonly HttpReasonCode[]);
