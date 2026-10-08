// Client IP for the per-IP failed room-code limit (F11). The value is used only as an in-memory map key and is never
// logged or exported.
import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';

/**
 * The peer address, or — when the peer is a loopback or private address (the Caddy reverse proxy) — the last entry
 * of X-Forwarded-For, which that proxy appends. A public peer's X-Forwarded-For is ignored.
 */
export function clientIp(req: IncomingMessage): string {
  const peer = normalize(req.socket.remoteAddress ?? '');
  const xff = req.headers['x-forwarded-for'];
  if (!isTrustedProxy(peer) || xff === undefined) return peer;
  const last = (Array.isArray(xff) ? xff.join(',') : xff).split(',').map((s) => s.trim()).filter(Boolean).at(-1);
  return last !== undefined && isIP(normalize(last)) !== 0 ? normalize(last) : peer;
}

function normalize(ip: string): string {
  return ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
}

function isTrustedProxy(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a = 0, b = 0] = ip.split('.').map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  const v6 = ip.toLowerCase();
  return v6 === '::1' || v6.startsWith('fc') || v6.startsWith('fd');
}
