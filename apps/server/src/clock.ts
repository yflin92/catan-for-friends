// Injectable time (design §3.12, ADR-0007, TH7). Every server component reads time and schedules work only through
// these interfaces, so tests can drive the lifecycle with FakeClock.advance(ms).

declare const timerHandleBrand: unique symbol;
/** Opaque handle returned by Scheduler.setTimeout / setInterval. */
export type TimerHandle = { readonly [timerHandleBrand]: true };

export interface Clock {
  /** Epoch milliseconds. */
  now(): number;
}

/** The largest delay a Scheduler accepts (Node's timer limit; larger values would fire at once). */
export const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/**
 * Every Scheduler implementation rejects a delay above MAX_TIMER_DELAY_MS with a RangeError (design D4), so a long
 * threshold can never wrap to an immediate fire. Long waits go through the periodic abandonment job instead.
 */
export interface Scheduler {
  setTimeout(fn: () => void, ms: number): TimerHandle;
  setInterval(fn: () => void, ms: number): TimerHandle;
  clear(h: TimerHandle): void;
}

/** Wall clock and Node timers; the production default. */
export class SystemClock implements Clock, Scheduler {
  now(): number {
    return Date.now();
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    return setTimeout(fn, checkDelay(ms)) as unknown as TimerHandle;
  }

  setInterval(fn: () => void, ms: number): TimerHandle {
    return setInterval(fn, checkDelay(ms)) as unknown as TimerHandle;
  }

  clear(h: TimerHandle): void {
    clearTimeout(h as unknown as NodeJS.Timeout);
  }
}

interface FakeTimer {
  readonly id: number;
  readonly fn: () => void;
  /** Re-arm period for intervals; null for one-shot timers. */
  readonly period: number | null;
  due: number;
  /** Tie-breaker among timers with the same due time: the order in which they were (re-)armed. */
  order: number;
}

/**
 * Deterministic clock and scheduler for tests (TH7). Time moves only through advance(ms):
 * - due timers fire in (due time, arming order) order, with now() set to each timer's due time while it runs;
 * - intervals re-arm at due + period; timers armed during advance fire in the same call if due ≤ the target;
 * - advance(0) fires timers that are already due;
 * - a throwing callback does not stop advance; the first error is re-thrown after advance completes (an
 *   AggregateError when several callbacks threw);
 * - afterwards now() = previous now() + ms.
 */
/**
 * Most timer callbacks one FakeClock.advance runs at a single instant. Beyond it, a callback is rescheduling itself with
 * zero delay, which would otherwise loop forever.
 */
export const FAKE_CLOCK_MAX_CALLBACKS_PER_INSTANT = 10_000;

export class FakeClock implements Clock, Scheduler {
  private current: number;
  private nextId = 1;
  private nextOrder = 1;
  private readonly timers = new Map<number, FakeTimer>();

  constructor(startMs: number) {
    this.current = startMs;
  }

  now(): number {
    return this.current;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    return this.arm(fn, checkDelay(ms), null);
  }

  setInterval(fn: () => void, ms: number): TimerHandle {
    // A zero period would re-fire forever within one advance; Node also clamps intervals to ≥ 1 ms.
    return this.arm(fn, ms, Math.max(1, sanitizeDelay(checkDelay(ms))));
  }

  clear(h: TimerHandle): void {
    this.timers.delete(h as unknown as number);
  }

  /** Number of armed timers; lets tests assert that components clean up after themselves. */
  pendingTimers(): number {
    return this.timers.size;
  }

  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError('FakeClock.advance(ms) needs a finite ms ≥ 0');
    const target = this.current + ms;
    const errors: unknown[] = [];
    let sameInstant = 0;
    for (let t = this.nextDue(target); t !== undefined; t = this.nextDue(target)) {
      sameInstant = t.due === this.current ? sameInstant + 1 : 1;
      if (sameInstant > FAKE_CLOCK_MAX_CALLBACKS_PER_INSTANT) {
        throw new RangeError(
          `FakeClock.advance: more than ${FAKE_CLOCK_MAX_CALLBACKS_PER_INSTANT} timer callbacks at t=${this.current} without time advancing; a callback keeps rescheduling itself with zero delay`,
        );
      }
      this.current = t.due;
      if (t.period === null) {
        this.timers.delete(t.id);
      } else {
        t.due += t.period;
        t.order = this.nextOrder++;
      }
      try {
        t.fn();
      } catch (err) {
        errors.push(err);
      }
    }
    this.current = target;
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, `${errors.length} timer callbacks threw during advance`);
  }

  private arm(fn: () => void, ms: number, period: number | null): TimerHandle {
    const id = this.nextId++;
    this.timers.set(id, { id, fn, period, due: this.current + (period ?? sanitizeDelay(ms)), order: this.nextOrder++ });
    return id as unknown as TimerHandle;
  }

  private nextDue(target: number): FakeTimer | undefined {
    let best: FakeTimer | undefined;
    for (const t of this.timers.values()) {
      if (t.due > target) continue;
      if (best === undefined || t.due < best.due || (t.due === best.due && t.order < best.order)) best = t;
    }
    return best;
  }
}

/** Returns `ms`, or throws a RangeError when it exceeds MAX_TIMER_DELAY_MS (+Infinity included). */
function checkDelay(ms: number): number {
  if (ms > MAX_TIMER_DELAY_MS) throw new RangeError(`timer delay exceeds ${MAX_TIMER_DELAY_MS} ms`);
  return ms;
}

function sanitizeDelay(ms: number): number {
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}
