import { describe, expect, it } from 'vitest';
import type { EdgeId, HexId, VertexId } from './ids';
import {
  STANDARD_TOPOLOGY as T,
  edgeToPixels,
  hexIndex,
  hexToPixel,
  isEdgeId,
  isHexId,
  isVertexId,
  vertexToPixel,
} from './topology';

const COASTAL_SNAPSHOT = [
  'e:0,-2,NW', 'e:0,-2,NE', 'e:1,-2,NW', 'e:1,-2,NE', 'e:2,-2,NW', 'e:2,-2,NE', 'e:3,-2,W', 'e:2,-1,NE', 'e:3,-1,W',
  'e:2,0,NE', 'e:3,0,W', 'e:2,1,NW', 'e:2,1,W', 'e:1,2,NW', 'e:1,2,W', 'e:0,3,NW', 'e:-1,3,NE', 'e:-1,3,NW',
  'e:-2,3,NE', 'e:-2,3,NW', 'e:-3,3,NE', 'e:-2,2,W', 'e:-3,2,NE', 'e:-2,1,W', 'e:-3,1,NE', 'e:-2,0,W', 'e:-2,0,NW',
  'e:-1,-1,W', 'e:-1,-1,NW', 'e:0,-2,W',
];
const HARBOR_SNAPSHOT = [
  'e:0,-2,NW', 'e:1,-2,NE', 'e:3,-2,W', 'e:3,0,W', 'e:1,2,NW', 'e:-1,3,NE', 'e:-3,3,NE', 'e:-2,1,W', 'e:-2,0,NW',
];

const SIZE = 10;
const near = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9;
const key = (p: { x: number; y: number }) => `${Math.round(p.x * 1e6) + 0},${Math.round(p.y * 1e6) + 0}`; // + 0 folds -0
const axial = (h: HexId) => h.slice(2).split(',').map(Number) as [number, number];

/** Brute-force geometric model: two ids are the same location iff they render at the same point. */
function hexCornerPixels(h: HexId): { x: number; y: number }[] {
  const c = hexToPixel(h, SIZE);
  return [-90, -30, 30, 90, 150, 210].map((deg) => ({
    x: c.x + SIZE * Math.cos((deg * Math.PI) / 180),
    y: c.y + SIZE * Math.sin((deg * Math.PI) / 180),
  }));
}

describe('STANDARD_TOPOLOGY counts (design §3.1)', () => {
  it('has 19 hexes, 54 vertices, 72 edges, 30 coastal edges and 9 harbor slots', () => {
    expect([T.hexes.length, T.vertices.length, T.edges.length, T.coastalEdges.length, T.harborSlots.length])
      .toEqual([19, 54, 72, 30, 9]);
  });

  it('has unique ids', () => {
    for (const list of [T.hexes, T.vertices, T.edges, T.coastalEdges, T.harborSlots]) {
      expect(new Set(list).size).toBe(list.length);
    }
  });

  it('is deeply frozen', () => {
    expect(Object.isFrozen(T)).toBe(true);
    for (const list of [T.hexes, T.vertices, T.edges, T.coastalEdges, T.harborSlots]) expect(Object.isFrozen(list)).toBe(true);
    expect(Object.isFrozen(T.hexCorners('h:0,0'))).toBe(true);
    expect(Object.isFrozen(T.vertexEdges('v:0,0,N'))).toBe(true);
    expect(Object.isFrozen(T.edgeVertices('e:0,0,W'))).toBe(true);
  });
});

describe('canonical order (ADR-0001, TH14)', () => {
  it('lists hexes row-major: r ascending then q ascending', () => {
    expect(T.hexes).toEqual([
      'h:0,-2', 'h:1,-2', 'h:2,-2',
      'h:-1,-1', 'h:0,-1', 'h:1,-1', 'h:2,-1',
      'h:-2,0', 'h:-1,0', 'h:0,0', 'h:1,0', 'h:2,0',
      'h:-2,1', 'h:-1,1', 'h:0,1', 'h:1,1',
      'h:-2,2', 'h:-1,2', 'h:0,2',
    ]);
  });

  it('hexIndex: 0 = h:0,-2, 18 = h:0,2, and matches the hexes order', () => {
    expect(hexIndex('h:0,-2')).toBe(0);
    expect(hexIndex('h:0,2')).toBe(18);
    T.hexes.forEach((h, i) => expect(hexIndex(h)).toBe(i));
    expect(() => hexIndex('h:3,0')).toThrow(RangeError);
  });

  it('sorts vertices by (r, q, N before S) and edges by (r, q, NE, NW, W)', () => {
    const parse = (id: string) => {
      const [q, r, k] = id.slice(2).split(',');
      return [Number(r), Number(q), k] as const;
    };
    const ordered = (ids: readonly string[], kinds: readonly string[]) =>
      ids.every((id, i) => {
        if (i === 0) return true;
        const [r0, q0, k0] = parse(ids[i - 1]!);
        const [r1, q1, k1] = parse(id);
        return r0 < r1 || (r0 === r1 && (q0 < q1 || (q0 === q1 && kinds.indexOf(k0!) < kinds.indexOf(k1!))));
      });
    expect(ordered(T.vertices, ['N', 'S'])).toBe(true);
    expect(ordered(T.edges, ['NE', 'NW', 'W'])).toBe(true);
  });
});

describe('canonicalisation matches geometry', () => {
  it('maps every hex corner to exactly one vertex id per physical point (canonical round-trip)', () => {
    const idAt = new Map<string, VertexId>();
    for (const h of T.hexes) {
      const corners = T.hexCorners(h);
      const pixels = hexCornerPixels(h);
      expect(corners).toHaveLength(6);
      corners.forEach((v, i) => {
        expect(near(vertexToPixel(v, SIZE), pixels[i]!)).toBe(true);
        const k = key(pixels[i]!);
        expect(idAt.get(k) ?? v).toBe(v);
        idAt.set(k, v);
      });
    }
    expect(idAt.size).toBe(54);
    expect(new Set(idAt.values())).toEqual(new Set(T.vertices));
  });

  it('lists hex corners clockwise from N', () => {
    for (const h of T.hexes) {
      const [q, r] = axial(h);
      const [n, ne, se, s, sw, nw] = T.hexCorners(h);
      expect(n).toBe(`v:${q},${r},N`);
      expect(ne).toBe(`v:${q + 1},${r - 1},S`);
      expect(se).toBe(`v:${q},${r + 1},N`);
      expect(s).toBe(`v:${q},${r},S`);
      expect(sw).toBe(`v:${q - 1},${r + 1},N`);
      expect(nw).toBe(`v:${q},${r - 1},S`);
    }
  });

  it('gives each edge the two adjacent corners of a hex side, sorted canonically', () => {
    for (const e of T.edges) {
      const [a, b] = T.edgeVertices(e);
      expect(T.vertices.indexOf(a)).toBeLessThan(T.vertices.indexOf(b));
      const [pa, pb] = [vertexToPixel(a, SIZE), vertexToPixel(b, SIZE)];
      expect(Math.hypot(pa.x - pb.x, pa.y - pb.y)).toBeCloseTo(SIZE, 9);
      const [ea, eb] = edgeToPixels(e, SIZE);
      expect(near(ea, pa) && near(eb, pb)).toBe(true);
    }
  });
});

describe('adjacency', () => {
  it('each land vertex touches 1–3 land hexes, consistent with hexCorners', () => {
    for (const v of T.vertices) {
      const hs = T.vertexHexes(v);
      expect(hs.length).toBeGreaterThanOrEqual(1);
      expect(hs.length).toBeLessThanOrEqual(3);
      expect([...hs].sort((a, b) => hexIndex(a) - hexIndex(b))).toEqual(hs);
      for (const h of hs) expect(T.hexCorners(h)).toContain(v);
    }
    for (const h of T.hexes) for (const v of T.hexCorners(h)) expect(T.vertexHexes(v)).toContain(h);
  });

  it('vertexEdges / edgeVertices are mutually consistent, with 2–3 edges per vertex', () => {
    let incidences = 0;
    for (const v of T.vertices) {
      const es = T.vertexEdges(v);
      expect(es.length).toBeGreaterThanOrEqual(2);
      expect(es.length).toBeLessThanOrEqual(3);
      for (const e of es) expect(T.edgeVertices(e)).toContain(v);
      incidences += es.length;
    }
    expect(incidences).toBe(2 * 72);
  });

  it('vertexNeighbours is symmetric and equals the far ends of vertexEdges', () => {
    for (const v of T.vertices) {
      const ns = T.vertexNeighbours(v);
      expect(ns.length).toBeGreaterThanOrEqual(2);
      expect(ns.length).toBeLessThanOrEqual(3);
      const farEnds = T.vertexEdges(v).map((e) => T.edgeVertices(e).find((x) => x !== v)!);
      expect(new Set(ns)).toEqual(new Set(farEnds));
      for (const n of ns) expect(T.vertexNeighbours(n)).toContain(v);
    }
  });

  it('hexNeighbours is symmetric, land-only, in hex index order and shares exactly one edge', () => {
    const edgesOf = (h: HexId) => new Set(T.edges.filter((e) => T.edgeVertices(e).every((v) => T.hexCorners(h).includes(v))));
    for (const h of T.hexes) {
      const ns = T.hexNeighbours(h);
      expect([...ns].sort((a, b) => hexIndex(a) - hexIndex(b))).toEqual(ns);
      for (const n of ns) {
        expect(isHexId(n)).toBe(true);
        expect(T.hexNeighbours(n)).toContain(h);
        expect([...edgesOf(h)].filter((e) => edgesOf(n).has(e))).toHaveLength(1);
      }
      expect(edgesOf(h).size).toBe(6);
    }
    expect(T.hexNeighbours('h:0,0')).toHaveLength(6);
    expect(T.hexNeighbours('h:0,-2')).toEqual(['h:1,-2', 'h:-1,-1', 'h:0,-1']);
  });

  it('throws RangeError for ids that are not on the board', () => {
    expect(() => T.hexCorners('h:3,0')).toThrow(RangeError);
    expect(() => T.vertexHexes('v:9,9,N')).toThrow(RangeError);
    expect(() => T.edgeVertices('e:9,9,W')).toThrow(RangeError);
  });
});

describe('perimeter and harbor slots (ADR-0001 rev 1.1)', () => {
  const landCount = (e: EdgeId) => T.hexes.filter((h) => T.edgeVertices(e).every((v) => T.hexCorners(h).includes(v))).length;

  it('SNAPSHOT: coastalEdges in normative perimeter order', () => {
    expect(T.coastalEdges).toEqual(COASTAL_SNAPSHOT);
  });

  it('SNAPSHOT: harborSlots in slot order', () => {
    expect(T.harborSlots).toEqual(HARBOR_SNAPSHOT);
  });

  it('coastalEdges are exactly the edges with one land hex', () => {
    const coastal = T.edges.filter((e) => landCount(e) === 1);
    expect(new Set(T.coastalEdges)).toEqual(new Set(coastal));
    expect(T.edges.filter((e) => landCount(e) === 2)).toHaveLength(42);
  });

  it('coastalEdges form one closed chain, clockwise on screen from e:0,-2,NW', () => {
    const angle = (e: EdgeId) => {
      const [a, b] = edgeToPixels(e, SIZE);
      return Math.atan2((a.y + b.y) / 2, (a.x + b.x) / 2);
    };
    let turned = 0;
    T.coastalEdges.forEach((e, i) => {
      const next = T.coastalEdges[(i + 1) % 30]!;
      const shared = T.edgeVertices(e).filter((v) => T.edgeVertices(next).includes(v));
      expect(shared).toHaveLength(1);
      let d = angle(next) - angle(e);
      if (d < -Math.PI) d += 2 * Math.PI;
      if (d > Math.PI) d -= 2 * Math.PI;
      expect(d).toBeGreaterThan(0); // y grows downward, so increasing atan2 is clockwise on screen
      turned += d;
    });
    expect(turned).toBeCloseTo(2 * Math.PI, 9);
  });

  it('harborSlots sit at perimeter positions 0,3,6,10,13,16,20,23,26 with 2/2/3 gaps', () => {
    const positions = T.harborSlots.map((e) => T.coastalEdges.indexOf(e));
    expect(positions).toEqual([0, 3, 6, 10, 13, 16, 20, 23, 26]);
    const gaps = positions.map((p, i) => ((positions[(i + 1) % 9]! - p + 30) % 30) - 1);
    expect(gaps).toEqual([2, 2, 3, 2, 2, 3, 2, 2, 3]);
  });

  it('no two harbor slots share a vertex; each touches 2 coastal vertices', () => {
    const vs = T.harborSlots.flatMap((e) => T.edgeVertices(e));
    expect(new Set(vs).size).toBe(18);
    for (const v of vs) expect(T.vertexHexes(v).length).toBeLessThanOrEqual(2);
  });
});

describe('id guards', () => {
  it('accept every board id', () => {
    expect(T.hexes.every(isHexId)).toBe(true);
    expect(T.vertices.every(isVertexId)).toBe(true);
    expect(T.edges.every(isEdgeId)).toBe(true);
  });

  it.each([
    ['h:3,0'], ['h:0,3'], ['h:2,1'], ['h:00,0'], ['h:-0,0'], ['h:+1,0'], ['h:0,0 '], ['h:0.5,0'], ['v:0,0,N'], ['e:0,0,W'],
    [''], [null], [undefined], [0], [{}], [['h:0,0']],
  ])('isHexId rejects %j', (x) => expect(isHexId(x)).toBe(false));

  it.each([
    ['v:0,0,NE'], ['v:0,0,SE'], ['v:5,5,N'], ['v:0,-3,N'], ['v:-0,0,N'], ['v:0,0'], ['h:0,0'], ['v:0,0,n'], [42],
  ])('isVertexId rejects %j', (x) => expect(isVertexId(x)).toBe(false));

  it.each([
    ['e:0,0,E'], ['e:0,0,SE'], ['e:0,0,SW'], ['e:5,5,W'], ['e:0,-3,NE'], ['e:-0,0,W'], ['v:0,0,N'], [true],
  ])('isEdgeId rejects %j', (x) => expect(isEdgeId(x)).toBe(false));

  it('accepts canonical ids whose owner is an off-board hex', () => {
    expect(isVertexId('v:0,-3,S')).toBe(true);
    expect(isEdgeId('e:3,-2,W')).toBe(true);
    expect(isEdgeId('e:0,3,NW')).toBe(true);
  });
});

describe('geometry', () => {
  it('places pointy-top hexes with r growing south', () => {
    expect(hexToPixel('h:0,0', SIZE)).toEqual({ x: 0, y: 0 });
    expect(near(hexToPixel('h:1,0', SIZE), { x: SIZE * Math.sqrt(3), y: 0 })).toBe(true);
    expect(near(hexToPixel('h:0,1', SIZE), { x: (SIZE * Math.sqrt(3)) / 2, y: 1.5 * SIZE })).toBe(true);
    expect(vertexToPixel('v:0,0,N', SIZE)).toEqual({ x: 0, y: -SIZE });
    expect(vertexToPixel('v:0,0,S', SIZE)).toEqual({ x: 0, y: SIZE });
  });

  it('accepts off-board hexes and throws RangeError on malformed ids', () => {
    expect(near(hexToPixel('h:3,0', SIZE), { x: 3 * SIZE * Math.sqrt(3), y: 0 })).toBe(true);
    expect(() => hexToPixel('h:x,0' as HexId, SIZE)).toThrow(RangeError);
    expect(() => vertexToPixel('v:0,0,E' as VertexId, SIZE)).toThrow(RangeError);
    expect(() => edgeToPixels('e:0,0,E' as EdgeId, SIZE)).toThrow(RangeError);
  });
});
