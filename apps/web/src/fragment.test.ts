import { describe, expect, it, vi } from 'vitest';
import { consumeFragment, normalizeRoomCode, parseFragment, readCredentials, seatStorageKey, type FragmentEnv } from './fragment';

const TOKEN = 'abcDEF0123456789_-abcDEF0123456789_-abcDEF0';

class MemoryStorage {
  readonly items = new Map<string, string>();
  getItem(k: string): string | null {
    return this.items.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.items.set(k, v);
  }
}

function env(hash: string, pathname = '/', search = '') {
  const storage = new MemoryStorage();
  const replaceState = vi.fn();
  const e: FragmentEnv = { location: { hash, pathname, search }, history: { replaceState, state: { k: 1 } }, storage };
  return { e, storage, replaceState };
}

describe('normalizeRoomCode', () => {
  it('strips separators and upper-cases', () => {
    expect(normalizeRoomCode('abc-def')).toBe('ABCDEF');
    expect(normalizeRoomCode(' ABC DEF ')).toBe('ABCDEF');
  });
  it('rejects symbols outside the room-code alphabet', () => {
    expect(normalizeRoomCode('ABCDE0')).toBeNull();
    expect(normalizeRoomCode('ABCDEO')).toBeNull();
    expect(normalizeRoomCode('ABCDE1')).toBeNull();
    expect(normalizeRoomCode('ABCDEI')).toBeNull();
    expect(normalizeRoomCode('')).toBeNull();
  });
});

describe('parseFragment', () => {
  it('parses join links', () => {
    expect(parseFragment('#join=ABC-DEF')).toEqual({ kind: 'join', roomCode: 'ABCDEF' });
  });
  it('parses seat links', () => {
    expect(parseFragment(`#seat=ABCDEF.${TOKEN}`)).toEqual({ kind: 'seat', roomCode: 'ABCDEF', seatToken: TOKEN });
  });
  it('rejects malformed links and unrelated fragments', () => {
    for (const h of ['', '#', '#join=', '#seat=ABCDEF', '#seat=ABCDEF.', '#seat=ABCDEF.short', `#seat=AB!DEF.${TOKEN}`, '#other=1', '#section']) {
      expect(parseFragment(h)).toBeNull();
    }
  });
});

describe('consumeFragment', () => {
  it('stores seat credentials and strips the fragment, keeping path and query', () => {
    const { e, storage, replaceState } = env(`#seat=ABCDEF.${TOKEN}`, '/play', '?x=1');
    expect(consumeFragment(e)).toEqual({ roomCode: 'ABCDEF', seatToken: TOKEN });
    expect(JSON.parse(storage.getItem(seatStorageKey('ABCDEF')) ?? 'null')).toEqual({ roomCode: 'ABCDEF', seatToken: TOKEN });
    expect(replaceState).toHaveBeenCalledWith({ k: 1 }, '', '/play?x=1');
  });

  it('a seat link replaces a previously stored token for the room', () => {
    const { e, storage } = env(`#seat=ABCDEF.${TOKEN}`);
    storage.setItem(seatStorageKey('ABCDEF'), JSON.stringify({ roomCode: 'ABCDEF', seatToken: 'old-token-old-token-old' }));
    consumeFragment(e);
    expect(readCredentials(storage, 'ABCDEF')).toEqual({ roomCode: 'ABCDEF', seatToken: TOKEN });
  });

  it('stores a join link without a token', () => {
    const { e, storage, replaceState } = env('#join=abc-def');
    expect(consumeFragment(e)).toEqual({ roomCode: 'ABCDEF' });
    expect(readCredentials(storage, 'ABCDEF')).toEqual({ roomCode: 'ABCDEF' });
    expect(replaceState).toHaveBeenCalledTimes(1);
  });

  it('a join link never discards a seat token already held for that room', () => {
    const { e, storage } = env('#join=ABCDEF');
    storage.setItem(seatStorageKey('ABCDEF'), JSON.stringify({ roomCode: 'ABCDEF', seatToken: TOKEN }));
    expect(consumeFragment(e)).toEqual({ roomCode: 'ABCDEF', seatToken: TOKEN });
    expect(readCredentials(storage, 'ABCDEF')).toEqual({ roomCode: 'ABCDEF', seatToken: TOKEN });
  });

  it('strips a malformed join/seat fragment without storing anything', () => {
    const { e, storage, replaceState } = env('#seat=ABCDEF.bad');
    expect(consumeFragment(e)).toBeNull();
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(storage.items.size).toBe(0);
  });

  it('leaves unrelated fragments alone', () => {
    const { e, storage, replaceState } = env('#rules');
    expect(consumeFragment(e)).toBeNull();
    expect(replaceState).not.toHaveBeenCalled();
    expect(storage.items.size).toBe(0);
  });

  it('never logs the fragment', () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    consumeFragment(env(`#seat=ABCDEF.${TOKEN}`).e);
    consumeFragment(env('#seat=ABCDEF.bad').e);
    consumeFragment(env('#join=ABCDEF').e);
    for (const s of spies) {
      expect(s).not.toHaveBeenCalled();
      s.mockRestore();
    }
  });
});

describe('readCredentials', () => {
  it('ignores corrupt or mismatched entries', () => {
    const s = new MemoryStorage();
    s.setItem(seatStorageKey('ABCDEF'), '{not json');
    expect(readCredentials(s, 'ABCDEF')).toBeNull();
    s.setItem(seatStorageKey('ABCDEF'), JSON.stringify({ roomCode: 'GHJKLM', seatToken: TOKEN }));
    expect(readCredentials(s, 'ABCDEF')).toBeNull();
    expect(readCredentials(s, 'ZZZZZZ')).toBeNull();
  });
});
