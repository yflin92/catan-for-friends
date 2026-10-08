import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { STANDARD_TOPOLOGY } from '@hexlands/engine';
import { boardViewFixture } from '../testing/board-fixture';
import { SEAT_STYLE } from './art';
import { Board, type BoardView } from './Board';
import type { PickMode } from './legal-targets';

function render(view: BoardView, pick: PickMode | null): string {
  return renderToStaticMarkup(<Board view={view} pick={pick} />);
}

function attrValues(html: string, attr: string): string[] {
  return [...html.matchAll(new RegExp(`${attr}="([^"]*)"`, 'g'))].map((m) => m[1] ?? '');
}

describe('Board', () => {
  const view = boardViewFixture();

  it('draws every land hex, token, harbor and the robber from the view', () => {
    const html = render(view, null);
    expect(attrValues(html, 'data-hex').sort()).toEqual([...STANDARD_TOPOLOGY.hexes].sort());
    expect(attrValues(html, 'data-token').length).toBe(18);
    expect(attrValues(html, 'data-harbor')).toEqual([...STANDARD_TOPOLOGY.harborSlots]);
    expect(attrValues(html, 'data-robber')).toEqual([view.robber]);
    for (const h of view.board.harbors) {
      expect(html).toContain(`data-harbor="${h.edge}" data-harbor-kind="${h.kind}"`);
    }
    expect(html).toMatch(/>3:1</);
    expect(html).toMatch(/>2:1</);
  });

  it('draws each piece with its seat colour and seat label (not colour alone)', () => {
    const html = render(view, null);
    expect(attrValues(html, 'data-settlement').sort()).toEqual(Object.keys(view.pieces.settlements).sort());
    expect(attrValues(html, 'data-city')).toEqual(Object.keys(view.pieces.cities));
    expect(attrValues(html, 'data-road').sort()).toEqual(Object.keys(view.pieces.roads).sort());
    for (const [vx, seat] of Object.entries(view.pieces.settlements)) {
      const m = html.match(new RegExp(`data-settlement="${vx}" data-seat="${seat}".*?</g>`));
      expect(m?.[0]).toContain(`fill="${SEAT_STYLE[seat].fill}"`);
      expect(m?.[0]).toContain(`>${SEAT_STYLE[seat].label}</text>`);
    }
  });

  it('shows no targets when nothing is being picked', () => {
    const html = render(view, null);
    expect(html).not.toContain('data-target-');
  });

  it.each<[PickMode, string, readonly string[]]>([
    ['settlement', 'data-target-vertex', view.legal.placeSettlement],
    ['city', 'data-target-vertex', view.legal.buildCity],
    ['road', 'data-target-edge', view.legal.placeRoad],
    ['robber', 'data-target-hex', view.legal.moveRobber.map((m) => m.hex)],
  ])('the %s target layer matches view.legal exactly', (pick, attr, expected) => {
    const html = render(view, pick);
    expect(attrValues(html, attr).sort()).toEqual([...expected].sort());
    expect(attrValues(html, 'data-target-(?:vertex|edge|hex)').length).toBe(expected.length);
  });

  it('offers no targets when view.legal is empty, whatever the pick mode', () => {
    const empty = { ...view, legal: { ...view.legal, placeSettlement: [], buildCity: [], placeRoad: [], moveRobber: [] } };
    for (const pick of ['settlement', 'city', 'road', 'robber'] as const) {
      expect(render(empty, pick)).not.toContain('data-target-');
    }
  });

  it('uses only original, generic naming', () => {
    const html = render(view, 'robber').toLowerCase();
    expect(html).not.toContain('catan');
    for (const name of ['brick', 'lumber', 'wool', 'grain', 'ore']) expect(html).toContain(name);
  });
});
