import { describe, expect, it } from 'vitest';
import { boardViewFixture } from '../testing/board-fixture';
import { legalTargets } from './legal-targets';

describe('legalTargets', () => {
  const { legal } = boardViewFixture();

  it('maps each pick mode to exactly one view.legal list', () => {
    expect([...legalTargets(legal, 'settlement').vertices]).toEqual(legal.placeSettlement);
    expect([...legalTargets(legal, 'city').vertices]).toEqual(legal.buildCity);
    expect([...legalTargets(legal, 'road').edges]).toEqual(legal.placeRoad);
    expect([...legalTargets(legal, 'robber').hexes]).toEqual(legal.moveRobber.map((m) => m.hex));
  });

  it('offers nothing without a pick mode', () => {
    const t = legalTargets(legal, null);
    expect(t.vertices.size + t.edges.size + t.hexes.size).toBe(0);
  });

  it('never mixes layers', () => {
    const t = legalTargets(legal, 'road');
    expect(t.vertices.size).toBe(0);
    expect(t.hexes.size).toBe(0);
  });
});
