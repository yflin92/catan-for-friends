// Pan and zoom for the board SVG: mouse wheel and pinch zoom, pointer-drag pan, and explicit zoom controls.
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import type { Point, Rect } from './geometry';
import { centreOf, clientToBoard, panBy, unitsPerPixel, zoomAt, ZOOM_STEP } from './viewport';

/** A drag shorter than this many CSS pixels still counts as a click on a board target. */
export const CLICK_SLOP_PX = 6;

export interface PanZoom {
  readonly view: Rect;
  zoomIn(): void;
  zoomOut(): void;
  reset(): void;
  readonly handlers: {
    onPointerDown(e: ReactPointerEvent<SVGSVGElement>): void;
    onPointerMove(e: ReactPointerEvent<SVGSVGElement>): void;
    onPointerUp(e: ReactPointerEvent<SVGSVGElement>): void;
    onPointerCancel(e: ReactPointerEvent<SVGSVGElement>): void;
    onClickCapture(e: { stopPropagation(): void; preventDefault(): void }): void;
  };
}

interface Pointer {
  readonly start: Point;
  last: Point;
}

export function usePanZoom(svgRef: RefObject<SVGSVGElement | null>, full: Rect): PanZoom {
  const [view, setView] = useState<Rect>(full);
  const viewRef = useRef(view);
  viewRef.current = view;
  const pointers = useRef(new Map<number, Pointer>());
  const dragged = useRef(false);

  const rect = () => svgRef.current?.getBoundingClientRect() ?? { left: 0, top: 0, width: 0, height: 0 };

  const zoomIn = useCallback(() => setView((v) => zoomAt(v, full, ZOOM_STEP, centreOf(v))), [full]);
  const zoomOut = useCallback(() => setView((v) => zoomAt(v, full, 1 / ZOOM_STEP, centreOf(v))), [full]);
  const reset = useCallback(() => setView(full), [full]);

  // React registers wheel listeners as passive, so preventDefault needs a native listener.
  useEffect(() => {
    const svg = svgRef.current;
    if (svg === null) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
      setView((v) => zoomAt(v, full, factor, clientToBoard(v, r, e.clientX, e.clientY)));
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [svgRef, full]);

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    const p = { x: e.clientX, y: e.clientY };
    pointers.current.set(e.pointerId, { start: p, last: p });
    if (pointers.current.size === 1) dragged.current = false;
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const ptr = pointers.current.get(e.pointerId);
    if (ptr === undefined) return;
    const now = { x: e.clientX, y: e.clientY };
    const r = rect();
    if (pointers.current.size === 1) {
      if (!dragged.current && Math.hypot(now.x - ptr.start.x, now.y - ptr.start.y) < CLICK_SLOP_PX) return;
      if (!dragged.current) e.currentTarget.setPointerCapture?.(e.pointerId);
      dragged.current = true;
      const k = unitsPerPixel(viewRef.current, r);
      const dx = (now.x - ptr.last.x) * k;
      const dy = (now.y - ptr.last.y) * k;
      ptr.last = now;
      setView((v) => panBy(v, full, dx, dy));
      return;
    }
    // Pinch: zoom by the change in distance between the first two pointers, around their midpoint.
    const [a, b] = [...pointers.current.values()];
    if (a === undefined || b === undefined) return;
    const other = ptr === a ? b : a;
    const before = Math.hypot(ptr.last.x - other.last.x, ptr.last.y - other.last.y);
    const after = Math.hypot(now.x - other.last.x, now.y - other.last.y);
    ptr.last = now;
    dragged.current = true;
    if (before === 0) return;
    const mid = clientToBoard(viewRef.current, r, (now.x + other.last.x) / 2, (now.y + other.last.y) / 2);
    setView((v) => zoomAt(v, full, after / before, mid));
  };

  const onPointerEnd = (e: ReactPointerEvent<SVGSVGElement>) => {
    pointers.current.delete(e.pointerId);
  };

  // A click that ends a drag or pinch must not pick a target.
  const onClickCapture = (e: { stopPropagation(): void; preventDefault(): void }) => {
    if (dragged.current) {
      e.stopPropagation();
      e.preventDefault();
      dragged.current = false;
    }
  };

  return {
    view,
    zoomIn,
    zoomOut,
    reset,
    handlers: { onPointerDown, onPointerMove, onPointerUp: onPointerEnd, onPointerCancel: onPointerEnd, onClickCapture },
  };
}
