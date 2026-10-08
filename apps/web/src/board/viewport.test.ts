import { describe, expect, it } from 'vitest';
import { centreOf, clampView, clientToBoard, MAX_ZOOM, panBy, zoomAt, zoomOf } from './viewport';

const FULL = { x: -500, y: -400, w: 1000, h: 800 };

describe('viewport', () => {
  it('starts fully zoomed out; panning at zoom 1 does nothing', () => {
    expect(panBy(FULL, FULL, 100, 50)).toEqual(FULL);
  });

  it('zooms around a fixed point', () => {
    const at = { x: 100, y: 100 };
    const z = zoomAt(FULL, FULL, 2, at);
    expect(zoomOf(z, FULL)).toBeCloseTo(2);
    // The board point stays at the same relative screen position.
    expect((at.x - z.x) / z.w).toBeCloseTo((at.x - FULL.x) / FULL.w);
    expect((at.y - z.y) / z.h).toBeCloseTo((at.y - FULL.y) / FULL.h);
  });

  it('clamps zoom to [1, MAX_ZOOM]', () => {
    let v = FULL;
    for (let i = 0; i < 50; i++) v = zoomAt(v, FULL, 1.5, centreOf(v));
    expect(zoomOf(v, FULL)).toBeCloseTo(MAX_ZOOM);
    for (let i = 0; i < 50; i++) v = zoomAt(v, FULL, 1 / 1.5, centreOf(v));
    expect(v).toEqual(FULL);
  });

  it('pans when zoomed in, keeping the centre on the board', () => {
    const z = zoomAt(FULL, FULL, 2, centreOf(FULL));
    const p = panBy(z, FULL, 100, 0);
    expect(p.x).toBeCloseTo(z.x - 100);
    const far = panBy(z, FULL, -1e6, -1e6);
    const c = centreOf(far);
    expect(c.x).toBeCloseTo(FULL.x + FULL.w);
    expect(c.y).toBeCloseTo(FULL.y + FULL.h);
  });

  it('clampView keeps the aspect ratio of the full board', () => {
    const v = clampView({ x: 0, y: 0, w: 250, h: 999 }, FULL);
    expect(v.w / v.h).toBeCloseTo(FULL.w / FULL.h);
  });

  it('maps client pixels to board units with letterboxing', () => {
    // 1000×800 board shown in a 500×500 box: scale 0.5, vertical letterbox of 50 px.
    const el = { left: 10, top: 20, width: 500, height: 500 };
    expect(clientToBoard(FULL, el, 10, 70)).toEqual({ x: -500, y: -400 });
    expect(clientToBoard(FULL, el, 260, 270)).toEqual({ x: 0, y: 0 });
  });
});
