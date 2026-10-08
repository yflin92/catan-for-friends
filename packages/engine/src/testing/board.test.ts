import { describe, expect, it } from 'vitest';
import { DEFAULT_GAME_CONFIG } from '../config';
import type { EdgeId, HexId } from '../ids';
import type { Board, HarborKind, Terrain } from '../state';
import { STANDARD_TOPOLOGY as T } from '../topology';
import { DEFAULT_TEST_BOARD, HARBOR_KINDS, TOKENS, validateBoard } from './board';
import { deepFreeze } from './freeze';

type MutableBoard = { hexes: { id: HexId; terrain: Terrain; token: number | null }[]; harbors: { edge: EdgeId; kind: HarborKind }[] };
const copy = (): MutableBoard => JSON.parse(JSON.stringify(DEFAULT_TEST_BOARD)) as MutableBoard;
const codes = (b: Board, rules = DEFAULT_GAME_CONFIG.rules) => validateBoard(b, rules).map((i) => i.code);
const hexAt = (b: MutableBoard, id: HexId) => b.hexes.find((h) => h.id === id)!;

describe('DEFAULT_TEST_BOARD (design §3.10)', () => {
  it('is legal: validateBoard returns no issues, with and without the red-number constraint', () => {
    expect(validateBoard(DEFAULT_TEST_BOARD)).toEqual([]);
    expect(validateBoard(DEFAULT_TEST_BOARD, { boardConstraints: { noAdjacentRedNumbers: false } })).toEqual([]);
  });

  it('lists the 19 hexes in hex index order with the desert (no token) at h:0,0', () => {
    expect(DEFAULT_TEST_BOARD.hexes.map((h) => h.id)).toEqual(T.hexes);
    expect(DEFAULT_TEST_BOARD.hexes.filter((h) => h.terrain === 'desert')).toEqual([{ id: 'h:0,0', terrain: 'desert', token: null }]);
  });

  it('has R1 terrain and tokens and R2 harbors', () => {
    const count = (t: Terrain) => DEFAULT_TEST_BOARD.hexes.filter((h) => h.terrain === t).length;
    expect([count('hills'), count('forest'), count('pasture'), count('fields'), count('mountains'), count('desert')])
      .toEqual([3, 4, 4, 4, 3, 1]);
    expect(DEFAULT_TEST_BOARD.hexes.flatMap((h) => (h.token === null ? [] : [h.token])).sort((a, b) => a - b)).toEqual(TOKENS);
    expect(DEFAULT_TEST_BOARD.harbors.map((p) => p.edge)).toEqual(T.harborSlots);
    expect(DEFAULT_TEST_BOARD.harbors.map((p) => p.kind).sort()).toEqual([...HARBOR_KINDS].sort());
  });

  it('has no edge-adjacent pair among {6, 8} (checked independently of validateBoard)', () => {
    const red = DEFAULT_TEST_BOARD.hexes.filter((h) => h.token === 6 || h.token === 8).map((h) => h.id);
    expect(red).toHaveLength(4);
    for (const h of red) for (const n of T.hexNeighbours(h)) expect(red).not.toContain(n);
  });

  it('is deeply frozen', () => {
    expect(Object.isFrozen(DEFAULT_TEST_BOARD)).toBe(true);
    expect(Object.isFrozen(DEFAULT_TEST_BOARD.hexes)).toBe(true);
    expect(Object.isFrozen(DEFAULT_TEST_BOARD.hexes[0])).toBe(true);
    expect(Object.isFrozen(DEFAULT_TEST_BOARD.harbors[8])).toBe(true);
  });
});

describe('validateBoard catches seeded faults', () => {
  it('hex_ids: a missing, extra, unknown or reordered hex', () => {
    const missing = copy();
    missing.hexes.pop();
    expect(codes(missing)).toContain('hex_ids');
    const reordered = copy();
    [reordered.hexes[0], reordered.hexes[1]] = [reordered.hexes[1]!, reordered.hexes[0]!];
    expect(codes(reordered)).toEqual(['hex_ids']);
    const unknown = copy();
    unknown.hexes[0]!.id = 'h:3,0';
    expect(codes(unknown)).toEqual(['hex_ids']);
  });

  it('terrain_count: one terrain swapped for another', () => {
    const b = copy();
    hexAt(b, 'h:0,-2').terrain = 'forest'; // mountains → forest
    expect(codes(b)).toEqual(['terrain_count', 'terrain_count']);
  });

  it('desert_token and token_missing: a token moved onto the desert', () => {
    const b = copy();
    hexAt(b, 'h:0,0').token = 2;
    hexAt(b, 'h:1,-2').token = null;
    // The desert's token is not counted, so the 2 is also missing from the token multiset.
    expect(codes(b).sort()).toEqual(['desert_token', 'token_count', 'token_missing']);
  });

  it('token_count: a duplicated number', () => {
    const b = copy();
    hexAt(b, 'h:1,-2').token = 3; // 2 → 3
    expect(codes(b)).toEqual(['token_count', 'token_count']);
  });

  it('adjacent_red_numbers: 6–8, 6–6 and 8–8 pairs, only when the constraint is on', () => {
    const swap = (b: MutableBoard, x: HexId, y: HexId) => {
      const [hx, hy] = [hexAt(b, x), hexAt(b, y)];
      [hx.token, hy.token] = [hy.token, hx.token];
    };
    const sixEight = copy();
    swap(sixEight, 'h:1,-1', 'h:2,0'); // 4 ↔ 8: h:1,-1 (8) now touches h:0,-1 (6)
    expect(codes(sixEight)).toEqual(['adjacent_red_numbers']);
    expect(codes(sixEight, { ...DEFAULT_GAME_CONFIG.rules, boardConstraints: { noAdjacentRedNumbers: false } })).toEqual([]);

    const sixSix = copy();
    swap(sixSix, 'h:1,-1', 'h:-1,2'); // 4 ↔ 6: h:1,-1 (6) touches h:0,-1 (6)
    expect(validateBoard(sixSix).map((i) => i.detail)).toEqual(['h:0,-1 (6) is adjacent to h:1,-1 (6)']);

    const eightEight = copy();
    swap(eightEight, 'h:1,1', 'h:-2,1'); // 5 ↔ 8: h:1,1 (8) touches h:2,0 (8)
    expect(validateBoard(eightEight).map((i) => i.detail)).toEqual(['h:2,0 (8) is adjacent to h:1,1 (8)']);
  });

  it('harbor_slots: a harbor off its slot, a missing harbor, or slots out of order', () => {
    const moved = copy();
    moved.harbors[0]!.edge = 'e:0,-2,NE';
    expect(codes(moved)).toEqual(['harbor_slots']);
    const missing = copy();
    missing.harbors.pop();
    expect(codes(missing).sort()).toEqual(['harbor_kinds', 'harbor_slots']);
    const reordered = copy();
    [reordered.harbors[0], reordered.harbors[1]] = [reordered.harbors[1]!, reordered.harbors[0]!];
    expect(codes(reordered)).toEqual(['harbor_slots']);
  });

  it('harbor_kinds: a generic harbor replaced by a fifth 2:1', () => {
    const b = copy();
    b.harbors[0]!.kind = 'ore';
    expect(codes(b)).toEqual(['harbor_kinds', 'harbor_kinds']);
  });
});

describe('deepFreeze', () => {
  it('freezes nested objects and arrays in place and returns the same value', () => {
    const x = { a: [{ b: 1 }], c: { d: [2] } };
    expect(deepFreeze(x)).toBe(x);
    expect(Object.isFrozen(x.a[0])).toBe(true);
    expect(Object.isFrozen(x.c.d)).toBe(true);
  });

  it('leaves primitives and null unchanged', () => {
    expect(deepFreeze(3)).toBe(3);
    expect(deepFreeze(null)).toBe(null);
  });
});
