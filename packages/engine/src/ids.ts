// Board identity types (design §3.1, ADR-0001). STANDARD_TOPOLOGY and the id helpers live in topology.ts.
//
// Axial (q, r), pointy-top hexes, r grows "south"; s = -q-r is implicit. Land = radius 2 (19 hexes).
// Neighbour directions: E(+1,0) W(-1,0) NE(+1,-1) NW(0,-1) SE(0,+1) SW(-1,+1).
// Canonical owners: each hex owns its N and S corners and its NE, NW and W sides. The other corners and sides map to a
// neighbour: NE(h)=S(NE(h)), NW(h)=S(NW(h)), SE(h)=N(SE(h)), SW(h)=N(SW(h)); E(h)=W(E(h)), SE(h)=NW(SE(h)),
// SW(h)=NE(SW(h)). The owner may be an off-board hex, so coastal vertices and edges still have exactly one id.

export type HexId = `h:${number},${number}`;
export type VertexId = `v:${number},${number},${'N' | 'S'}`;
export type EdgeId = `e:${number},${number},${'NE' | 'NW' | 'W'}`;
export type Seat = 0 | 1 | 2 | 3;

export interface Topology {
  /** 19 land hexes in CANONICAL HEX INDEX order: row-major, r ascending then q ascending. */
  readonly hexes: readonly HexId[];
  /** 54 vertices, sorted by (r, q, corner N before S). */
  readonly vertices: readonly VertexId[];
  /** 72 edges, sorted by (r, q, side NE, NW, W). */
  readonly edges: readonly EdgeId[];
  /** The 6 corners of a hex, clockwise from N. */
  hexCorners(h: HexId): readonly VertexId[];
  /** The 1–3 land hexes touching a vertex. */
  vertexHexes(v: VertexId): readonly HexId[];
  /** The 2–3 vertices one edge away. */
  vertexNeighbours(v: VertexId): readonly VertexId[];
  /** The 2–3 edges touching a vertex. */
  vertexEdges(v: VertexId): readonly EdgeId[];
  edgeVertices(e: EdgeId): readonly [VertexId, VertexId];
  /** Edge-adjacent land hexes only. */
  hexNeighbours(h: HexId): readonly HexId[];
  /** 30 coastal edges in PERIMETER ORDER: clockwise on screen from e:0,-2,NW (ADR-0001 rev 1.1). */
  readonly coastalEdges: readonly EdgeId[];
  /** 9 harbor slots = coastalEdges at positions 0,3,6,10,13,16,20,23,26, in that slot order (ADR-0001 rev 1.1). */
  readonly harborSlots: readonly EdgeId[];
}
