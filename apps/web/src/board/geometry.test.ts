import { describe, expect, it } from 'vitest';
import { STANDARD_TOPOLOGY, hexToPixel, vertexToPixel } from '@hexlands/engine';
import { boardBounds, harborAnchor, HEX_SIZE, hexCornerPoints, SEA_HEXES, tokenPips } from './geometry';

describe('board geometry', () => {
  it('the sea frame is the 18-hex ring around the land', () => {
    expect(SEA_HEXES.length).toBe(18);
    for (const h of SEA_HEXES) expect(STANDARD_TOPOLOGY.hexes).not.toContain(h);
  });

  it('hex corner points coincide with the engine vertex positions, clockwise from N', () => {
    for (const h of STANDARD_TOPOLOGY.hexes) {
      const corners = hexCornerPoints(h);
      STANDARD_TOPOLOGY.hexCorners(h).forEach((v, i) => {
        const p = vertexToPixel(v, HEX_SIZE);
        expect(corners[i]?.x).toBeCloseTo(p.x, 6);
        expect(corners[i]?.y).toBeCloseTo(p.y, 6);
      });
    }
  });

  it('harbor markers sit farther from the centre than their edge', () => {
    for (const e of STANDARD_TOPOLOGY.harborSlots) {
      const m = harborAnchor(e);
      const [a, b] = STANDARD_TOPOLOGY.edgeVertices(e).map((v) => vertexToPixel(v, HEX_SIZE));
      const mid = { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 };
      expect(Math.hypot(m.x, m.y)).toBeGreaterThan(Math.hypot(mid.x, mid.y));
    }
  });

  it('the board bounds contain every land hex centre', () => {
    const r = boardBounds();
    for (const h of STANDARD_TOPOLOGY.hexes) {
      const c = hexToPixel(h, HEX_SIZE);
      expect(c.x).toBeGreaterThan(r.x);
      expect(c.x).toBeLessThan(r.x + r.w);
      expect(c.y).toBeGreaterThan(r.y);
      expect(c.y).toBeLessThan(r.y + r.h);
    }
  });

  it('token pips follow 6 − |7 − n|', () => {
    expect([2, 3, 4, 5, 6, 8, 9, 10, 11, 12].map(tokenPips)).toEqual([1, 2, 3, 4, 5, 5, 4, 3, 2, 1]);
  });
});
