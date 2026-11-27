import { act } from '@testing-library/react';

export function rect(top: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    height,
    left: 0,
    right: 0,
    width: 0,
    x: 0,
    y: top,
  } as DOMRect;
}

export interface LayoutMock {
  /** Fixed rects for specific elements; they win over the computed height. */
  rects: Map<Element, DOMRect>;
  /** Fires every ResizeObserver callback, as a content or width change would. */
  resizeAll(): void;
  restore(): void;
}

/**
 * jsdom has no layout. An element's height is the `data-height` of its first child
 * when set, otherwise 1px per character of its text, so long text overflows a cap.
 */
export function installLayoutMock(): LayoutMock {
  const observers: Array<{ cb: ResizeObserverCallback }> = [];
  const rects = new Map<Element, DOMRect>();
  const original = (global as { ResizeObserver?: unknown }).ResizeObserver;

  global.ResizeObserver = class {
    cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb;
      observers.push(this);
    }
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver;

  const spy = jest.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: Element,
  ) {
    const known = rects.get(this);
    if (known) return known;
    const declared = (this.firstElementChild as HTMLElement | null)?.dataset?.height;
    return rect(0, declared !== undefined ? Number(declared) : (this.textContent?.length ?? 0));
  });

  return {
    rects,
    resizeAll() {
      act(() => observers.forEach((o) => o.cb([], o as unknown as ResizeObserver)));
    },
    restore() {
      spy.mockRestore();
      (global as { ResizeObserver?: unknown }).ResizeObserver = original;
    },
  };
}
