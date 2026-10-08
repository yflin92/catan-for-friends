// X-load bot telemetry (AC32, Evolve review item 2): the same batches the web client sends (apps/web/src/telemetry.ts,
// ws-client.ts), so a load run feeds the production histograms catan.client.action_rtt and catan.ws.resume_gap.
// Samples are rounded and clamped to the protocol bounds; a batch carries at most TELEMETRY_MAX_SAMPLES_PER_ARRAY per
// array and omits empty arrays; leftovers wait for the next batch.
import {
  TELEMETRY_ACTION_RTT_MS_MAX,
  TELEMETRY_MAX_SAMPLES_PER_ARRAY,
  TELEMETRY_RESUME_GAP_MS_MAX,
  type ResumeGapCause,
  type TelemetryMsg,
} from '../../packages/protocol/src/index';

const clamp = (v: number, max: number): number => Math.min(max, Math.max(0, Math.round(v)));

export class TelemetryBuffer {
  private rtts: number[] = [];
  private gaps: { ms: number; cause: ResumeGapCause }[] = [];

  addActionRtt(ms: number): void {
    this.rtts.push(clamp(ms, TELEMETRY_ACTION_RTT_MS_MAX));
  }

  addResumeGap(ms: number, cause: ResumeGapCause): void {
    this.gaps.push({ ms: clamp(ms, TELEMETRY_RESUME_GAP_MS_MAX), cause });
  }

  get pending(): number {
    return this.rtts.length + this.gaps.length;
  }

  /** The next batch, or null when nothing is buffered. */
  takeBatch(): TelemetryMsg | null {
    if (this.pending === 0) return null;
    const rtts = this.rtts.splice(0, TELEMETRY_MAX_SAMPLES_PER_ARRAY);
    const gaps = this.gaps.splice(0, TELEMETRY_MAX_SAMPLES_PER_ARRAY);
    return {
      t: 'telemetry',
      ...(rtts.length > 0 ? { actionRttMs: rtts } : {}),
      ...(gaps.length > 0 ? { resumeGaps: gaps } : {}),
    };
  }
}
