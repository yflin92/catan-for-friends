import { describe, expect, it } from 'vitest';
import { recallRoom, rememberRoom } from './active-room';

describe('active room (per tab)', () => {
  it('remembers and recalls the room code', () => {
    const items = new Map<string, string>();
    const storage = { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v) };
    expect(recallRoom(storage)).toBeNull();
    rememberRoom(storage, 'ABCDEF');
    expect(recallRoom(storage)).toBe('ABCDEF');
    expect([...items.keys()]).toEqual(['hexlands.activeRoom']);
  });

  it('never throws when storage is unavailable', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(() => rememberRoom(broken, 'ABCDEF')).not.toThrow();
    expect(recallRoom(broken)).toBeNull();
  });
});
