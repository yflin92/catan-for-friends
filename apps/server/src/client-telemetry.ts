// Client telemetry ingestion (design §3.11, §9.2; P9, AC33). A batch {resumeGaps?, actionRttMs?, errors?} is a signal:
// it never gets an outcome or a seq and never touches game state. The schema already caps each array at
// TELEMETRY_MAX_SAMPLES_PER_ARRAY and each error message at TELEMETRY_ERROR_MESSAGE_MAX (a longer one arrives here as
// malformed). This module enforces one batch per
// TELEMETRY_MIN_BATCH_INTERVAL_MS per socket, clamps values, and records:
// - resumeGaps → catan.ws.resume_gap{cause} (seconds, clamped to 0–TELEMETRY_RESUME_GAP_MS_MAX), and per gap
//   catan.ws.resume_gap.reports{cause} plus catan.ws.resume_gap.within_target{cause} when it is shorter than
//   RESUME_GAP_TARGET_MS (the NFR6 gap SLI counters; the histogram feeds the p95 and distribution panels);
// - actionRttMs → catan.client.action_rtt (seconds, clamped to 0–TELEMETRY_ACTION_RTT_MS_MAX);
// - errors → catan.client.errors{kind} plus a client.error line (message capped, URLs removed).
// A malformed or too-frequent batch is dropped whole and counted once in catan.telemetry.dropped.
import {
  TELEMETRY_ACTION_RTT_MS_MAX,
  TELEMETRY_ERROR_MESSAGE_MAX,
  TELEMETRY_MIN_BATCH_INTERVAL_MS,
  TELEMETRY_RESUME_GAP_MS_MAX,
  type TelemetryMsg,
} from '@hexlands/protocol';
import type { Clock } from './clock';
import { logEvent } from './log-events';
import { serverMetrics } from './metrics';
import type { Telemetry } from './telemetry';
import type { Connection } from './ws-gateway';

/** Longest client error message kept in a client.error line: the schema's limit. */
export const CLIENT_ERROR_MESSAGE_MAX = TELEMETRY_ERROR_MESSAGE_MAX;

/** The NFR6 resume-gap target: a gap counts as within target when it is strictly shorter. */
export const RESUME_GAP_TARGET_MS = 5_000;

const clamp = (v: number, max: number): number => Math.min(max, Math.max(0, v));
const URLISH = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;

/** The client error message as logged: URLs replaced, then capped. */
export function sanitizeClientMessage(message: string): string {
  return message.replace(URLISH, '[url]').slice(0, CLIENT_ERROR_MESSAGE_MAX);
}

export class ClientTelemetry {
  private readonly lastBatchAt = new WeakMap<Connection, number>();

  constructor(
    private readonly telemetry: Telemetry,
    private readonly clock: Clock,
  ) {}

  /** A schema-valid batch from `conn`. */
  ingest(conn: Connection, msg: TelemetryMsg): void {
    const now = this.clock.now();
    const last = this.lastBatchAt.get(conn);
    if (last !== undefined && now - last < TELEMETRY_MIN_BATCH_INTERVAL_MS) {
      this.dropped();
      return;
    }
    this.lastBatchAt.set(conn, now);
    const m = serverMetrics(this.telemetry);
    for (const g of msg.resumeGaps ?? []) {
      const ms = clamp(g.ms, TELEMETRY_RESUME_GAP_MS_MAX);
      m.wsResumeGap.record(ms / 1000, { cause: g.cause });
      m.wsResumeGapReports.add(1, { cause: g.cause });
      if (ms < RESUME_GAP_TARGET_MS) m.wsResumeGapWithinTarget.add(1, { cause: g.cause });
    }
    for (const ms of msg.actionRttMs ?? []) m.clientActionRtt.record(clamp(ms, TELEMETRY_ACTION_RTT_MS_MAX) / 1000);
    const b = conn.binding;
    for (const e of msg.errors ?? []) {
      m.clientErrors.add(1, { kind: e.kind });
      logEvent(this.telemetry, 'client.error', {
        game_id: b?.gameId,
        seat: b?.seat,
        kind: e.kind,
        message: sanitizeClientMessage(e.message),
      });
    }
  }

  /** A malformed or rate-limited batch. */
  dropped(): void {
    serverMetrics(this.telemetry).telemetryDropped.add(1);
  }
}
