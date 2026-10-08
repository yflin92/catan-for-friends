import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { STANDARD_TOPOLOGY } from '@hexlands/engine';
import { boardViewFixture } from '../testing/board-fixture';
import { Board } from './Board';
import { edgeLabel, hexLabel, vertexLabel } from './labels';
import type { PickMode } from './legal-targets';

const RAW_ID = /\b[hve]:-?\d+,-?\d+/;
const view = boardViewFixture();
const hexes = view.board.hexes;

describe('board labels', () => {
  it('no aria-label on the board exposes a raw id, in any pick mode', () => {
    for (const pick of ['settlement', 'city', 'road', 'robber', null] as (PickMode | null)[]) {
      const html = renderToStaticMarkup(<Board view={view} pick={pick} />);
      const labels = [...html.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1] ?? '');
      expect(labels.length).toBeGreaterThan(0);
      for (const l of labels) expect(l).not.toMatch(RAW_ID);
    }
  });

  it('every corner, side and hex has a distinct readable name', () => {
    const v = STANDARD_TOPOLOGY.vertices.map((x) => vertexLabel(hexes, x));
    const e = STANDARD_TOPOLOGY.edges.map((x) => edgeLabel(hexes, x));
    const h = STANDARD_TOPOLOGY.hexes.map((x) => hexLabel(hexes, x, view.robber));
    expect(new Set(v).size).toBe(v.length);
    expect(new Set(e).size).toBe(e.length);
    expect(new Set(h.filter((l) => !l.includes('(robber)'))).size).toBeGreaterThan(0);
    for (const l of [...v, ...e, ...h]) expect(l).not.toMatch(RAW_ID);
  });

  it('describes places by resource and number', () => {
    const desert = view.robber;
    expect(hexLabel(hexes, desert, desert)).toBe('Hex: desert (robber)');
    const first = hexes[0]!;
    expect(hexLabel(hexes, first.id, desert)).toBe(`Hex: ore ${first.token}`);
    expect(vertexLabel(hexes, STANDARD_TOPOLOGY.hexCorners(first.id)[0]!)).toBe(`corner north of ore ${first.token}`);
  });
});
