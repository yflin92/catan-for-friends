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

  recordFailure(ip: string): void {
    let c = this.byIp.get(ip);
    if (!c) {
      c = new SlidingWindowCounter(this.clock, 60_000);
      this.byIp.set(ip, c);
    }
    c.hit();
  }
}
