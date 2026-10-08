import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { FakeClock } from '../clock';
import { clientIp } from './client-ip';
import { classifyDisconnect, type DisconnectFacts } from './disconnect';
import { FailedCodeLimiter, SlidingWindowCounter, TokenBucket } from './limits';

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

describe('clientIp', () => {
  const req = (remoteAddress: string, xff?: string) =>
    ({ socket: { remoteAddress }, headers: xff === undefined ? {} : { 'x-forwarded-for': xff } }) as unknown as IncomingMessage;

  it('uses the peer address for public peers and ignores their X-Forwarded-For', () => {
    expect(clientIp(req('203.0.113.9', '1.1.1.1'))).toBe('203.0.113.9');
    expect(clientIp(req('::ffff:203.0.113.9'))).toBe('203.0.113.9');
  });

  it('uses the last X-Forwarded-For hop behind a loopback or private proxy', () => {
    expect(clientIp(req('127.0.0.1', '9.9.9.9, 198.51.100.7'))).toBe('198.51.100.7');
    expect(clientIp(req('172.18.0.3', '198.51.100.7'))).toBe('198.51.100.7');
    expect(clientIp(req('::1', 'not-an-ip'))).toBe('::1');
    expect(clientIp(req('10.0.0.2'))).toBe('10.0.0.2');
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
