// Pan and zoom as pure viewBox arithmetic. The viewBox never gets larger than the full board (zoom ≥ 1) or smaller
// than 1/MAX_ZOOM of it, and its centre stays within the board.
import type { Point, Rect } from './geometry';

export const MAX_ZOOM = 4;
export const ZOOM_STEP = 1.25;

export function zoomOf(view: Rect, full: Rect): number {
  return full.w / view.w;
}

/** Keeps the zoom within [1, MAX_ZOOM] and the centre of `view` inside `full`. */
export function clampView(view: Rect, full: Rect): Rect {
  const zoom = Math.min(MAX_ZOOM, Math.max(1, full.w / view.w));
  const w = full.w / zoom;
  const h = full.h / zoom;
  const cx = Math.min(full.x + full.w, Math.max(full.x, view.x + view.w / 2));
  const cy = Math.min(full.y + full.h, Math.max(full.y, view.y + view.h / 2));
  if (zoom === 1) return { ...full };
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/** Zooms by `factor` (> 1 = in) keeping the board point `at` fixed on screen. */
export function zoomAt(view: Rect, full: Rect, factor: number, at: Point): Rect {
  const target = Math.min(MAX_ZOOM, Math.max(1, zoomOf(view, full) * factor));
  const scale = full.w / target / view.w;
  const next = {
    x: at.x - (at.x - view.x) * scale,
    y: at.y - (at.y - view.y) * scale,
    w: view.w * scale,
    h: view.h * scale,
  };
  return clampView(next, full);
}

/** Moves the view by a screen-space drag of (dx, dy) board units (positive = content moves right/down). */
export function panBy(view: Rect, full: Rect, dx: number, dy: number): Rect {
  return clampView({ ...view, x: view.x - dx, y: view.y - dy }, full);
}

export function centreOf(r: Rect): Point {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

/** Maps a client (CSS pixel) position inside an element showing `view` with preserveAspectRatio="xMidYMid meet". */
export function clientToBoard(view: Rect, el: { left: number; top: number; width: number; height: number }, cx: number, cy: number): Point {
  const scale = Math.min(el.width / view.w, el.height / view.h) || 1;
  const offX = (el.width - view.w * scale) / 2;
  const offY = (el.height - view.h * scale) / 2;
  return { x: view.x + (cx - el.left - offX) / scale, y: view.y + (cy - el.top - offY) / scale };
}

/** Board units per CSS pixel for the same mapping. */
export function unitsPerPixel(view: Rect, el: { width: number; height: number }): number {
  const scale = Math.min(el.width / view.w, el.height / view.h);
  return scale > 0 ? 1 / scale : 1;
}
