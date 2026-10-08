import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { FakeClock } from '../clock';
import { DEFAULT_SERVER_CONFIG } from '@hexlands/engine';
import { clientIp, parseCidr, rateLimitKey, trustedProxySet } from './client-ip';
import { classifyDisconnect, type DisconnectFacts } from './disconnect';
import { CreateRateLimiter, FailedCodeLimiter, SlidingWindowCounter, TokenBucket } from './limits';

describe('TokenBucket (P7 per-connection rate, TH16)', () => {
  it('allows a burst, then refills at the configured rate', () => {
    const c = new FakeClock(0);
    const b = new TokenBucket(c, 20, 40);
    for (let i = 0; i < 40; i++) expect(b.take()).toBe(true);
    expect(b.take()).toBe(false);
    c.advance(50);
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(false);
    c.advance(10_000);
    for (let i = 0; i < 40; i++) expect(b.take()).toBe(true);
    expect(b.take()).toBe(false);
  });
});

describe('SlidingWindowCounter', () => {
  it('counts hits inside the window only', () => {
    const c = new FakeClock(0);
    const w = new SlidingWindowCounter(c, 60_000);
    expect(w.hit()).toBe(1);
    c.advance(30_000);
    expect(w.hit()).toBe(2);
    c.advance(30_000);
    expect(w.count()).toBe(1);
    c.advance(30_000);
    expect(w.count()).toBe(0);
  });
});

describe('CreateRateLimiter (D13)', () => {
  it('reports the wait until the oldest counted create leaves the window', () => {
    const c = new FakeClock(0);
    const l = new CreateRateLimiter(c, 2, 3_600_000);
    expect(l.retryAfterMs('k')).toBe(0);
    l.record('k');
    c.advance(1_000);
    l.record('k');
    expect(l.retryAfterMs('k')).toBe(3_599_000);
    expect(l.retryAfterMs('other')).toBe(0);
    c.advance(3_599_000);
    expect(l.retryAfterMs('k')).toBe(0);
  });
});

describe('limiter memory is bounded (S-HARD c1)', () => {
  it('CreateRateLimiter drops keys that never return once their creates have left the window', () => {
    const c = new FakeClock(0);
    const l = new CreateRateLimiter(c, 6, 3_600_000);
    for (let i = 0; i < 500; i++) l.record(`ip-${i}`);
    expect(l.size).toBe(500);
    c.advance(3_600_000);
    l.record('fresh');
    expect(l.size).toBe(1);
    expect(l.retryAfterMs('fresh')).toBe(0);
  });

  it('a key still inside the window survives the sweep and keeps its count', () => {
    const c = new FakeClock(0);
    const l = new CreateRateLimiter(c, 2, 3_600_000);
    l.record('old');
    c.advance(1_800_000);
    l.record('k');
    l.record('k');
    c.advance(1_800_000);
    l.record('trigger');
    expect(l.size).toBe(2);
    expect(l.retryAfterMs('k')).toBe(1_800_000);
  });

  it('FailedCodeLimiter drops IPs whose failures have all left the minute', () => {
    const c = new FakeClock(0);
    const l = new FailedCodeLimiter(c, 3);
    for (let i = 0; i < 500; i++) l.recordFailure(`ip-${i}`);
    expect(l.size).toBe(500);
    c.advance(60_000);
    l.recordFailure('fresh');
    expect(l.size).toBe(1);
    expect(l.blocked('fresh')).toBe(false);
  });
});

describe('FailedCodeLimiter (F11)', () => {
  it('blocks an IP after the configured failures per minute, per IP, until the window slides', () => {
    const c = new FakeClock(0);
    const l = new FailedCodeLimiter(c, 3);
    for (let i = 0; i < 3; i++) {
      expect(l.blocked('1.2.3.4')).toBe(false);
      l.recordFailure('1.2.3.4');
    }
    expect(l.blocked('1.2.3.4')).toBe(true);
    expect(l.blocked('5.6.7.8')).toBe(false);
    c.advance(60_000);
    expect(l.blocked('1.2.3.4')).toBe(false);
  });
});

describe('clientIp and rateLimitKey (D11)', () => {
  const trusted = trustedProxySet(DEFAULT_SERVER_CONFIG.ops.trustedProxies);
  const req = (remoteAddress: string, xff?: string | string[]) =>
    ({ socket: { remoteAddress }, headers: xff === undefined ? {} : { 'x-forwarded-for': xff } }) as unknown as IncomingMessage;

  it('uses an untrusted peer and ignores its X-Forwarded-For', () => {
    expect(clientIp(req('203.0.113.9', '1.1.1.1'), trusted)).toBe('203.0.113.9');
  });

  it('uses the client from X-Forwarded-For behind a trusted peer', () => {
    expect(clientIp(req('172.18.0.3', '198.51.100.7'), trusted)).toBe('198.51.100.7');
    expect(clientIp(req('127.0.0.1', ['9.9.9.9', '198.51.100.7']), trusted)).toBe('198.51.100.7');
  });

  it('walks right to left, skipping trusted hops', () => {
    expect(clientIp(req('127.0.0.1', 'spoof.example, 198.51.100.7, 10.0.0.5'), trusted)).toBe('127.0.0.1');
    expect(clientIp(req('127.0.0.1', '6.6.6.6, 198.51.100.7, 10.0.0.5'), trusted)).toBe('198.51.100.7');
    expect(clientIp(req('127.0.0.1', '10.0.0.9, 10.0.0.5'), trusted)).toBe('127.0.0.1');
  });

  it('falls back to the peer on a malformed or empty header', () => {
    expect(clientIp(req('10.0.0.2', 'not-an-ip'), trusted)).toBe('10.0.0.2');
    expect(clientIp(req('10.0.0.2', '198.51.100.7,,'), trusted)).toBe('10.0.0.2');
    expect(clientIp(req('10.0.0.2', ''), trusted)).toBe('10.0.0.2');
    expect(clientIp(req('10.0.0.2'), trusted)).toBe('10.0.0.2');
  });

  it('normalises IPv4-mapped IPv6 addresses', () => {
    expect(clientIp(req('::ffff:203.0.113.9'), trusted)).toBe('203.0.113.9');
    expect(clientIp(req('::FFFF:127.0.0.1', '::ffff:198.51.100.7'), trusted)).toBe('198.51.100.7');
  });

  it('ignores Forwarded and X-Real-IP', () => {
    const r = { socket: { remoteAddress: '127.0.0.1' }, headers: { forwarded: 'for=1.2.3.4', 'x-real-ip': '1.2.3.4' } };
    expect(clientIp(r as unknown as IncomingMessage, trusted)).toBe('127.0.0.1');
  });

  it('never trusts X-Forwarded-For with trustedProxies = []', () => {
    expect(clientIp(req('127.0.0.1', '198.51.100.7'), trustedProxySet([]))).toBe('127.0.0.1');
  });

  it('keys IPv4 by address and IPv6 by /64 prefix', () => {
    expect(rateLimitKey('198.51.100.7')).toBe('198.51.100.7');
    expect(rateLimitKey('2001:db8:1:2:aaaa::1')).toBe(rateLimitKey('2001:db8:1:2:bbbb:cccc:dddd:eeee'));
    expect(rateLimitKey('2001:db8:1:2::1')).toBe('2001:0db8:0001:0002::/64');
    expect(rateLimitKey('2001:db8:1:3::1')).not.toBe(rateLimitKey('2001:db8:1:2::1'));
    expect(rateLimitKey('::1')).toBe('0000:0000:0000:0000::/64');
    expect(rateLimitKey('64:ff9b::192.0.2.1')).toBe('0064:ff9b:0000:0000::/64');
  });

  it('parses CIDRs strictly', () => {
    expect(parseCidr('10.0.0.0/8')).toEqual({ address: '10.0.0.0', prefix: 8, type: 'ipv4' });
    expect(parseCidr('fc00::/7')).toEqual({ address: 'fc00::', prefix: 7, type: 'ipv6' });
    for (const bad of ['10.0.0.0', '10.0.0.0/33', '::/129', 'x/8', '10.0.0.0/8/1', '/8', '10.0.0.0/-1']) expect(parseCidr(bad)).toBeNull();
  });
});

describe('classifyDisconnect (design §9.4)', () => {
  const base: DisconnectFacts = { serverCause: null, code: 1006, hiddenSince: null, now: 100_000, backgroundGraceMs: 60_000 };
  it.each([
    ['server drain 1012', { serverCause: 'drain', code: 1012 }, { reason: 'server_restart' }],
    ['1012 observed', { code: 1012 }, { reason: 'server_restart' }],
    ['superseded 4001', { serverCause: 'superseded', code: 4001 }, { reason: 'superseded' }],
    ['revoked 4401', { serverCause: 'revoked', code: 4401 }, { reason: 'superseded' }],
    ['drop within grace after hidden', { hiddenSince: 50_000 }, { reason: 'client_backgrounded' }],
    ['drop after grace after hidden', { hiddenSince: 10_000 }, { reason: 'unplanned', cause: 'abnormal_close' }],
    ['client close 1000', { code: 1000 }, { reason: 'client_closed' }],
    ['client close 1001', { code: 1001 }, { reason: 'client_closed' }],
    ['heartbeat timeout', { serverCause: 'heartbeat_timeout', code: 4408 }, { reason: 'unplanned', cause: 'heartbeat_timeout' }],
    ['backpressure', { serverCause: 'backpressure', code: 1008 }, { reason: 'unplanned', cause: 'backpressure' }],
    ['abnormal 1006', {}, { reason: 'unplanned', cause: 'abnormal_close' }],
  ] as const)('%s', (_n, over, expected) => {
    expect(classifyDisconnect({ ...base, ...over })).toEqual(expected);
  });

  it('a backgrounded drop beats a client close and a heartbeat timeout', () => {
    expect(classifyDisconnect({ ...base, hiddenSince: 90_000, code: 1000 })).toEqual({ reason: 'client_backgrounded' });
    expect(classifyDisconnect({ ...base, hiddenSince: 90_000, serverCause: 'heartbeat_timeout' })).toEqual({
      reason: 'client_backgrounded',
    });
  });
});
