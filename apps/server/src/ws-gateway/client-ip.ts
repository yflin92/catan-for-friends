// Client IP derivation for the P7 per-IP limits (design D11). The same function serves POST /api/rooms and the WS
// upgrade. The IP and its rate-limit key live only in memory (the limiter map) and are never logged, exported or
// persisted.
import type { IncomingMessage } from 'node:http';
import { BlockList, isIP } from 'node:net';

/** A parsed CIDR; null when the text is not one. */
export function parseCidr(text: string): { address: string; prefix: number; type: 'ipv4' | 'ipv6' } | null {
  const slash = text.indexOf('/');
  if (slash < 1 || slash !== text.lastIndexOf('/')) return null;
  const address = text.slice(0, slash);
  const bits = text.slice(slash + 1);
  const family = isIP(address);
  if (family === 0 || !/^\d{1,3}$/.test(bits)) return null;
  const prefix = Number(bits);
  if (prefix > (family === 4 ? 32 : 128)) return null;
  return { address, prefix, type: family === 4 ? 'ipv4' : 'ipv6' };
}

/** The trusted-proxy set from ops.trustedProxies. Every entry must already be a valid CIDR. */
export function trustedProxySet(cidrs: readonly string[]): BlockList {
  const list = new BlockList();
  for (const c of cidrs) {
    const p = parseCidr(c);
    if (!p) throw new Error('ops.trustedProxies: invalid CIDR');
    list.addSubnet(p.address, p.prefix, p.type);
  }
  return list;
}

/**
 * The client address:
 * - the socket peer (IPv4-mapped IPv6 normalised to IPv4) when the peer is not a trusted proxy;
 * - otherwise X-Forwarded-For walked right to left, skipping trusted entries; the first untrusted entry wins.
 * An absent or empty header, an unparseable entry, or an all-trusted chain yields the peer. `Forwarded` and
 * `X-Real-IP` are ignored.
 */
export function clientIp(req: IncomingMessage, trusted: BlockList): string {
  const peer = normalize(req.socket.remoteAddress ?? '');
  if (!isTrusted(peer, trusted)) return peer;
  const header = req.headers['x-forwarded-for'];
  if (header === undefined) return peer;
  const entries = (Array.isArray(header) ? header.join(',') : header).split(',').map((s) => normalize(s.trim()));
  if (entries.length === 0 || entries.some((e) => isIP(e) === 0)) return peer;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] ?? '';
    if (!isTrusted(e, trusted)) return e;
  }
  return peer;
}

/** The per-IP limiter key: the full IPv4 address, or the /64 prefix of an IPv6 address. */
export function rateLimitKey(ip: string): string {
  if (isIP(ip) !== 6) return ip;
  const groups = expandIpv6(ip);
  return groups ? `${groups.slice(0, 4).join(':')}::/64` : ip;
}

function isTrusted(ip: string, trusted: BlockList): boolean {
  const family = isIP(ip);
  return family !== 0 && trusted.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

function normalize(ip: string): string {
  const lower = ip.toLowerCase();
  return lower.startsWith('::ffff:') && isIP(lower.slice(7)) === 4 ? lower.slice(7) : ip;
}

/** The 8 hextet groups of an IPv6 address (zone id dropped, embedded IPv4 converted). */
function expandIpv6(ip: string): string[] | null {
  let s = ip.toLowerCase().split('%')[0] ?? '';
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4?.[1]) {
    const [a = 0, b = 0, c = 0, d = 0] = v4[1].split('.').map(Number);
    s = s.slice(0, -v4[1].length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', tail] = s.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = tail === undefined || tail === '' ? [] : tail.split(':');
  const missing = 8 - left.length - right.length;
  if (tail === undefined ? missing !== 0 : missing < 0) return null;
  return [...left, ...new Array<string>(Math.max(0, missing)).fill('0'), ...right].map((g) => (g || '0').padStart(4, '0'));
}
