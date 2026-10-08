import { describe, expect, it } from 'vitest';
import { EMPTY_SNAPSHOT, Store } from './store';
import { rootAttributes, type ViewHashers } from './th15';
import type { PlayerViewWire, RoomView } from './wire';

const view = { schemaVersion: 1, you: 2 } as unknown as PlayerViewWire;
const room = { lifecycle: 'active' } as unknown as RoomView;
const hashers: ViewHashers = {
  viewHash: (v) => `vh:${v.you}`,
  publicProjectionHash: (v) => `ph:${v.schemaVersion}`,
};

describe('rootAttributes (TH15)', () => {
  it('is all empty strings before a room or view exists', () => {
    expect(rootAttributes(EMPTY_SNAPSHOT, hashers)).toEqual({
      'data-seq': '',
      'data-view-hash': '',
      'data-public-hash': '',
      'data-lifecycle': '',
      'data-seat': '',
    });
  });

  it('reflects seq, hashes, lifecycle and the wire seat of the adopted view', () => {
    const s = { ...EMPTY_SNAPSHOT, room, view, seq: 17, seat: 2 as const };
    expect(rootAttributes(s, hashers)).toEqual({
      'data-seq': '17',
      'data-view-hash': 'vh:2',
      'data-public-hash': 'ph:1',
      'data-lifecycle': 'active',
      'data-seat': '2',
    });
  });

  it('renders seat 0 and seq 0 as "0", not empty', () => {
    const s = { ...EMPTY_SNAPSHOT, room, view, seq: 0, seat: 0 as const };
    const a = rootAttributes(s, hashers);
    expect(a['data-seq']).toBe('0');
    expect(a['data-seat']).toBe('0');
  });

  it('leaves hashes empty when no hashers are supplied', () => {
    const a = rootAttributes({ ...EMPTY_SNAPSHOT, view, seq: 3 }, null);
    expect(a['data-view-hash']).toBe('');
    expect(a['data-public-hash']).toBe('');
    expect(a['data-seq']).toBe('3');
  });
});

describe('Store', () => {
  it('publishes a new frozen snapshot per update and notifies once', () => {
    const store = new Store();
    let calls = 0;
    const unsubscribe = store.subscribe(() => calls++);
    const before = store.getSnapshot();
    store.update({ view, seq: 5 });
    const after = store.getSnapshot();
    expect(after).not.toBe(before);
    expect(Object.isFrozen(after)).toBe(true);
    expect(after.view).toBe(view);
    expect(after.seq).toBe(5);
    expect(calls).toBe(1);
    unsubscribe();
    store.update({ seq: 6 });
    expect(calls).toBe(1);
  });
});
