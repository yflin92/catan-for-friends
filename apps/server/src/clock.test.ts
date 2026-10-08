import { describe, expect, it } from 'vitest';
import { FakeClock } from './clock';

describe('FakeClock (TH7)', () => {
  it('starts at startMs and moves only through advance', () => {
    const c = new FakeClock(1_000);
    expect(c.now()).toBe(1_000);
    c.advance(250);
    expect(c.now()).toBe(1_250);
  });

  it('fires due timers in due-time order, ties in arming order, with now() at each due time', () => {
    const c = new FakeClock(0);
    const seen: string[] = [];
    c.setTimeout(() => seen.push(`c@${c.now()}`), 30);
    c.setTimeout(() => seen.push(`a@${c.now()}`), 10);
    c.setTimeout(() => seen.push(`b1@${c.now()}`), 20);
    c.setTimeout(() => seen.push(`b2@${c.now()}`), 20);
    c.setTimeout(() => seen.push('late'), 31);
    c.advance(30);
    expect(seen).toEqual(['a@10', 'b1@20', 'b2@20', 'c@30']);
    expect(c.now()).toBe(30);
    c.advance(1);
    expect(seen.at(-1)).toBe('late');
  });

  it('re-arms intervals and interleaves them with timeouts by due time', () => {
    const c = new FakeClock(0);
    const seen: string[] = [];
    c.setInterval(() => seen.push(`i@${c.now()}`), 10);
    c.setTimeout(() => seen.push(`t@${c.now()}`), 25);
    c.advance(40);
    expect(seen).toEqual(['i@10', 'i@20', 't@25', 'i@30', 'i@40']);
  });

  it('fires timers armed during advance when they fall due before the target', () => {
    const c = new FakeClock(0);
    const seen: number[] = [];
    c.setTimeout(() => {
      seen.push(c.now());
      c.setTimeout(() => seen.push(c.now()), 5);
      c.setTimeout(() => seen.push(c.now()), 50);
    }, 10);
    c.advance(20);
    expect(seen).toEqual([10, 15]);
    c.advance(40);
    expect(seen).toEqual([10, 15, 60]);
  });

  it('advance(0) fires timers that are already due', () => {
    const c = new FakeClock(0);
    let fired = 0;
    c.setTimeout(() => fired++, 0);
    c.setTimeout(() => fired++, -5);
    c.advance(0);
    expect(fired).toBe(2);
    expect(c.now()).toBe(0);
  });

  it('clear() cancels timeouts and intervals', () => {
    const c = new FakeClock(0);
    let fired = 0;
    const t = c.setTimeout(() => fired++, 10);
    const i = c.setInterval(() => {
      fired++;
      c.clear(i);
    }, 5);
    c.clear(t);
    c.advance(100);
    expect(fired).toBe(1);
    expect(c.pendingTimers()).toBe(0);
  });

  it('keeps advancing when a callback throws and re-throws afterwards', () => {
    const c = new FakeClock(0);
    const seen: number[] = [];
    c.setTimeout(() => {
      throw new Error('boom');
    }, 5);
    c.setTimeout(() => seen.push(c.now()), 10);
    expect(() => c.advance(20)).toThrow('boom');
    expect(seen).toEqual([10]);
    expect(c.now()).toBe(20);
  });

  it('reports several throwing callbacks as one AggregateError', () => {
    const c = new FakeClock(0);
    c.setTimeout(() => {
      throw new Error('one');
    }, 1);
    c.setTimeout(() => {
      throw new Error('two');
    }, 2);
    let caught: unknown;
    try {
      c.advance(5);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors.map((e: Error) => e.message)).toEqual(['one', 'two']);
  });

  it('rejects a negative or non-finite advance', () => {
    const c = new FakeClock(0);
    expect(() => c.advance(-1)).toThrow(RangeError);
    expect(() => c.advance(Number.NaN)).toThrow(RangeError);
  });
});
