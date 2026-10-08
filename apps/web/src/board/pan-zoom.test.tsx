// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { boardViewFixture } from '../testing/board-fixture';
import { Board } from './Board';
import { boardBounds } from './geometry';

// React's act() warns unless the environment opts in.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FULL = boardBounds();
let container: HTMLDivElement;
let root: Root;

function svg(): SVGSVGElement {
  const el = container.querySelector('svg');
  if (el === null) throw new Error('no svg');
  return el;
}

function viewBox(): number[] {
  return (svg().getAttribute('viewBox') ?? '').split(' ').map(Number);
}

function pointer(type: string, id: number, x: number, y: number): Event {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
  Object.defineProperty(e, 'pointerId', { value: id });
  return e;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, width: 800, height: 800, right: 800, bottom: 800, x: 0, y: 0, toJSON: () => ({}),
  } as DOMRect);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function mount(onPickVertex = vi.fn()) {
  act(() => root.render(<Board view={boardViewFixture()} pick="settlement" onPickVertex={onPickVertex} />));
  return onPickVertex;
}

describe('Board pan and zoom', () => {
  it('starts fitted to the whole board', () => {
    mount();
    const [, , w, h] = viewBox();
    expect(w).toBeCloseTo(FULL.w, 1);
    expect(h).toBeCloseTo(FULL.h, 1);
  });

  it('zoom buttons zoom in, out and back to fit', () => {
    mount();
    const [zoomIn, zoomOut, fit] = [...container.querySelectorAll('.board-controls button')] as HTMLButtonElement[];
    act(() => zoomIn!.click());
    expect(viewBox()[2]).toBeLessThan(FULL.w);
    act(() => zoomIn!.click());
    const zoomed = viewBox()[2]!;
    act(() => zoomOut!.click());
    expect(viewBox()[2]).toBeGreaterThan(zoomed);
    act(() => fit!.click());
    expect(viewBox()[2]).toBeCloseTo(FULL.w, 1);
  });

  it('the mouse wheel zooms', () => {
    mount();
    act(() => {
      svg().dispatchEvent(new WheelEvent('wheel', { deltaY: -100, clientX: 400, clientY: 400, bubbles: true, cancelable: true }));
    });
    expect(viewBox()[2]).toBeLessThan(FULL.w);
  });

  it('dragging pans when zoomed in, and the click that ends a drag does not pick', () => {
    const onPick = mount();
    act(() => (container.querySelector('.board-controls button') as HTMLButtonElement).click());
    const [x0, y0] = viewBox();
    const s = svg();
    act(() => {
      s.dispatchEvent(pointer('pointerdown', 1, 400, 400));
      s.dispatchEvent(pointer('pointermove', 1, 450, 430));
      s.dispatchEvent(pointer('pointermove', 1, 500, 460));
      s.dispatchEvent(pointer('pointerup', 1, 500, 460));
    });
    const [x1, y1] = viewBox();
    expect(x1).toBeLessThan(x0!);
    expect(y1).toBeLessThan(y0!);
    const target = container.querySelector('[data-target-vertex]') as SVGGElement;
    act(() => target.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onPick).not.toHaveBeenCalled();
  });

  it('a tap without movement picks the legal target', () => {
    const onPick = mount();
    const target = container.querySelector('[data-target-vertex]') as SVGGElement;
    const s = svg();
    act(() => {
      s.dispatchEvent(pointer('pointerdown', 1, 100, 100));
      s.dispatchEvent(pointer('pointermove', 1, 102, 101));
      s.dispatchEvent(pointer('pointerup', 1, 102, 101));
      target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onPick).toHaveBeenCalledWith(target.getAttribute('data-target-vertex'));
  });

  it('a two-pointer pinch zooms in', () => {
    mount();
    const s = svg();
    act(() => {
      s.dispatchEvent(pointer('pointerdown', 1, 300, 400));
      s.dispatchEvent(pointer('pointerdown', 2, 500, 400));
      s.dispatchEvent(pointer('pointermove', 2, 700, 400));
    });
    expect(viewBox()[2]).toBeLessThan(FULL.w);
  });

  it('targets are keyboard-operable', () => {
    const onPick = mount();
    const target = container.querySelector('[data-target-vertex]') as SVGGElement;
    act(() => target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(onPick).toHaveBeenCalledTimes(1);
  });
});
