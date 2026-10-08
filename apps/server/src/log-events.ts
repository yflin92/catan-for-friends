// Structured events (design §9.5, D25): the closed catalogue of event names with their severity and fields, and the
// single emitting site of each. Every structured log line goes through logEvent, so names, severities and field shapes
// cannot drift between call sites; the Telemetry facade builds the body (required keys, redaction, forbidden keys).
import type { Seat } from '@hexlands/engine';
import type { ClientErrorKind, DisconnectReason, UnplannedCause } from '@hexlands/protocol';
import { serverMetrics } from './metrics';
import type { LogSeverity, Telemetry } from './telemetry';

type Opt<T> = T | undefined;

/** Event name → its event-specific fields. game_id and seat are §9.5 base fields, carried where they apply. */
export interface LogEventFields {
  // Turns and trades (RoomJournal).
  'turn.ended': {
    game_id: string;
    turn: number;
    seat: Seat;
    duration_s: number;
    actions: number;
    dice_total: number | null;
    reason: 'end_turn' | 'host_skip' | 'timer';
  };
  'trade.proposed': { game_id: string; trade_id: number; from_seat: Seat; give_count: number; get_count: number };
  'trade.resolved': {
    game_id: string;
    trade_id: number;
    outcome: 'confirmed' | 'cancelled' | 'replaced' | 'withdrawn';
    exit_to?: string | undefined;
    partner_seat: Seat | null;
    open_s: number | null;
  };
  // Players.
  'player.disconnected': { game_id: string; seat: Seat; reason: DisconnectReason; cause?: UnplannedCause | undefined; connected_s: number };
  'player.reconnected': {
    game_id?: string | undefined;
    seat?: Seat | null | undefined;
    outcome: 'resumed' | 'failed_auth' | 'failed_gone' | 'failed_error';
    gap_s?: number | null | undefined;
    seq_behind?: number | null | undefined;
  };
  // Rooms and games outside the lifecycle service.
  'room.create_rejected': { reason: string };
  'game.created': { game_id: string; player_slots: number; config: unknown };
  'game.started': { game_id: string; player_count: number; board_hash: string };
  'http.error': { error: string };
  // Actions and client.
  'action.rejected': { game_id?: string | undefined; seat?: Seat | null | undefined; reason_code: string; 'action.type': string };
  'action.error': {
    component: 'ws' | 'engine' | 'persist' | 'http' | 'job' | 'telemetry';
    game_id?: string | undefined;
    seq?: number | undefined;
    state_hash?: string | undefined;
    kind?: string | undefined;
    error?: string | undefined;
  };
  'client.error': { game_id?: string | undefined; seat?: Seat | null | undefined; kind: ClientErrorKind; message: string };
  // Game end (single site: gameEnded; the lifecycle service and the restart lost path call it).
  'game.ended': {
    game_id: string;
    outcome: 'finished' | 'expired' | 'lost';
    from_state: 'active' | 'abandoned' | 'lobby' | string;
    winner_seat: Seat | null;
    turns: number | null;
    active_play_s: number | null;
    wall_s: number | null;
    vp_by_seat: readonly number[] | null;
    seed: string | null;
  };
  'game.lost': { game_id: string; seq: number; expected: string | null; actual: string | null };
  'game.abandoned': { game_id: string; reason: string };
  'game.resumed': { game_id: string; reason: string; abandoned_s: number };
  'job.abandonment.error': { stage: 'game' | 'list_live' | 'list_terminal'; game_id?: string | undefined };
  // Server.
  'server.started': { games_restored: number; lost_on_restart: number; previous_shutdown: string };
  'server.draining': Record<string, never>;
  'server.stopped': { drain_ms: number; games_flushed: number };
  'deploy.forced': { active_games: number };
  'telemetry.flush_failed': { cause: string };
  'telemetry.gauge_failed': { gauge: string };
  'server.test_hooks_ignored': Record<string, never>;
  'server.static_dir_unset': Record<string, never>;
  'server.bundle_version_missing': Record<string, never>;
  'server.bundle_version_mismatch': Record<string, never>;
}

export type LogEventName = keyof LogEventFields;

export const LOG_EVENT_SEVERITY: Readonly<Record<LogEventName, LogSeverity>> = {
  'turn.ended': 'INFO',
  'trade.proposed': 'INFO',
  'trade.resolved': 'INFO',
  'player.disconnected': 'INFO',
  'player.reconnected': 'INFO',
  'room.create_rejected': 'INFO',
  'game.created': 'INFO',
  'game.started': 'INFO',
  'http.error': 'ERROR',
  'action.rejected': 'INFO',
  'action.error': 'ERROR',
  'client.error': 'WARN',
  'game.ended': 'INFO',
  'game.lost': 'ERROR',
  'game.abandoned': 'INFO',
  'game.resumed': 'INFO',
  'job.abandonment.error': 'ERROR',
  'server.started': 'INFO',
  'server.draining': 'INFO',
  'server.stopped': 'INFO',
  'deploy.forced': 'WARN',
  'telemetry.flush_failed': 'WARN',
  'telemetry.gauge_failed': 'WARN',
  'server.test_hooks_ignored': 'WARN',
  'server.static_dir_unset': 'WARN',
  'server.bundle_version_missing': 'WARN',
  'server.bundle_version_mismatch': 'ERROR',
};

/** Emits one catalogued event with its fixed severity. Never throws. */
export function logEvent<E extends LogEventName>(telemetry: Telemetry, event: E, fields: LogEventFields[E]): void {
  const defined: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields as Record<string, Opt<unknown>>)) if (v !== undefined) defined[k] = v;
  telemetry.log(LOG_EVENT_SEVERITY[event], event, defined);
}

/**
 * The one place a fault is reported (design §5.2 item 6, §9.2): catan.errors{component} plus an ERROR action.error
 * line with the identifiers needed to reproduce it. Never logs secrets, error messages or stacks.
 */
export function reportFault(telemetry: Telemetry, fields: LogEventFields['action.error']): void {
  serverMetrics(telemetry).errors.add(1, { component: fields.component });
  logEvent(telemetry, 'action.error', fields);
}

/** The one place player.reconnected is emitted (failed attempts from countReconnect, resumes from seatReconnected). */
export function playerReconnected(telemetry: Telemetry, fields: LogEventFields['player.reconnected']): void {
  logEvent(telemetry, 'player.reconnected', fields);
}

/** The one place game.ended is emitted (design §9.5, G3); `seed` is allowed in this event only. */
export function gameEnded(telemetry: Telemetry, fields: LogEventFields['game.ended']): void {
  logEvent(telemetry, 'game.ended', fields);
}
