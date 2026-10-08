// Test-only helpers for @hexlands/server (TH7, TH9, TH12). Production modules under apps/server/src must not import
// this entry (dependency-cruiser rule no-server-testing-in-prod).
import { performFault, type FaultAction, type FaultContext, type FaultPoint, type FaultPoints } from '../faults';
import type { SecretKind, SecretRegistry } from '../secrets';

export { FakeClock } from '../clock';

export interface ArmOptions {
  /** Fire only for this game. */
  readonly gameId?: string;
  /** Fire only at this seq. */
  readonly seq?: number;
  /** How many matching hits fire before the arming is spent; default 1. Infinity keeps it armed until disarm(). */
  readonly times?: number;
}

/** A FaultPoints implementation that tests arm per point; every hit is recorded, armed or not. */
export class ArmableFaults implements FaultPoints {
  private readonly armed: { point: FaultPoint; action: FaultAction; gameId?: string; seq?: number; remaining: number }[] = [];
  private readonly log: { readonly point: FaultPoint; readonly gameId: string; readonly seq: number }[] = [];

  arm(point: FaultPoint, action: FaultAction, opts: ArmOptions = {}): this {
    this.armed.push({
      point,
      action,
      ...(opts.gameId !== undefined ? { gameId: opts.gameId } : {}),
      ...(opts.seq !== undefined ? { seq: opts.seq } : {}),
      remaining: opts.times ?? 1,
    });
    return this;
  }

  /** Removes armings for one point, or all of them. */
  disarm(point?: FaultPoint): void {
    for (let i = this.armed.length - 1; i >= 0; i--) {
      if (point === undefined || this.armed[i]?.point === point) this.armed.splice(i, 1);
    }
  }

  /** Every hit seen so far, in order. */
  hits(): readonly { readonly point: FaultPoint; readonly gameId: string; readonly seq: number }[] {
    return [...this.log];
  }

  hit(point: FaultPoint, ctx: FaultContext): void {
    this.log.push({ point, gameId: ctx.gameId, seq: ctx.seq });
    const idx = this.armed.findIndex(
      (a) =>
        a.point === point &&
        a.remaining > 0 &&
        (a.gameId === undefined || a.gameId === ctx.gameId) &&
        (a.seq === undefined || a.seq === ctx.seq),
    );
    const arming = this.armed[idx];
    if (arming === undefined) return;
    arming.remaining -= 1;
    if (arming.remaining <= 0) this.armed.splice(idx, 1);
    performFault(point, arming.action);
  }
}

/** A SecretRegistry that keeps every minted value so tests can scan output for them (AC30). */
export class RecordingSecrets implements SecretRegistry {
  private readonly values: { readonly kind: SecretKind; readonly value: string }[] = [];

  record(kind: SecretKind, value: string): void {
    this.values.push({ kind, value });
  }

  all(): readonly { readonly kind: SecretKind; readonly value: string }[] {
    return [...this.values];
  }

  /** The recorded values of one kind, or of every kind. */
  valuesOf(kind?: SecretKind): readonly string[] {
    return this.values.filter((v) => kind === undefined || v.kind === kind).map((v) => v.value);
  }
}
