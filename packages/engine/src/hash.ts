// Canonical serialization and hashing (design §3.4, TH3, TH15).
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { GameState } from './state';
import type { PlayerViewData } from './view';

/**
 * The one canonical JSON serializer: object keys sorted by UTF-16 code unit, no whitespace, integers only.
 * Throws a TypeError on anything that is not plain JSON data: non-integer or non-finite numbers, undefined (as a value
 * or array element), functions, symbols, bigints, and objects whose prototype is not Object.prototype or null
 * (Map, Set, Date, class instances).
 */
export function canonicalJson(x: unknown): string {
  return write(x, '$');
}

function write(x: unknown, path: string): string {
  switch (typeof x) {
    case 'string':
      return JSON.stringify(x);
    case 'boolean':
      return x ? 'true' : 'false';
    case 'number':
      if (!Number.isSafeInteger(x)) throw new TypeError(`canonicalJson: ${path} is not a safe integer (${x})`);
      return Object.is(x, -0) ? '0' : String(x);
    case 'object': {
      if (x === null) return 'null';
      if (Array.isArray(x)) {
        const parts: string[] = [];
        for (let i = 0; i < x.length; i++) {
          if (!(i in x) || x[i] === undefined) throw new TypeError(`canonicalJson: ${path}[${i}] is undefined`);
          parts.push(write(x[i], `${path}[${i}]`));
        }
        return `[${parts.join(',')}]`;
      }
      const proto: unknown = Object.getPrototypeOf(x);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError(`canonicalJson: ${path} is not a plain object`);
      }
      const rec = x as Record<string, unknown>;
      const keys = Object.keys(rec).sort();
      const parts: string[] = [];
      for (const k of keys) {
        const v = rec[k];
        if (v === undefined) throw new TypeError(`canonicalJson: ${path}.${k} is undefined`);
        parts.push(`${JSON.stringify(k)}:${write(v, `${path}.${k}`)}`);
      }
      return `{${parts.join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalJson: ${path} has unsupported type ${typeof x}`);
  }
}

/** Lowercase hex SHA-256 of the UTF-8 bytes of s. */
export function sha256Hex(s: string): string {
  return bytesToHex(sha256(utf8ToBytes(s)));
}

export function serializeState(state: GameState): string {
  return canonicalJson(state);
}

const STATE_KEYS: readonly (keyof GameState)[] = [
  'schemaVersion', 'config', 'playerCount', 'board', 'robber', 'pieces', 'players', 'bank', 'devDeck', 'turn', 'phase',
  'trade', 'nextTradeId', 'awards', 'rng', 'log', 'logCounter',
];

/**
 * Parses a serialized state. Fails on invalid JSON, a non-object, an unknown schemaVersion, missing or unknown
 * top-level keys, or content that canonicalJson rejects. Deeper structure is not validated here.
 */
export function deserializeState(json: string): { ok: true; state: GameState } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${(e as Error).message}` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'state is not an object' };
  }
  const rec = parsed as Record<string, unknown>;
  if (rec['schemaVersion'] !== 1) {
    return { ok: false, error: `unsupported schemaVersion: ${JSON.stringify(rec['schemaVersion'])}` };
  }
  const missing = STATE_KEYS.filter((k) => !(k in rec));
  if (missing.length > 0) return { ok: false, error: `missing keys: ${missing.join(', ')}` };
  const unknown = Object.keys(rec).filter((k) => !(STATE_KEYS as readonly string[]).includes(k));
  if (unknown.length > 0) return { ok: false, error: `unknown keys: ${unknown.join(', ')}` };
  try {
    canonicalJson(rec);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  return { ok: true, state: parsed as GameState };
}

/** Lowercase hex SHA-256 of utf8(serializeState(state)). */
export function stateHash(state: GameState): string {
  return sha256Hex(serializeState(state));
}

/** Lowercase hex SHA-256 of utf8(canonicalJson(view)) (TH15). Takes the unbranded data so clients holding a
 *  PlayerViewWire can hash it; a branded PlayerView is accepted as-is. */
export function viewHash(v: PlayerViewData): string {
  return sha256Hex(canonicalJson(v));
}
