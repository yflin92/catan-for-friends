import { describe, expect, it } from 'vitest';
import { fixtureState } from './__fixtures__/state';
import { LOG_LIMIT, defaultVisibility, emit, eventsSince } from './log';
import type { GameState } from './state';

describe('log', () => {
  it('numbers entries from logCounter and applies the default visibility', () => {
    const s = fixtureState();
    const a = emit(s, { kind: 'stole', seat: 1, victim: 2 });
    const b = emit(a, { kind: 'stoleDetail', seat: 1, victim: 2, resource: 'ore' });
    expect(b.log.slice(-2)).toEqual([
      { n: s.logCounter + 1, event: { kind: 'stole', seat: 1, victim: 2 }, visibleTo: 'all' },
      { n: s.logCounter + 2, event: { kind: 'stoleDetail', seat: 1, victim: 2, resource: 'ore' }, visibleTo: [1, 2] },
    ]);
    expect(b.logCounter).toBe(s.logCounter + 2);
  });

  it('shows private details only to the seats involved', () => {
    expect(defaultVisibility({ kind: 'devBoughtDetail', seat: 2, card: 'knight' })).toEqual([2]);
    expect(defaultVisibility({ kind: 'stoleDetail', seat: 2, victim: 0, resource: 'wool' })).toEqual([0, 2]);
    expect(defaultVisibility({ kind: 'devBought', seat: 2 })).toBe('all');
  });

  it(`keeps the last ${LOG_LIMIT} entries while logCounter keeps counting`, () => {
    let s: GameState = fixtureState();
    for (let i = 0; i < LOG_LIMIT + 5; i++) s = emit(s, { kind: 'devBought', seat: 0 });
    expect(s.log).toHaveLength(LOG_LIMIT);
    expect(s.logCounter).toBe(fixtureState().logCounter + LOG_LIMIT + 5);
    expect(s.log.at(-1)?.n).toBe(s.logCounter);
    expect(s.log[0]?.n).toBe(s.logCounter - LOG_LIMIT + 1);
  });

  it('eventsSince returns exactly the appended events, in order', () => {
    const s = fixtureState();
    const t = emit(emit(s, { kind: 'devBought', seat: 0 }), { kind: 'devBought', seat: 1 });
    expect(eventsSince(s, t)).toEqual([{ kind: 'devBought', seat: 0 }, { kind: 'devBought', seat: 1 }]);
    expect(eventsSince(s, s)).toEqual([]);
  });

  it('does not mutate its input', () => {
    const s = fixtureState();
    const snapshot = JSON.stringify(s);
    emit(s, { kind: 'devBought', seat: 0 });
    expect(JSON.stringify(s)).toBe(snapshot);
  });
});
