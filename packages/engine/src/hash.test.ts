import { describe, expect, expectTypeOf, it } from 'vitest';
import { fixtureState } from './__fixtures__/state';
import { canonicalJson, deserializeState, serializeState, sha256Hex, stateHash, viewHash } from './hash';
import type { PlayerView, PlayerViewData, ViewLike } from './view';
import type { GameState } from './state';

/** A deep copy whose object keys are inserted in reverse order. */
function reverseKeys(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(reverseKeys);
  if (typeof x === 'object' && x !== null) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(x).reverse()) out[k] = reverseKeys((x as Record<string, unknown>)[k]);
    return out;
  }
  return x;
}

describe('canonicalJson', () => {
  it('sorts keys at every depth and emits no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: true, y: null }], c: 'x' } })).toBe(
      '{"a":{"c":"x","d":[3,{"y":null,"z":true}]},"b":1}',
    );
  });

  it('sorts keys by UTF-16 code unit and escapes strings like JSON', () => {
    expect(canonicalJson({ b: 1, B: 2, 'é': 3, a: '"\n' })).toBe('{"B":2,"a":"\\"\\n","b":1,"é":3}');
  });

  it('keeps array order and writes -0 as 0', () => {
    expect(canonicalJson([3, 1, 2, -0])).toBe('[3,1,2,0]');
  });

  it.each([
    ['a float', { x: 1.5 }],
    ['NaN', { x: Number.NaN }],
    ['Infinity', [Number.POSITIVE_INFINITY]],
    ['an unsafe integer', { x: 2 ** 53 }],
    ['an undefined array element', [1, undefined]],
    ['a sparse array', new Array(2)],
    ['a Map', { m: new Map() }],
    ['a Set', [new Set()]],
    ['a Date', { d: new Date(0) }],
    ['a class instance', { c: new (class Foo {})() }],
    ['a bigint', { n: 1n }],
    ['a function', { f: () => 1 }],
    ['a symbol', { s: Symbol('s') }],
  ])('rejects %s', (_name, value) => {
    expect(() => canonicalJson(value)).toThrow(TypeError);
  });

  it('omits object keys whose value is undefined, exactly as JSON.stringify does (D5)', () => {
    const withUndefined = { b: 1, a: undefined, c: { d: undefined, e: [1, { f: undefined }] } };
    expect(canonicalJson(withUndefined)).toBe('{"b":1,"c":{"e":[1,{}]}}');
    expect(canonicalJson(withUndefined)).toBe(canonicalJson(JSON.parse(JSON.stringify(withUndefined))));
    expect(canonicalJson({ only: undefined })).toBe('{}');
  });

  it('gives a state with an undefined-valued key the same hash as the same state without it', () => {
    const s = fixtureState();
    const withExtra = { ...s, trade: s.trade, extra: undefined } as unknown as GameState;
    expect(stateHash(withExtra)).toBe(stateHash(s));
  });

  it('throws on undefined inside arrays, including holes (D5)', () => {
    expect(() => canonicalJson([1, undefined])).toThrow(TypeError);
    expect(() => canonicalJson({ a: [undefined] })).toThrow(TypeError);
    expect(() => canonicalJson([1, , 3])).toThrow(TypeError); // eslint-disable-line no-sparse-arrays
  });

  it('throws on non-integer numbers (D5)', () => {
    expect(() => canonicalJson({ a: 0.5 })).toThrow(TypeError);
    expect(() => canonicalJson([1e-9])).toThrow(TypeError);
    expect(() => canonicalJson({ a: { b: -2.25 } })).toThrow(TypeError);
  });

  it('accepts null-prototype objects', () => {
    const o = Object.create(null) as Record<string, unknown>;
    o['b'] = 1;
    o['a'] = 2;
    expect(canonicalJson(o)).toBe('{"a":2,"b":1}');
  });
});

describe('stateHash / serializeState / deserializeState (TH3)', () => {
  it('is lowercase hex SHA-256 of the canonical serialization', () => {
    const s = fixtureState();
    expect(stateHash(s)).toMatch(/^[0-9a-f]{64}$/);
    expect(stateHash(s)).toBe(sha256Hex(serializeState(s)));
  });

  it('matches the golden value for the fixture state', () => {
    expect(stateHash(fixtureState())).toMatchInlineSnapshot(`"0ed19cd32d22c5ac1fed5312ba2ec917349551d9e40bd1e580d0406379d66e07"`);
  });

  it('is unchanged by a JSON round-trip and by key insertion order', () => {
    const s = fixtureState();
    const roundTripped = JSON.parse(JSON.stringify(s)) as GameState;
    const reordered = reverseKeys(s) as GameState;
    expect(stateHash(roundTripped)).toBe(stateHash(s));
    expect(stateHash(reordered)).toBe(stateHash(s));
  });

  it('changes when any part of the state changes', () => {
    const s = fixtureState();
    const variants: GameState[] = [
      { ...s, nextTradeId: 3 },
      { ...s, devDeck: ['victoryPoint', 'knight', 'monopoly'] },
      { ...s, turn: { ...s.turn, dice: [5, 2] } },
      { ...s, config: { ...s.config, vpTarget: 11 } },
    ];
    const hashes = new Set([stateHash(s), ...variants.map(stateHash)]);
    expect(hashes.size).toBe(variants.length + 1);
  });

  it('round-trips through serializeState and deserializeState', () => {
    const s = fixtureState();
    const r = deserializeState(serializeState(s));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.state).toEqual(s);
      expect(stateHash(r.state)).toBe(stateHash(s));
    }
  });

  it.each([
    ['invalid JSON', '{"schemaVersion":1,'],
    ['a non-object', '[1,2]'],
    ['null', 'null'],
    ['an unknown schemaVersion', serializeState({ ...fixtureState(), schemaVersion: 2 as unknown as 1 })],
    ['a missing key', JSON.stringify({ ...fixtureState(), log: undefined })],
    ['an unknown key', JSON.stringify({ ...fixtureState(), extra: 1 })],
    ['a non-integer value', JSON.stringify({ ...fixtureState(), logCounter: 2.5 })],
  ])('rejects %s', (_name, json) => {
    const r = deserializeState(json);
    expect(r.ok).toBe(false);
  });
});

describe('viewHash (TH15)', () => {
  // A view-shaped value. The PlayerView brand is a phantom type with no runtime field.
  const data = {
    schemaVersion: 1,
    you: 0,
    hand: { ore: 1, brick: 2 },
    log: [{ n: 1, event: { kind: 'devBought', seat: 0 }, visibleTo: 'all' }],
  } as unknown as PlayerViewData;

  it('is SHA-256 of canonicalJson(view)', () => {
    expect(viewHash(data)).toBe(
      sha256Hex('{"hand":{"brick":2,"ore":1},"log":[{"event":{"kind":"devBought","seat":0},"n":1,"visibleTo":"all"}],"schemaVersion":1,"you":0}'),
    );
  });

  it('takes ViewLike: PlayerView, PlayerViewData and a passthrough wire view are all assignable (D7)', () => {
    expectTypeOf(viewHash).parameter(0).toEqualTypeOf<ViewLike>();
    expectTypeOf<PlayerView>().toExtend<ViewLike>();
    expectTypeOf<PlayerViewData>().toExtend<ViewLike>();
    // Shape of a zod passthrough parse result: known fields plus an index signature of unknown.
    expectTypeOf<PlayerViewData & { [k: string]: unknown }>().toExtend<ViewLike>();
  });

  it('ViewLike has no index signature', () => {
    const v: ViewLike = data;
    // @ts-expect-error — only the three declared fields are visible through ViewLike.
    expect(v.hand).toEqual(data.hand);
  });

  it('hashes a branded view and its plain data identically', () => {
    const hashBranded = (v: PlayerView): string => viewHash(v);
    // The branded value is the same object seen through the brand, so the two hashes must match.
    // eslint-disable-next-line hexlands/no-playerview-mint -- the test needs that object typed as PlayerView; it never leaves the test.
    const branded: PlayerView = data as never;
    expect(hashBranded(branded)).toBe(viewHash(data));
  });

  it('is unchanged by a wire round trip (JSON.stringify → JSON.parse), including extra wire fields', () => {
    const wire = JSON.parse(JSON.stringify(data)) as ViewLike;
    expect(viewHash(wire)).toBe(viewHash(data));
    const withUndefined = { ...data, extra: undefined } as unknown as ViewLike;
    expect(viewHash(JSON.parse(JSON.stringify(withUndefined)) as ViewLike)).toBe(viewHash(withUndefined));
  });

  it.each<[string, unknown]>([
    ['a non-safe integer', 2 ** 53],
    ['a fraction', 0.5],
    ['undefined inside an array', [undefined]],
    ['a Map', new Map()],
    ['a Date', new Date(0)],
  ])('propagates canonicalJson’s TypeError on %s (D7)', (_name, bad) => {
    expect(() => viewHash({ ...data, bad } as unknown as ViewLike)).toThrow(TypeError);
  });
});
