// Client telemetry buffers and the G1 sample rules (design §2.4, §3.11; P9, NFR2, NFR6). Samples are clamped to the
// server limits and sent at most TELEMETRY_MAX_SAMPLES_PER_ARRAY per array per batch; the rest wait for the next batch.
import {
  TELEMETRY_ACTION_RTT_MS_MAX,
  TELEMETRY_ERROR_MESSAGE_MAX,
  TELEMETRY_MAX_SAMPLES_PER_ARRAY,
  TELEMETRY_RESUME_GAP_MS_MAX,
  type ClientErrorKind,
  type ResumeGapCause,
  type TelemetryMsg,
} from '@hexlands/protocol';

/** Removes anything that could carry a secret: URLs (with query and fragment), link fragments and token-shaped runs. */
export function sanitizeErrorMessage(message: string, href?: string): string {
  let m = message;
  if (href !== undefined && href !== '') m = m.split(href).join('<url>');
  m = m.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>]*/gi, '<url>');
  m = m.replace(/#(?:join|seat)=[^\s'"<>]*/gi, '<fragment>');
  m = m.replace(/\?[^\s'"<>]*=[^\s'"<>]*/g, '<query>');
  m = m.replace(/[A-Za-z0-9_-]{16,}/g, '<redacted>');
  return m.slice(0, TELEMETRY_ERROR_MESSAGE_MAX);
}

function clamp(n: number, max: number): number {
  return Math.min(max, Math.max(0, Math.round(n)));
}

export class TelemetryBuffer {
  private gaps: { ms: number; cause: ResumeGapCause }[] = [];
  private rtts: number[] = [];
  private errors: { kind: ClientErrorKind; message: string }[] = [];

  addResumeGap(ms: number, cause: ResumeGapCause): void {
    this.gaps.push({ ms: clamp(ms, TELEMETRY_RESUME_GAP_MS_MAX), cause });
  }

  addActionRtt(ms: number): void {
    this.rtts.push(clamp(ms, TELEMETRY_ACTION_RTT_MS_MAX));
  }

  addError(kind: ClientErrorKind, message: string, href?: string): void {
    this.errors.push({ kind, message: sanitizeErrorMessage(message, href) });
  }

  get isEmpty(): boolean {
    return this.gaps.length === 0 && this.rtts.length === 0 && this.errors.length === 0;
  }

  /** Removes and returns up to the per-array limit of each sample kind, or null when there is nothing to send. */
  takeBatch(): TelemetryMsg | null {
    if (this.isEmpty) return null;
    const n = TELEMETRY_MAX_SAMPLES_PER_ARRAY;
    const gaps = this.gaps.splice(0, n);
    const rtts = this.rtts.splice(0, n);
    const errors = this.errors.splice(0, n);
    return {
      t: 'telemetry',
      ...(gaps.length > 0 ? { resumeGaps: gaps } : {}),
      ...(rtts.length > 0 ? { actionRttMs: rtts } : {}),
      ...(errors.length > 0 ? { errors } : {}),
    };
  }
}

/**
 * Measures one resume gap: from transport loss to the welcome being applied, counting only time while the page is
 * visible and online.
 */
export class GapClock {
  private accumulated = 0;
  private runningSince: number | null = null;

  constructor(now: number, running: boolean) {
    this.runningSince = running ? now : null;
  }

  pause(now: number): void {
    if (this.runningSince !== null) {
      this.accumulated += now - this.runningSince;
      this.runningSince = null;
    }
  }

  resume(now: number): void {
    if (this.runningSince === null) this.runningSince = now;
  }

  elapsed(now: number): number {
    return this.accumulated + (this.runningSince !== null ? now - this.runningSince : 0);
  }
}
