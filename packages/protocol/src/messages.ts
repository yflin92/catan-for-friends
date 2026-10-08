// Wire messages (design §3.11, ADR-0004 rev 1.3). One WebSocket per tab at /ws, JSON text frames.
// No secret is ever placed in a URL path or query: room codes and seat tokens travel only inside `hello`, the
// `seatToken` message and the POST /api/rooms body.
//
// Every hello, action, lobby and control message gets exactly ONE `outcome` (P1). Signals (resync, ack, pong,
// visibility, telemetry) carry no seq, never get an outcome, never change game state and are excluded from
// catan.actions (P9).
import type {
  AbsencePolicy,
  Action,
  GameRules,
  OutcomeResult,
  PlayerView,
  PlayerViewData,
  ReasonCode,
  Seat,
} from '@hexlands/engine';
import type { ClientErrorKind, ResumeGapCause } from './enums';

export const PROTOCOL_VERSION = 1;

/** Client-generated UUIDv4, unique per (game, seat). A resend reuses the original id (AC21). */
export type ActionId = string;

// ── client → server ──────────────────────────────────────────────────────────

export type ClientMsg =
  | HelloMsg
  | ActionMsg
  | LobbyMsg
  | ControlMsg
  | ResyncMsg
  | AckMsg
  | PongMsg
  | VisibilityMsg
  | TelemetryMsg;

/** Opens (or resumes) a session. Secrets travel here, never in the URL (ADR-0006). */
export interface HelloMsg {
  readonly t: 'hello';
  readonly v: 1;
  readonly actionId: ActionId;
  readonly roomCode: string;
  readonly seatToken?: string;
  /** The last seq the client applied; diagnostic only, any value is accepted (§5.5). */
  readonly lastSeq?: number;
}

export interface ActionMsg {
  readonly t: 'action';
  readonly actionId: ActionId;
  /** The seq the client saw when it sent the action; diagnostic only (§5.2). Validation uses the current state. */
  readonly baseSeq: number;
  readonly action: Action;
}

export interface LobbyMsg {
  readonly t: 'lobby';
  readonly actionId: ActionId;
  readonly op: LobbyOp;
}

export interface ControlMsg {
  readonly t: 'control';
  readonly actionId: ActionId;
  readonly op: ControlOp;
}

/** Signal: request the current view (answered with `state` to this socket only). */
export interface ResyncMsg {
  readonly t: 'resync';
}

/** Signal: the client applied the view at `seq`. */
export interface AckMsg {
  readonly t: 'ack';
  readonly seq: number;
}

/** Signal: answer to `ping`. */
export interface PongMsg {
  readonly t: 'pong';
  readonly id: number;
}

/** Signal: page visibility changes (P9; feeds the client_backgrounded classification). */
export interface VisibilityMsg {
  readonly t: 'visibility';
  readonly state: 'hidden' | 'visible';
}

/**
 * Signal: client-measured telemetry, batched every 15 s and after each reconnect (P9, G1/G2). Server limits are the
 * TELEMETRY_* constants; anything over them, malformed, or above one batch per 5 s per socket is counted as
 * catan.telemetry.dropped.
 */
export interface TelemetryMsg {
  readonly t: 'telemetry';
  /** Reconnect gaps; cause = 'server_restart' iff the lost socket closed with 1012, else 'network'. */
  readonly resumeGaps?: readonly { readonly ms: number; readonly cause: ResumeGapCause }[];
  /** Send → outcome times, only for actions whose outcome arrived on the same connection they were sent on. */
  readonly actionRttMs?: readonly number[];
  /** Sanitised client errors: no location.href, query or fragment. */
  readonly errors?: readonly { readonly kind: ClientErrorKind; readonly message: string }[];
}

export type LobbyOp =
  /** Takes the lowest free seat (F2). */
  | { readonly kind: 'join'; readonly displayName: string }
  | { readonly kind: 'rename'; readonly displayName: string }
  /** Host only. */
  | { readonly kind: 'reorderSeats'; readonly order: readonly Seat[] }
  /** Host only; server CSPRNG (the lobby is pre-engine). */
  | { readonly kind: 'shuffleSeats' }
  /** Host only; revokes that seat's token. */
  | { readonly kind: 'removeSeat'; readonly seat: Seat }
  /** Host only. */
  | { readonly kind: 'setConfig'; readonly rules?: Partial<GameRules>; readonly absencePolicy?: Partial<AbsencePolicy> }
  /** Host only; needs 3–4 seated. */
  | { readonly kind: 'start' };

export type ControlOp =
  /** §5.10. */
  | { readonly kind: 'skipAbsent'; readonly seat: Seat }
  /** abandoned → active (§5.7). */
  | { readonly kind: 'resume' }
  /** Host only; when absencePolicy.seatRelinkEnabled (Q8). */
  | { readonly kind: 'relinkSeat'; readonly seat: Seat };

// ── server → client ──────────────────────────────────────────────────────────

/** What the server sends. Views are always the branded PlayerView from engine view(); never GameState (AC25). */
export type ServerMsg =
  | {
      readonly t: 'welcome';
      readonly v: 1;
      readonly seat: Seat | null;
      readonly isHost: boolean;
      readonly room: RoomView;
      readonly seq: number;
      readonly view: PlayerView | null;
    }
  /** Only to the requesting socket. */
  | { readonly t: 'seatToken'; readonly seat: Seat; readonly seatToken: string; readonly purpose: 'joined' | 'relinked' }
  /** Full view at seq. */
  | { readonly t: 'state'; readonly seq: number; readonly view: PlayerView }
  | { readonly t: 'room'; readonly rev: number; readonly room: RoomView }
  | ({ readonly t: 'outcome' } & OutcomeRecord)
  /** Sent before close 4001. */
  | { readonly t: 'superseded' }
  | { readonly t: 'ping'; readonly id: number };

export interface RoomView {
  readonly lifecycle: 'lobby' | 'active' | 'abandoned' | 'finished' | 'expired';
  readonly hostSeat: Seat;
  readonly seats: readonly { readonly seat: Seat; readonly name: string | null; readonly connected: boolean }[];
  readonly config: { readonly rules: GameRules; readonly absencePolicy: AbsencePolicy };
  /** F11: seats the game is waiting on, with how long each has been disconnected (null = connected). */
  readonly waitingOn: readonly { readonly seat: Seat; readonly disconnectedForSec: number | null }[];
  readonly skippable: readonly Seat[];
  readonly buildVersion: string;
}

/** P1: the single result of a hello/action/lobby/control message. actionId is null for an unparseable frame. */
export interface OutcomeRecord {
  readonly actionId: ActionId | null;
  readonly result: OutcomeResult;
  readonly reasonCode?: ReasonCode;
  readonly seq?: number;
}

// ── wire types (client side) ─────────────────────────────────────────────────

/** A view as received over the wire: unbranded JSON. Only engine view() can mint PlayerView. */
export type PlayerViewWire = PlayerViewData;

/** Replaces PlayerView with PlayerViewWire in a server message. */
export type ReplaceView<M> = M extends unknown
  ? { readonly [K in keyof M]: M[K] extends PlayerView ? PlayerViewWire : M[K] extends PlayerView | null ? PlayerViewWire | null : M[K] }
  : never;

/** What clients parse. The server never constructs one; its sender takes ServerMsg only. */
export type ServerMsgWire = ReplaceView<ServerMsg>;
