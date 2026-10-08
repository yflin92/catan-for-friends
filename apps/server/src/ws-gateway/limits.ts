// Per-connection and per-IP limits of the WebSocket gateway (design §2.3, §7 F10/F11; P7, TH16). Every limit comes
// from ServerConfig and time from the injectable Clock.
import type { Clock } from '../clock';

/** Token bucket: `ratePerSec` tokens refill continuously up to `burst`; each message takes one. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly clock: Clock,
    private readonly ratePerSec: number,
    private readonly burst: number,
  ) {
    this.tokens = burst;
    this.last = clock.now();
  }

  /** Takes one token; false when the bucket is empty. */
  take(): boolean {
    const now = this.clock.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.ratePerSec);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/** Counts events in a sliding window of `windowMs`. */
export class SlidingWindowCounter {
  private readonly times: number[] = [];

  constructor(
    private readonly clock: Clock,
    private readonly windowMs: number,
  ) {}

  /** Records one event and returns the count inside the window, including it. */
  hit(): number {
    const now = this.clock.now();
    this.prune(now);
    this.times.push(now);
    return this.times.length;
  }

  count(): number {
    this.prune(this.clock.now());
    return this.times.length;
  }

  /** Milliseconds until the oldest hit in the window expires; 0 when the window is empty. */
  msUntilOldestExpires(): number {
    const now = this.clock.now();
    this.prune(now);
    const oldest = this.times[0];
    return oldest === undefined ? 0 : oldest + this.windowMs - now;
  }

  private prune(now: number): void {
    while (this.times.length > 0 && (this.times[0] ?? 0) <= now - this.windowMs) this.times.shift();
  }
}

/**
 * Failed room-code attempts per client IP (F11): at most `perMinute` failures in any 60 s; once reached, further
 * hellos from that IP are refused with rate_limited_auth until the window slides. Kept in memory only; IPs are never
 * logged or exported.
 */
export class FailedCodeLimiter {
  private readonly byIp = new Map<string, SlidingWindowCounter>();
  private nextSweep = 0;

  constructor(
    private readonly clock: Clock,
    private readonly perMinute: number,
  ) {}

  blocked(ip: string): boolean {
    const c = this.byIp.get(ip);
    if (!c) return false;
    const n = c.count();
    if (n === 0) this.byIp.delete(ip);
    return n >= this.perMinute;
  }

  /** Milliseconds until the oldest counted failure leaves the window; 0 when not blocked. */
  retryAfterMs(ip: string): number {
    if (!this.blocked(ip)) return 0;
    return this.byIp.get(ip)?.msUntilOldestExpires() ?? 0;
  }

  /** IPs currently held in memory. */
  get size(): number {
    return this.byIp.size;
  }

  recordFailure(ip: string): void {
    this.sweep();
    let c = this.byIp.get(ip);
    if (!c) {
      c = new SlidingWindowCounter(this.clock, 60_000);
      this.byIp.set(ip, c);
    }
    c.hit();
  }

  /** At most once per window, drops every IP with no failure left in it, so IPs that never return are not kept. */
  private sweep(): void {
    const now = this.clock.now();
    if (now < this.nextSweep) return;
    this.nextSweep = now + 60_000;
    for (const [ip, c] of this.byIp) if (c.count() === 0) this.byIp.delete(ip);
  }
}

/**
 * Successful room creates per client key in a sliding window (D13). Only creates that succeeded are recorded, so
 * retries after capacity_reached are never punished.
 */
export class CreateRateLimiter {
  private readonly byKey = new Map<string, number[]>();
  private nextSweep = 0;

  constructor(
    private readonly clock: Clock,
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Milliseconds until the key may create again; 0 when it may create now. */
  retryAfterMs(key: string): number {
    const now = this.clock.now();
    this.sweep(now);
    const times = (this.byKey.get(key) ?? []).filter((t) => t > now - this.windowMs);
    if (times.length === 0) this.byKey.delete(key);
    else this.byKey.set(key, times);
    if (times.length < this.limit) return 0;
    return (times[times.length - this.limit] ?? now) + this.windowMs - now;
  }

  record(key: string): void {
    const now = this.clock.now();
    this.sweep(now);
    const times = this.byKey.get(key) ?? [];
    times.push(now);
    this.byKey.set(key, times);
  }

  /** Keys currently held in memory. */
  get size(): number {
    return this.byKey.size;
  }

  /** At most once per window, drops every key whose newest create has left the window, so keys that never return are not kept. */
  private sweep(now: number): void {
    if (now < this.nextSweep) return;
    this.nextSweep = now + this.windowMs;
    for (const [key, times] of this.byKey) if ((times.at(-1) ?? -Infinity) <= now - this.windowMs) this.byKey.delete(key);
  }
}
