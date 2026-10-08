// Standard board topology (design §3.1, ADR-0001 rev 1.1): canonical ids, adjacency, perimeter order, harbor slots,
// the canonical hex index (TH14) and pixel geometry for the web board. Everything is precomputed once and frozen.
import type { EdgeId, HexId, Topology, VertexId } from './ids';

type Corner = 'N' | 'NE' | 'SE' | 'S' | 'SW' | 'NW';
type Side = 'NE' | 'E' | 'SE' | 'SW' | 'W' | 'NW';
type OwnedCorner = 'N' | 'S';
type OwnedSide = 'NE' | 'NW' | 'W';
interface Axial { readonly q: number; readonly r: number }

const LAND_RADIUS = 2;

const DIRECTIONS: Readonly<Record<Side, Axial>> = {
  E: { q: 1, r: 0 }, W: { q: -1, r: 0 }, NE: { q: 1, r: -1 }, NW: { q: 0, r: -1 }, SE: { q: 0, r: 1 }, SW: { q: -1, r: 1 },
};

/** Corners clockwise from N. */
const CORNERS: readonly Corner[] = ['N', 'NE', 'SE', 'S', 'SW', 'NW'];
/** Sides clockwise from NE, each with its two end corners. */
const SIDE_CORNERS: Readonly<Record<Side, readonly [Corner, Corner]>> = {
  NE: ['N', 'NE'], E: ['NE', 'SE'], SE: ['SE', 'S'], SW: ['S', 'SW'], W: ['SW', 'NW'], NW: ['NW', 'N'],
};
const SIDES = Object.keys(SIDE_CORNERS) as readonly Side[];
const OWNED_CORNER_ORDER: Readonly<Record<OwnedCorner, number>> = { N: 0, S: 1 };
const OWNED_SIDE_ORDER: Readonly<Record<OwnedSide, number>> = { NE: 0, NW: 1, W: 2 };

/**
 * Perimeter positions of the 9 harbor slots within coastalEdges (ADR-0001 rev 1.1).
 */
const HARBOR_SLOT_POSITIONS = [0, 3, 6, 10, 13, 16, 20, 23, 26] as const;

/**
 * The 30 coastal edges in NORMATIVE perimeter order: clockwise on screen (y down) from e:0,-2,NW (ADR-0001 rev 1.1).
 * Frozen for golden fixtures; several canonical owners are off-board hexes under the owner rule.
 */
const COASTAL_EDGES: readonly EdgeId[] = [
  'e:0,-2,NW', 'e:0,-2,NE', 'e:1,-2,NW', 'e:1,-2,NE', 'e:2,-2,NW', 'e:2,-2,NE', 'e:3,-2,W', 'e:2,-1,NE', 'e:3,-1,W',
  'e:2,0,NE', 'e:3,0,W', 'e:2,1,NW', 'e:2,1,W', 'e:1,2,NW', 'e:1,2,W', 'e:0,3,NW', 'e:-1,3,NE', 'e:-1,3,NW',
  'e:-2,3,NE', 'e:-2,3,NW', 'e:-3,3,NE', 'e:-2,2,W', 'e:-3,2,NE', 'e:-2,1,W', 'e:-3,1,NE', 'e:-2,0,W', 'e:-2,0,NW',
  'e:-1,-1,W', 'e:-1,-1,NW', 'e:0,-2,W',
];

const INT = '(-?(?:0|[1-9][0-9]*))';
const HEX_RE = new RegExp(`^h:${INT},${INT}$`);
const VERTEX_RE = new RegExp(`^v:${INT},${INT},(N|S)$`);
const EDGE_RE = new RegExp(`^e:${INT},${INT},(NE|NW|W)$`);

/** Parses a syntactically canonical integer ("-0" and leading zeros are rejected). */
function int(s: string | undefined): number | null {
  if (s === undefined || s === '-0') return null;
  return Number(s);
}

function parseHex(id: string): Axial | null {
  const m = HEX_RE.exec(id);
  const q = int(m?.[1]);
  const r = int(m?.[2]);
  return q === null || r === null ? null : { q, r };
}

function parseVertex(id: string): (Axial & { readonly corner: OwnedCorner }) | null {
  const m = VERTEX_RE.exec(id);
  const q = int(m?.[1]);
  const r = int(m?.[2]);
  return q === null || r === null ? null : { q, r, corner: m?.[3] as OwnedCorner };
}

function parseEdge(id: string): (Axial & { readonly side: OwnedSide }) | null {
  const m = EDGE_RE.exec(id);
  const q = int(m?.[1]);
  const r = int(m?.[2]);
  return q === null || r === null ? null : { q, r, side: m?.[3] as OwnedSide };
}

const hexId = (h: Axial): HexId => `h:${h.q},${h.r}`;
const step = (h: Axial, d: Side): Axial => ({ q: h.q + DIRECTIONS[d].q, r: h.r + DIRECTIONS[d].r });
const isLand = (h: Axial): boolean => Math.max(Math.abs(h.q), Math.abs(h.r), Math.abs(h.q + h.r)) <= LAND_RADIUS;

/** Canonical id of a hex corner: N/S are owned; NE/NW map to S of that neighbour, SE/SW to N of that neighbour. */
function cornerId(h: Axial, c: Corner): VertexId {
  switch (c) {
    case 'N':
    case 'S':
      return `v:${h.q},${h.r},${c}`;
    case 'NE':
    case 'NW': {
      const o = step(h, c);
      return `v:${o.q},${o.r},S`;
    }
    case 'SE':
    case 'SW': {
      const o = step(h, c);
      return `v:${o.q},${o.r},N`;
    }
  }
}

/** Canonical id of a hex side: NE/NW/W are owned; E, SE and SW map to W, NW and NE of that neighbour. */
function sideId(h: Axial, s: Side): EdgeId {
  switch (s) {
    case 'NE':
    case 'NW':
    case 'W':
      return `e:${h.q},${h.r},${s}`;
    case 'E': {
      const o = step(h, 'E');
      return `e:${o.q},${o.r},W`;
    }
    case 'SE': {
      const o = step(h, 'SE');
      return `e:${o.q},${o.r},NW`;
    }
    case 'SW': {
      const o = step(h, 'SW');
      return `e:${o.q},${o.r},NE`;
    }
  }
}

function compareHex(a: Axial, b: Axial): number {
  return a.r - b.r || a.q - b.q;
}

function compareVertexIds(a: VertexId, b: VertexId): number {
  const pa = parseVertex(a)!;
  const pb = parseVertex(b)!;
  return compareHex(pa, pb) || OWNED_CORNER_ORDER[pa.corner] - OWNED_CORNER_ORDER[pb.corner];
}

function compareEdgeIds(a: EdgeId, b: EdgeId): number {
  const pa = parseEdge(a)!;
  const pb = parseEdge(b)!;
  return compareHex(pa, pb) || OWNED_SIDE_ORDER[pa.side] - OWNED_SIDE_ORDER[pb.side];
}

/** The two canonical vertices of any well-formed edge id, in canonical vertex order. */
function verticesOfEdge(e: { readonly q: number; readonly r: number; readonly side: OwnedSide }): readonly [VertexId, VertexId] {
  const [c1, c2] = SIDE_CORNERS[e.side];
  const pair = [cornerId(e, c1), cornerId(e, c2)].sort(compareVertexIds);
  return [pair[0]!, pair[1]!];
}

function freezeAll<K, V>(m: Map<K, V[]>): ReadonlyMap<K, readonly V[]> {
  for (const v of m.values()) Object.freeze(v);
  return m;
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const list = m.get(k);
  if (list === undefined) m.set(k, [v]);
  else if (!list.includes(v)) list.push(v);
}

function lookup<K, V>(m: ReadonlyMap<K, V>, k: K, kind: string): V {
  const v = m.get(k);
  if (v === undefined) throw new RangeError(`not a ${kind} of the standard board: ${String(k)}`);
  return v;
}

function buildStandardTopology(): Topology {
  const land: Axial[] = [];
  for (let r = -LAND_RADIUS; r <= LAND_RADIUS; r++) {
    for (let q = -LAND_RADIUS; q <= LAND_RADIUS; q++) if (isLand({ q, r })) land.push({ q, r });
  }
  land.sort(compareHex);
  const hexes = Object.freeze(land.map(hexId));

  const hexCorners = new Map<HexId, VertexId[]>();
  const hexNeighbours = new Map<HexId, HexId[]>();
  const vertexHexes = new Map<VertexId, HexId[]>();
  const vertexEdges = new Map<VertexId, EdgeId[]>();
  const vertexNeighbours = new Map<VertexId, VertexId[]>();
  const edgeVertices = new Map<EdgeId, readonly [VertexId, VertexId]>();

  for (const h of land) {
    const id = hexId(h);
    hexCorners.set(id, CORNERS.map((c) => cornerId(h, c)));
    hexNeighbours.set(id, SIDES.map((s) => step(h, s)).filter(isLand).sort(compareHex).map(hexId));
    for (const c of CORNERS) push(vertexHexes, cornerId(h, c), id);
    for (const s of SIDES) {
      const e = sideId(h, s);
      if (edgeVertices.has(e)) continue;
      const [a, b] = verticesOfEdge(parseEdge(e)!);
      edgeVertices.set(e, Object.freeze([a, b] as const));
    }
  }

  const vertices = Object.freeze([...vertexHexes.keys()].sort(compareVertexIds));
  const edges = Object.freeze([...edgeVertices.keys()].sort(compareEdgeIds));
  for (const e of edges) {
    const [a, b] = edgeVertices.get(e)!;
    push(vertexEdges, a, e);
    push(vertexEdges, b, e);
    push(vertexNeighbours, a, b);
    push(vertexNeighbours, b, a);
  }
  for (const list of vertexEdges.values()) list.sort(compareEdgeIds);
  for (const list of vertexNeighbours.values()) list.sort(compareVertexIds);
  // vertexHexes was filled in hex index order already.

  const coastalEdges = Object.freeze([...COASTAL_EDGES]);
  const harborSlots = Object.freeze(HARBOR_SLOT_POSITIONS.map((p) => coastalEdges[p]!));

  const corners = freezeAll(hexCorners);
  const hexNbrs = freezeAll(hexNeighbours);
  const vHexes = freezeAll(vertexHexes);
  const vEdges = freezeAll(vertexEdges);
  const vNbrs = freezeAll(vertexNeighbours);

  return Object.freeze({
    hexes,
    vertices,
    edges,
    coastalEdges,
    harborSlots,
    hexCorners: (h: HexId) => lookup(corners, h, 'hex'),
    vertexHexes: (v: VertexId) => lookup(vHexes, v, 'vertex'),
    vertexNeighbours: (v: VertexId) => lookup(vNbrs, v, 'vertex'),
    vertexEdges: (v: VertexId) => lookup(vEdges, v, 'vertex'),
    edgeVertices: (e: EdgeId) => lookup(edgeVertices, e, 'edge'),
    hexNeighbours: (h: HexId) => lookup(hexNbrs, h, 'hex'),
  });
}

/**
 * The standard 19-hex board. Lookup methods throw RangeError for ids that are not on this board; validate untrusted
 * ids with isHexId / isVertexId / isEdgeId first. Every list is frozen and sorted canonically: hexes by hex index;
 * vertices by (r, q, N before S); edges by (r, q, NE, NW, W). hexNeighbours and vertexHexes are in hex index order.
 */
export const STANDARD_TOPOLOGY: Topology = buildStandardTopology();

const HEX_INDEX: ReadonlyMap<string, number> = new Map(STANDARD_TOPOLOGY.hexes.map((h, i) => [h, i]));
const VERTEX_SET: ReadonlySet<string> = new Set(STANDARD_TOPOLOGY.vertices);
const EDGE_SET: ReadonlySet<string> = new Set(STANDARD_TOPOLOGY.edges);

/** Canonical hex index 0..18 (TH14): row-major, r ascending then q ascending; 0 = h:0,-2, 18 = h:0,2. */
export function hexIndex(h: HexId): number {
  return lookup(HEX_INDEX, h, 'hex');
}

/** True iff x is the canonical id of one of the 19 land hexes. */
export function isHexId(x: unknown): x is HexId {
  return typeof x === 'string' && HEX_INDEX.has(x);
}

/** True iff x is the canonical id of one of the 54 board vertices. */
export function isVertexId(x: unknown): x is VertexId {
  return typeof x === 'string' && VERTEX_SET.has(x);
}

/** True iff x is the canonical id of one of the 72 board edges. */
export function isEdgeId(x: unknown): x is EdgeId {
  return typeof x === 'string' && EDGE_SET.has(x);
}

// Geometry. Pointy-top hexes with circumradius `size`; screen y grows downward (south). Accepts any well-formed id,
// including off-board (ocean) hexes, so the client can draw the sea frame.
const SQRT3 = Math.sqrt(3);

function requireParsed<T>(p: T | null, id: string): T {
  if (p === null) throw new RangeError(`malformed board id: ${id}`);
  return p;
}

function centre(h: Axial, size: number): { x: number; y: number } {
  return { x: size * SQRT3 * (h.q + h.r / 2), y: size * 1.5 * h.r };
}

/** Centre of a hex. */
export function hexToPixel(h: HexId, size: number): { x: number; y: number } {
  return centre(requireParsed(parseHex(h), h), size);
}

/** Position of a vertex: the N or S corner of its owner hex. */
export function vertexToPixel(v: VertexId, size: number): { x: number; y: number } {
  const p = requireParsed(parseVertex(v), v);
  const c = centre(p, size);
  return { x: c.x, y: p.corner === 'N' ? c.y - size : c.y + size };
}

/** End points of an edge, in the same order as its two vertices (canonical vertex order). */
export function edgeToPixels(e: EdgeId, size: number): readonly [{ x: number; y: number }, { x: number; y: number }] {
  const [a, b] = verticesOfEdge(requireParsed(parseEdge(e), e));
  return [vertexToPixel(a, size), vertexToPixel(b, size)];
}
