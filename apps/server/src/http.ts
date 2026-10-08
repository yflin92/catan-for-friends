// HTTP surface (design §2.3, §5.1(1), §8, §9.6): GET /healthz, POST /api/rooms and the static web bundle.
// Every response carries X-Robots-Tag: noindex and Referrer-Policy: no-referrer; HTML also carries the CSP. There is
// no access log and no cookie. Secrets (room code, seat token) travel only in the POST response body.
import { timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { HttpReasonCode } from '@hexlands/protocol';
import { z } from 'zod';
import { normalizeDisplayName } from './names';
import type { RoomManager } from './room-manager';
import type { ServerContext } from './server';
import { clientIp, rateLimitKey, trustedProxySet } from './ws-gateway/client-ip';
import type { CreateRateLimiter, FailedCodeLimiter } from './ws-gateway/limits';

/** Largest accepted POST /api/rooms body. */
export const MAX_CREATE_BODY_BYTES = 4 * 1024;

/** Per-client limits shared with the WS gateway (D11, D13). */
export interface HttpLimits {
  /** Failed room codes and passphrases (rooms.failedCodeAttemptsPerIpPerMin). */
  readonly failedCodes: FailedCodeLimiter;
  /** Successful creates (rooms.createsPerIpPerHour). */
  readonly creates: CreateRateLimiter;
}

/** Content-hashed bundle files (name-<hash>.ext) are cached for a year; everything else revalidates. */
const HASHED_ASSET = /-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/;

/** Live values reported by /healthz that other components own. */
export interface HealthSource {
  draining(): boolean;
  playersConnected(): number;
  /** Epoch ms of the last successful commit or snapshot; null before the first one. */
  lastPersistOkAt(): number | null;
  /** Epoch ms of the last successful abandonment-job run; null before the first one. */
  abandonmentJobLastSuccessAt(): number | null;
}

const createBodySchema = z.strictObject({
  displayName: z.string(),
  // Q9 gate input; checked only when rooms.createPassphrase is set (X-pass).
  passphrase: z.string().exactOptional(),
});

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export function createHttpHandler(
  ctx: ServerContext,
  rooms: RoomManager,
  health: HealthSource,
  startedAt: number,
  limits: HttpLimits,
): (req: IncomingMessage, res: ServerResponse) => void {
  const { telemetry } = ctx;
  const trusted = trustedProxySet(ctx.config.ops.trustedProxies);
  const creates = telemetry.counter('catan.rooms.creates', {
    description: 'POST /api/rooms results',
    labels: { result: ['ok', 'capacity_reached', 'rate_limited', 'rate_limited_auth', 'bad_passphrase'] },
  });
  const http5xx = telemetry.counter('catan.http.responses_5xx', { description: 'non-drain HTTP 5xx responses' });
  const errors = telemetry.counter('catan.errors', {
    description: 'unhandled faults',
    labels: { component: ['ws', 'engine', 'persist', 'http', 'job', 'telemetry'] },
  });

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = requestPath(req);
    if (url === '/healthz') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { reasonCode: 'malformed_action' });
      return healthz(res);
    }
    if (url === '/api/rooms') {
      if (req.method !== 'POST') return sendJson(res, 405, { reasonCode: 'malformed_action' });
      return createRoom(req, res);
    }
    if (url.startsWith('/api/')) return sendJson(res, 404, { reasonCode: 'malformed_action' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendEmpty(res, 405);
    return serveStatic(req, res, url);
  }

  function healthz(res: ServerResponse): void {
    // The only 503 /healthz ever returns; it reads nothing from the store, which closes during the drain (design §9.6).
    if (health.draining()) return sendJson(res, 503, { status: 'draining' });
    const now = ctx.clock.now();
    const ago = (t: number | null) => (t === null ? null : Math.max(0, Math.round((now - t) / 1000)));
    sendJson(res, 200, {
      status: 'ok',
      version: ctx.buildVersion,
      uptime_s: Math.max(0, Math.round((now - startedAt) / 1000)),
      draining: health.draining(),
      games: rooms.countByState(),
      players_connected: health.playersConnected(),
      last_persist_ok_s_ago: ago(health.lastPersistOkAt()),
      abandonment_job_last_success_s_ago: ago(health.abandonmentJobLastSuccessAt()),
    });
  }

  /** POST /api/rooms in the D13 precedence order. */
  async function createRoom(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reject = (status: number, reasonCode: HttpReasonCode) => sendJson(res, status, { reasonCode });
    const rejectCounted = (
      status: number,
      reasonCode: 'capacity_reached' | 'rate_limited' | 'rate_limited_auth' | 'bad_passphrase',
    ) => {
      creates.add(1, { result: reasonCode });
      telemetry.log('INFO', 'room.create_rejected', { reason: reasonCode });
      reject(status, reasonCode);
    };
    // 1. Draining: 503, never counted as a server error.
    if (health.draining()) return sendEmpty(res, 503);
    // 2. Malformed body.
    if (!isJson(req)) return reject(400, 'malformed_action');
    const raw = await readBody(req, MAX_CREATE_BODY_BYTES);
    if (raw === null) return reject(400, 'malformed_action');
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return reject(400, 'malformed_action');
    }
    const body = createBodySchema.safeParse(json);
    if (!body.success) return reject(400, 'malformed_action');
    const key = rateLimitKey(clientIp(req, trusted));
    const passphrase = ctx.config.rooms.createPassphrase;
    // 3. Failed-attempt limit, shared with WS room-code failures; applies with or without a passphrase (D15). The
    //    refusal itself is not counted as a failure.
    const lockedMs = limits.failedCodes.retryAfterMs(key);
    if (lockedMs > 0) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil(lockedMs / 1000))));
      return rejectCounted(429, 'rate_limited_auth');
    }
    // 4. Passphrase gate (Q9), only when configured; every wrong passphrase counts as a failed attempt.
    if (passphrase !== null && !passphraseMatches(body.data.passphrase, passphrase)) {
      limits.failedCodes.recordFailure(key);
      return rejectCounted(403, 'bad_passphrase');
    }
    // 5. Create-rate limit (successful creates only).
    const waitMs = limits.creates.retryAfterMs(key);
    if (waitMs > 0) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil(waitMs / 1000))));
      return rejectCounted(429, 'rate_limited');
    }
    // 6. Display name.
    const name = normalizeDisplayName(body.data.displayName);
    if (name === null) return reject(400, 'invalid_name');
    // 7. Capacity; 8. create.
    const result = rooms.createRoom(name);
    if (!result.ok) return rejectCounted(409, result.reasonCode);
    limits.creates.record(key);
    creates.add(1, { result: 'ok' });
    telemetry.log('INFO', 'game.created', { game_id: result.gameId, player_slots: 4, config: result.config });
    sendJson(res, 201, { roomCode: result.roomCode, seatToken: result.seatToken, seat: result.seat });
  }

  async function serveStatic(req: IncomingMessage, res: ServerResponse, url: string): Promise<void> {
    const root = ctx.staticDir;
    if (root === null) return sendEmpty(res, 404);
    let rel: string;
    try {
      rel = decodeURIComponent(url);
    } catch {
      return sendEmpty(res, 400);
    }
    if (rel.endsWith('/')) rel += 'index.html';
    const resolved = path.resolve(root, `.${rel}`);
    if (!resolved.startsWith(root + path.sep)) return sendEmpty(res, 404);
    // realpath defeats symlinks that point outside the bundle; directories are never listed.
    const file = await realpath(resolved).catch(() => null);
    if (file === null || !file.startsWith(root + path.sep)) return sendEmpty(res, 404);
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) return sendEmpty(res, 404);
    const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    res.statusCode = 200;
    baseHeaders(res);
    res.setHeader('Content-Type', type);
    res.setHeader('Content-Length', info.size);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (type.startsWith('text/html')) res.setHeader('Content-Security-Policy', contentSecurityPolicy(req));
    res.setHeader('Cache-Control', HASHED_ASSET.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache');
    if (req.method === 'HEAD') return void res.end();
    await new Promise<void>((resolve) => {
      const s = createReadStream(file);
      s.on('error', () => {
        res.destroy();
        resolve();
      });
      s.on('end', resolve);
      s.pipe(res);
    });
  }

  return (req, res) => {
    route(req, res).catch((err: unknown) => {
      errors.add(1, { component: 'http' });
      http5xx.add(1);
      telemetry.log('ERROR', 'http.error', { error: err instanceof Error ? err.name : 'unknown' });
      if (!res.headersSent) sendEmpty(res, 500);
      else res.destroy();
    });
  };
}

/** CSP from design §8: default-src 'self'; connect-src 'self' wss://<host>; img-src 'self' data:. */
export function contentSecurityPolicy(req: IncomingMessage): string {
  const host = req.headers.host ?? '';
  const wss = /^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(host) ? ` wss://${host}` : '';
  return `default-src 'self'; connect-src 'self'${wss}; img-src 'self' data:`;
}

function baseHeaders(res: ServerResponse): void {
  res.setHeader('X-Robots-Tag', 'noindex');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.statusCode = status;
  baseHeaders(res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Length', Buffer.byteLength(text));
  res.end(text);
}

function sendEmpty(res: ServerResponse, status: number): void {
  res.statusCode = status;
  baseHeaders(res);
  res.setHeader('Content-Length', 0);
  res.end();
}

function passphraseMatches(given: string | undefined, expected: string): boolean {
  if (given === undefined) return false;
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function isJson(req: IncomingMessage): boolean {
  return (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() === 'application/json';
}

/** The body as UTF-8, or null when it exceeds `limit` bytes. */
function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) over = true;
      else chunks.push(c);
    });
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function requestPath(req: IncomingMessage): string {
  const url = req.url ?? '/';
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}
