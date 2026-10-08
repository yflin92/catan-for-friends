// Board geometry for the SVG renderer, built only from the engine's STANDARD_TOPOLOGY and pixel helpers (ADR-0001).
import { STANDARD_TOPOLOGY, edgeToPixels, hexToPixel, vertexToPixel, type EdgeId, type HexId } from '@hexlands/engine';

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Hex circumradius in SVG user units. */
export const HEX_SIZE = 100;

/** The ring of off-board hexes at distance 3 from the centre: the sea frame around the 19 land hexes. */
export const SEA_HEXES: readonly HexId[] = (() => {
  const out: HexId[] = [];
  for (let r = -3; r <= 3; r++) {
    for (let q = -3; q <= 3; q++) {
      if (Math.max(Math.abs(q), Math.abs(r), Math.abs(-q - r)) === 3) out.push(`h:${q},${r}`);
    }
  }
  return out;
})();

/** Corner points of any hex (land or sea), clockwise from N, for a pointy-top hex of circumradius `size`. */
export function hexCornerPoints(h: HexId, size: number = HEX_SIZE): readonly Point[] {
  const c = hexToPixel(h, size);
  const out: Point[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * (60 * i - 90);
    out.push({ x: c.x + size * Math.cos(a), y: c.y + size * Math.sin(a) });
  }
  return out;
}

export function toPointsAttr(points: readonly Point[]): string {
  return points.map((p) => `${round(p.x)},${round(p.y)}`).join(' ');
}

export function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** The rectangle that encloses the sea frame, used as the fully zoomed-out viewBox. */
export function boardBounds(size: number = HEX_SIZE): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const h of SEA_HEXES) {
    for (const p of hexCornerPoints(h, size)) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function edgeMidpoint(e: EdgeId, size: number = HEX_SIZE): Point {
  const [a, b] = edgeToPixels(e, size);
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * Where a harbor marker sits: pushed from the edge midpoint away from the land hex the edge borders, so it lands in
 * the sea.
 */
export function harborAnchor(e: EdgeId, size: number = HEX_SIZE): Point {
  const mid = edgeMidpoint(e, size);
  const [va, vb] = STANDARD_TOPOLOGY.edgeVertices(e);
  const land = STANDARD_TOPOLOGY.vertexHexes(va).find((h) => STANDARD_TOPOLOGY.vertexHexes(vb).includes(h));
  const from = land !== undefined ? hexToPixel(land, size) : { x: 0, y: 0 };
  const dx = mid.x - from.x;
  const dy = mid.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const push = size * 0.55;
  return { x: mid.x + (dx / len) * push, y: mid.y + (dy / len) * push };
}

/** Probability dots shown under a number token: 6 − |7 − n|. */
export function tokenPips(n: number): number {
  return 6 - Math.abs(7 - n);
}

export { edgeToPixels, hexToPixel, vertexToPixel };
