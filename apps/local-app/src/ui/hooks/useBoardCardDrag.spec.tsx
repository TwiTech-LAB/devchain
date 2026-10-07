import { type PointerEvent as ReactPointerEvent } from 'react';
import { act, fireEvent, renderHook } from '@testing-library/react';
import type { BoardCardDragPreviewHandle } from '@/ui/components/board/BoardCardDragPreview';
import type { BoardCardDragModel } from '@/ui/pages/board/board-page-presentation';
import { useBoardCardDrag } from '@/ui/hooks/useBoardCardDrag';
import type { Epic } from '@/ui/types';

// Hook unit tests exercise real window listeners and DOM hit testing without browser layout.
const epic: Epic = {
  id: 'epic',
  projectId: 'project',
  title: 'Epic',
  description: null,
  statusId: 'todo',
  version: 1,
  parentId: null,
  agentId: null,
  createdBy: null,
  tags: [],
  createdAt: '',
  updatedAt: '',
};

function setup() {
  const cardDrag = { start: jest.fn(), drop: jest.fn(), cancel: jest.fn() };
  const preview = { show: jest.fn(), update: jest.fn(), hide: jest.fn() };
  const previewRef: { current: BoardCardDragPreviewHandle | null } = { current: preview };
  const scrollContainer = document.createElement('div');
  const scrollContainerRef: { current: HTMLDivElement | null } = { current: scrollContainer };
  const source = document.createElement('div');
  source.dataset.boardCardDragSource = '';
  source.setPointerCapture = jest.fn();
  const title = document.createElement('button');
  source.appendChild(title);
  scrollContainer.appendChild(source);
  document.body.appendChild(scrollContainer);
  const column = document.createElement('div');
  column.dataset.boardDropStatusId = 'done';
  document.body.appendChild(column);
  const hit = jest.fn((): Element | null => column);
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: hit });
  const hook = renderHook(
    ({ visible, callbacks }: { visible: Epic[]; callbacks: BoardCardDragModel }) =>
      useBoardCardDrag(visible, callbacks, previewRef, scrollContainerRef),
    { initialProps: { visible: [epic], callbacks: cardDrag } },
  );
  const down = (
    overrides: Partial<ReactPointerEvent<HTMLElement>> = {},
    fence?: { current: boolean },
  ) => {
    act(() =>
      hook.result.current.pointerDown(
        epic,
        {
          currentTarget: source,
          target: title,
          button: 0,
          isPrimary: true,
          pointerId: 1,
          clientX: 10,
          clientY: 20,
          ...overrides,
        } as ReactPointerEvent<HTMLElement>,
        fence,
      ),
    );
  };
  const pointer = (type: string, x = 20, y = 20, pointerId = 1) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { clientX: x, clientY: y, pointerId });
    act(() => window.dispatchEvent(event));
  };
  return {
    ...hook,
    cardDrag,
    preview,
    source,
    title,
    column,
    hit,
    down,
    pointer,
    scrollContainerRef,
  };
}

describe('useBoardCardDrag', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    document.body.replaceChildren();
  });

  it.each(['secondary', 'button', 'portal', 'fence'] as const)('does not arm for %s', (rule) => {
    const h = setup();
    const overrides =
      rule === 'secondary'
        ? { isPrimary: false }
        : rule === 'button'
          ? { button: 2 }
          : rule === 'portal'
            ? { target: document.body }
            : {};
    h.down(overrides, rule === 'fence' ? { current: true } : undefined);
    h.pointer('pointermove');
    h.pointer('pointerup');
    expect(h.cardDrag.start).not.toHaveBeenCalled();
    expect(h.cardDrag.drop).not.toHaveBeenCalled();
  });

  it('starts only beyond six pixels, ignores other pointers, and never captures the title click', () => {
    const h = setup();
    h.down();
    h.pointer('pointermove', 50, 20, 2);
    h.pointer('pointermove', 16);
    expect(h.cardDrag.start).not.toHaveBeenCalled();
    h.pointer('pointermove', 17);
    expect(h.cardDrag.start).toHaveBeenCalledWith(epic);
    expect(h.preview.show).toHaveBeenCalledWith(h.source, { x: 10, y: 20 }, { x: 17, y: 20 });
    expect(h.source.setPointerCapture).not.toHaveBeenCalled();
    h.pointer('pointermove', 25);
    expect(h.preview.update).toHaveBeenCalledWith({ x: 25, y: 20 });
  });

  it('keeps a short press as a normal click', () => {
    const h = setup();
    const click = jest.fn();
    h.title.addEventListener('click', click);
    h.down();
    h.pointer('pointermove', 16);
    h.pointer('pointerup', 16);
    fireEvent.click(h.title);
    expect(click).toHaveBeenCalledTimes(1);
    expect(h.cardDrag.start).not.toHaveBeenCalled();
    expect(h.cardDrag.cancel).not.toHaveBeenCalled();
  });

  it.each(['div'])('drops on a %s column using the gesture epic before a state render', (tag) => {
    const h = setup();
    const target = document.createElement(tag);
    target.dataset.boardDropStatusId = 'target';
    const child = document.createElement('span');
    target.appendChild(child);
    h.hit.mockReturnValue(child);
    act(() => {
      h.down();
      h.pointer('pointermove');
      h.pointer('pointerup', 80, 90);
    });
    expect(h.cardDrag.drop).toHaveBeenCalledWith(epic, 'target');
    expect(h.hit).toHaveBeenLastCalledWith(80, 90);
    expect(h.preview.hide).toHaveBeenCalledTimes(1);
    expect(target).not.toHaveAttribute('data-board-drop-active');
    expect(document.querySelector('[data-board-drop-active]')).toBeNull();
  });

  it('coalesces movement hit tests, clears outside highlights, and rechecks scroll and release', () => {
    const h = setup();
    h.down();
    h.pointer('pointermove', 20);
    h.pointer('pointermove', 30);
    expect(h.hit).not.toHaveBeenCalled();
    act(() => jest.advanceTimersByTime(16));
    expect(h.hit).toHaveBeenCalledTimes(1);
    expect(h.column).toHaveAttribute('data-board-drop-active');
    h.pointer('pointermove', 40);
    act(() => jest.advanceTimersByTime(16));
    expect(h.hit).toHaveBeenCalledTimes(2);
    expect(h.column).toHaveAttribute('data-board-drop-active');
    h.hit.mockReturnValue(null);
    fireEvent.scroll(h.scrollContainerRef.current!);
    expect(h.column).not.toHaveAttribute('data-board-drop-active');
    expect(h.cardDrag.cancel).not.toHaveBeenCalled();
    h.hit.mockReturnValue(h.column);
    fireEvent.scroll(h.source);
    expect(h.column).toHaveAttribute('data-board-drop-active');
    h.hit.mockReturnValue(null);
    h.pointer('pointerup', 999, 888);
    expect(h.hit).toHaveBeenLastCalledWith(999, 888);
    expect(h.cardDrag.cancel).toHaveBeenCalledTimes(1);
    expect(h.cardDrag.drop).not.toHaveBeenCalled();
    expect(document.querySelector('[data-board-drop-active]')).toBeNull();
  });

  it.each(['Escape', 'blur', 'pointercancel', 'hidden', 'unmount'])(
    'cancels on %s and removes active listeners, frames, and the drop highlight',
    (reason) => {
      const h = setup();
      h.down();
      h.pointer('pointermove');
      act(() => jest.advanceTimersByTime(16));
      expect(h.column).toHaveAttribute('data-board-drop-active');
      if (reason === 'Escape') fireEvent.keyDown(window, { key: 'Escape' });
      if (reason === 'blur') fireEvent.blur(window);
      if (reason === 'pointercancel') h.pointer('pointercancel');
      if (reason === 'hidden') h.rerender({ visible: [], callbacks: h.cardDrag });
      if (reason === 'unmount') h.unmount();
      h.pointer('pointermove', 50);
      h.pointer('pointerup', 50);
      act(() => jest.runOnlyPendingTimers());
      expect(h.cardDrag.cancel).toHaveBeenCalledTimes(1);
      expect(h.cardDrag.drop).not.toHaveBeenCalled();
      expect(h.preview.hide).toHaveBeenCalledTimes(1);
      expect(h.column).not.toHaveAttribute('data-board-drop-active');
    },
  );

  it('suppresses the generated click before child actions and permits the next click', () => {
    const h = setup();
    const click = jest.fn((event: Event) => event.stopPropagation());
    h.title.addEventListener('click', click);
    h.down();
    h.pointer('pointermove');
    h.pointer('pointerup');
    expect(fireEvent.click(h.title)).toBe(false);
    expect(click).not.toHaveBeenCalled();
    fireEvent.click(h.title);
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('removes unused click suppression on the next task', () => {
    const h = setup();
    const click = jest.fn();
    h.title.addEventListener('click', click);
    h.down();
    h.pointer('pointermove');
    h.pointer('pointerup');
    act(() => jest.advanceTimersByTime(0));
    fireEvent.click(h.title);
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('reads refreshed callbacks throughout an armed gesture', () => {
    const h = setup();
    h.down();
    const next = { start: jest.fn(), drop: jest.fn(), cancel: jest.fn() };
    h.rerender({ visible: [epic], callbacks: next });
    h.pointer('pointermove');
    h.pointer('pointerup');
    expect(next.start).toHaveBeenCalledWith(epic);
    expect(next.drop).toHaveBeenCalledWith(epic, 'done');
    expect(h.cardDrag.start).not.toHaveBeenCalled();
    expect(h.column).not.toHaveAttribute('data-board-drop-active');
  });

  describe('horizontal edge scrolling', () => {
    function scrollingBoard() {
      const h = setup();
      const container = h.scrollContainerRef.current!;
      container.classList.add('overflow-x-auto', 'snap-x', 'snap-mandatory');
      container.getBoundingClientRect = jest.fn(
        () =>
          ({
            left: 100,
            right: 500,
            top: 10,
            bottom: 310,
            width: 400,
            height: 300,
          }) as DOMRect,
      );
      let position = 120;
      const scrollStep = jest.fn((value: number) => {
        position = Math.max(0, Math.min(240, value));
      });
      Object.defineProperty(container, 'scrollLeft', {
        configurable: true,
        get: () => position,
        set: scrollStep,
      });
      const start = (x: number, y = 100) => {
        h.down({ clientX: 300, clientY: 100 });
        h.pointer('pointermove', x, y);
      };
      return { ...h, container, scrollStep, start };
    }

    it.each([
      [100, 100, 108],
      [148, 100, 108],
      [149, 100, 120],
      [300, 100, 120],
      [451, 100, 120],
      [452, 100, 132],
      [500, 100, 132],
      [99, 100, 120],
      [501, 100, 120],
      [480, 9, 120],
      [480, 311, 120],
    ])('scrolls only inside the edge zone at (%i, %i)', (x, y, expected) => {
      const h = scrollingBoard();
      h.start(x, y);
      expect(h.container.scrollLeft).toBe(120);
      act(() => jest.advanceTimersByTime(16));
      expect(h.container.scrollLeft).toBe(expected);
      expect(h.container.scrollTop).toBe(0);
      if (expected === 120) expect(h.scrollStep).not.toHaveBeenCalled();
    });

    it('keeps scrolling a still pointer by a fixed step each frame and stops outside the zone', () => {
      const h = scrollingBoard();
      h.start(480);
      act(() => jest.advanceTimersByTime(16));
      expect(h.container.scrollLeft).toBe(132);
      act(() => jest.advanceTimersByTime(16));
      expect(h.container.scrollLeft).toBe(144);
      h.pointer('pointermove', 300, 100);
      act(() => jest.advanceTimersByTime(48));
      expect(h.container.scrollLeft).toBe(144);
      expect(h.scrollStep).toHaveBeenCalledTimes(2);
      h.pointer('pointermove', 110, 100);
      act(() => jest.advanceTimersByTime(16));
      expect(h.container.scrollLeft).toBe(132);
    });

    it('uses the scroll hit-test path after each step to track the column under a still pointer', () => {
      const h = scrollingBoard();
      const nextColumn = document.createElement('div');
      nextColumn.dataset.boardDropStatusId = 'next';
      h.hit.mockImplementation(() => (h.container.scrollLeft >= 144 ? nextColumn : h.column));
      h.start(480);
      act(() => jest.advanceTimersByTime(16));
      expect(h.column).toHaveAttribute('data-board-drop-active');
      expect(nextColumn).not.toHaveAttribute('data-board-drop-active');
      expect(h.hit).toHaveBeenCalledTimes(1);
      act(() => jest.advanceTimersByTime(16));
      expect(h.column).not.toHaveAttribute('data-board-drop-active');
      expect(nextColumn).toHaveAttribute('data-board-drop-active');
      expect(h.hit).toHaveBeenCalledTimes(2);
      expect(h.hit).toHaveBeenLastCalledWith(480, 100);
      expect(h.cardDrag.cancel).not.toHaveBeenCalled();
    });

    it.each(['drop', 'outside', 'Escape', 'blur', 'pointercancel', 'hidden', 'unmount'])(
      'stops the scroll loop and restores snapping on %s',
      (reason) => {
        const h = scrollingBoard();
        h.start(480);
        expect(h.container).toHaveClass('snap-none');
        expect(h.container).not.toHaveClass('snap-x');
        expect(h.container).not.toHaveClass('snap-mandatory');
        act(() => jest.advanceTimersByTime(16));
        expect(h.container.scrollLeft).toBe(132);
        if (reason === 'drop') h.pointer('pointerup', 480, 100);
        if (reason === 'outside') {
          h.hit.mockReturnValue(null);
          h.pointer('pointerup', 999, 100);
        }
        if (reason === 'Escape') fireEvent.keyDown(window, { key: 'Escape' });
        if (reason === 'blur') fireEvent.blur(window);
        if (reason === 'pointercancel') h.pointer('pointercancel', 480, 100);
        if (reason === 'hidden') h.rerender({ visible: [], callbacks: h.cardDrag });
        if (reason === 'unmount') h.unmount();
        act(() => jest.advanceTimersByTime(64));
        expect(h.container.scrollLeft).toBe(132);
        expect(h.scrollStep).toHaveBeenCalledTimes(1);
        expect(h.container).toHaveClass('snap-x', 'snap-mandatory', 'overflow-x-auto');
        expect(h.container).not.toHaveClass('snap-none');
        if (reason === 'drop') expect(h.cardDrag.drop).toHaveBeenCalledWith(epic, 'done');
        else expect(h.cardDrag.cancel).toHaveBeenCalledTimes(1);
      },
    );

    it('keeps scrolling and snapping unchanged on an armed short press', () => {
      const h = scrollingBoard();
      h.down({ clientX: 480, clientY: 100 });
      h.pointer('pointermove', 484, 100);
      act(() => jest.advanceTimersByTime(32));
      h.pointer('pointerup', 484, 100);
      expect(h.scrollStep).not.toHaveBeenCalled();
      expect(h.container).toHaveClass('snap-x', 'snap-mandatory');
      expect(h.container).not.toHaveClass('snap-none');
    });

    it('stops requesting frames at a scroll boundary', () => {
      const h = scrollingBoard();
      h.start(480);
      act(() => jest.advanceTimersByTime(176));
      expect(h.container.scrollLeft).toBe(240);
      const attempts = h.scrollStep.mock.calls.length;
      act(() => jest.advanceTimersByTime(48));
      expect(h.scrollStep).toHaveBeenCalledTimes(attempts);
    });
  });
});
