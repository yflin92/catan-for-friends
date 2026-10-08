// Fragment-link handling (design §2.4, ADR-0006, P8). Invite and rejoin links carry their secrets only in the URL
// fragment; this module moves them into localStorage and strips the fragment from the address bar. Fragment
// contents are never logged or sent anywhere.

/** Credentials for one room as stored under {@link seatStorageKey}. A pure invite carries no seat token. */
export interface SeatCredentials {
  readonly roomCode: string;
  readonly seatToken?: string;
}

export type FragmentLink =
  | { readonly kind: 'join'; readonly roomCode: string }
  | { readonly kind: 'seat'; readonly roomCode: string; readonly seatToken: string };

const ROOM_CODE_RE = /^[23456789A-HJ-NP-Z]{4,16}$/;
const SEAT_TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;

export function seatStorageKey(roomCode: string): string {
  return `hexlands.seat.${roomCode}`;
}

/**
 * Canonical wire form of a room code: separators (hyphen, spaces) removed and upper-cased, so "abc-def" and
 * "ABC DEF" both become "ABCDEF". Returns null when the result is not a plausible room code.
 */
export function normalizeRoomCode(input: string): string | null {
  const code = input.replace(/[\s-]/g, '').toUpperCase();
  return ROOM_CODE_RE.test(code) ? code : null;
}

/**
 * Parses `#join=<ROOMCODE>` or `#seat=<ROOMCODE>.<SEATTOKEN>`. Returns null for any other fragment, including a
 * malformed join/seat fragment.
 */
export function parseFragment(hash: string): FragmentLink | null {
  const body = hash.startsWith('#') ? hash.slice(1) : hash;
  const eq = body.indexOf('=');
  if (eq === -1) return null;
  const key = body.slice(0, eq);
  const value = body.slice(eq + 1);
  if (key === 'join') {
    const roomCode = normalizeRoomCode(value);
    return roomCode === null ? null : { kind: 'join', roomCode };
  }
  if (key === 'seat') {
    const dot = value.indexOf('.');
    if (dot === -1) return null;
    const roomCode = normalizeRoomCode(value.slice(0, dot));
    const seatToken = value.slice(dot + 1);
    if (roomCode === null || !SEAT_TOKEN_RE.test(seatToken)) return null;
    return { kind: 'seat', roomCode, seatToken };
  }
  return null;
}

/** True when the fragment uses one of the secret-bearing keys, whether or not its value is well formed. */
function isSecretFragment(hash: string): boolean {
  return /^#?(join|seat)=/.test(hash);
}

export function readCredentials(storage: Pick<Storage, 'getItem'>, roomCode: string): SeatCredentials | null {
  const raw = storage.getItem(seatStorageKey(roomCode));
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { roomCode: code, seatToken } = parsed as Record<string, unknown>;
    if (code !== roomCode) return null;
    return typeof seatToken === 'string' ? { roomCode, seatToken } : { roomCode };
  } catch {
    return null;
  }
}

export function writeCredentials(storage: Pick<Storage, 'setItem'>, creds: SeatCredentials): void {
  storage.setItem(seatStorageKey(creds.roomCode), JSON.stringify(creds));
}

export interface FragmentEnv {
  readonly location: Pick<Location, 'hash' | 'pathname' | 'search'>;
  readonly history: Pick<History, 'replaceState' | 'state'>;
  readonly storage: Pick<Storage, 'getItem' | 'setItem'>;
}

/**
 * Consumes a join/seat fragment from the current URL:
 * - `#seat=` stores {roomCode, seatToken}, replacing any stored token for that room.
 * - `#join=` stores {roomCode} only when nothing is stored for that room yet, so an invite link never discards a
 *   seat the browser already holds.
 * - Any `#join=` / `#seat=` fragment, well formed or not, is removed with history.replaceState; other fragments are
 *   left alone.
 * Returns the credentials now stored for the linked room, or null when the URL carried no valid link.
 */
export function consumeFragment(env: FragmentEnv): SeatCredentials | null {
  const { hash } = env.location;
  if (!isSecretFragment(hash)) return null;
  env.history.replaceState(env.history.state, '', env.location.pathname + env.location.search);

  const link = parseFragment(hash);
  if (link === null) return null;
  if (link.kind === 'seat') {
    const creds: SeatCredentials = { roomCode: link.roomCode, seatToken: link.seatToken };
    writeCredentials(env.storage, creds);
    return creds;
  }
  const existing = readCredentials(env.storage, link.roomCode);
  if (existing !== null) return existing;
  const creds: SeatCredentials = { roomCode: link.roomCode };
  writeCredentials(env.storage, creds);
  return creds;
}

export interface FragmentWindow {
  readonly location: FragmentEnv['location'];
  readonly history: FragmentEnv['history'];
  readonly localStorage: FragmentEnv['storage'];
  addEventListener(type: 'hashchange' | 'popstate', listener: () => void): void;
  removeEventListener(type: 'hashchange' | 'popstate', listener: () => void): void;
}

/**
 * Consumes a fragment link now and again on every `hashchange` and `popstate`, so a link opened in an already-loaded
 * tab (same-document navigation) is stored and stripped too. `onLink` receives the stored credentials for each valid
 * link. Returns a function that removes the listeners.
 */
export function watchFragmentLinks(win: FragmentWindow, onLink?: (creds: SeatCredentials) => void): () => void {
  const env: FragmentEnv = { location: win.location, history: win.history, storage: win.localStorage };
  const consume = () => {
    const creds = consumeFragment(env);
    if (creds !== null) onLink?.(creds);
  };
  consume();
  win.addEventListener('hashchange', consume);
  win.addEventListener('popstate', consume);
  return () => {
    win.removeEventListener('hashchange', consume);
    win.removeEventListener('popstate', consume);
  };
}
