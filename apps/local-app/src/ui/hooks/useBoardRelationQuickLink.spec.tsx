import { createRef, type PointerEvent as ReactPointerEvent } from 'react';
import { act, renderHook } from '@testing-library/react';
import type { EpicRelationDragOverlayHandle } from '@/ui/components/board/EpicRelationDragOverlay';
import { useBoardRelationQuickLink } from '@/ui/hooks/useBoardRelationQuickLink';
import type { Epic } from '@/ui/types';

function epic(id: string, title: string): Epic {
  return {
    id,
    projectId: 'project-1',
    title,
    description: null,
    statusId: 'status-1',
    version: 1,
    parentId: null,
    agentId: null,
    createdBy: null,
    tags: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const source = epic('source-epic', 'Source Epic');
const target = epic('target-epic', 'Target Epic');

function createHandle(): HTMLButtonElement {
  const handle = document.createElement('button');
  document.body.appendChild(handle);
  handle.setPointerCapture = jest.fn();
  handle.hasPointerCapture = jest.fn(() => true);
  handle.releasePointerCapture = jest.fn();
  handle.getBoundingClientRect = jest.fn(
    () =>
      ({
        left: 10,
        top: 20,
        width: 20,
        height: 10,
        right: 30,
        bottom: 30,
        x: 10,
        y: 20,
        toJSON: () => ({}),
      }) as DOMRect,
  );
  return handle;
}

function pointerEvent(
  handle: HTMLButtonElement,
  {
    x,
    y,
    pointerId = 1,
    button = 0,
  }: { x: number; y: number; pointerId?: number; button?: number },
): ReactPointerEvent<HTMLButtonElement> {
  return {
    currentTarget: handle,
    clientX: x,
    clientY: y,
    pointerId,
    button,
    stopPropagation: jest.fn(),
  } as unknown as ReactPointerEvent<HTMLButtonElement>;
}

function setup(visibleEpics: Epic[] = [source, target]) {
  const overlay: EpicRelationDragOverlayHandle = {
    show: jest.fn(),
    update: jest.fn(),
    hide: jest.fn(),
  };
  const overlayRef = createRef<EpicRelationDragOverlayHandle>();
  overlayRef.current = overlay;
  let renderCount = 0;
  const hook = renderHook(
    ({ visible }: { visible: Epic[] }) => {
      renderCount += 1;
      return useBoardRelationQuickLink(visible, overlayRef);
    },
    { initialProps: { visible: visibleEpics } },
  );
  return { ...hook, overlay, overlayRef, getRenderCount: () => renderCount };
}

describe('useBoardRelationQuickLink', () => {
  afterEach(() => {
    document.body.replaceChildren();
    jest.restoreAllMocks();
  });

  it('uses a greater-than-six-pixel threshold and keeps pointer updates isolated', () => {
    const { result, overlay, getRenderCount } = setup();
    const handle = createHandle();
    const rendersBeforeGesture = getRenderCount();

    act(() => result.current.bindings.pointerDown(source, pointerEvent(handle, { x: 0, y: 0 })));
    act(() => result.current.bindings.pointerMove(pointerEvent(handle, { x: 6, y: 0 })));
    expect(overlay.show).not.toHaveBeenCalled();

    act(() => result.current.bindings.pointerMove(pointerEvent(handle, { x: 7, y: 0 })));
    expect(overlay.show).toHaveBeenCalledWith({ x: 20, y: 25 }, { x: 7, y: 0 });
    act(() => result.current.bindings.pointerMove(pointerEvent(handle, { x: 12, y: 4 })));
    expect(overlay.update).toHaveBeenCalledWith({ x: 12, y: 4 });
    expect(getRenderCount()).toBe(rendersBeforeGesture);
  });

  it('opens confirmation on a valid drop, hides first, and suppresses its generated click', () => {
    const { result, overlay } = setup();
    const handle = createHandle();
    const targetElement = document.createElement('div');
    targetElement.dataset.relationEpicId = target.id;
    document.body.appendChild(targetElement);
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: jest.fn(() => targetElement),
    });

    act(() => {
      result.current.bindings.pointerDown(source, pointerEvent(handle, { x: 0, y: 0 }));
      result.current.bindings.pointerMove(pointerEvent(handle, { x: 10, y: 0 }));
      result.current.bindings.pointerUp(pointerEvent(handle, { x: 30, y: 40 }));
      result.current.bindings.activate(source, handle);
    });

    expect(overlay.hide).toHaveBeenCalled();
    expect(result.current.confirmation).toEqual({ source, target });
    expect(result.current.bindings.selectionSourceId).toBeNull();
  });

  it('turns an armed click into target selection and restores source focus on Escape', async () => {
    const { result } = setup();
    const handle = createHandle();

    act(() => {
      result.current.bindings.pointerDown(source, pointerEvent(handle, { x: 1, y: 1 }));
      result.current.bindings.pointerUp(pointerEvent(handle, { x: 1, y: 1 }));
      result.current.bindings.activate(source, handle);
    });
    expect(result.current.bindings.selectionSourceId).toBe(source.id);

    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    await act(async () => Promise.resolve());
    expect(result.current.bindings.selectionSourceId).toBeNull();
    expect(document.activeElement).toBe(handle);
  });

  it('uses the same cancellation path for pointer loss, window changes, hidden sources, and unmount', () => {
    const { result, rerender, unmount, overlay } = setup();
    const handle = createHandle();

    act(() => {
      result.current.bindings.pointerDown(source, pointerEvent(handle, { x: 0, y: 0 }));
      result.current.bindings.pointerCancel();
    });
    expect(overlay.hide).toHaveBeenCalled();

    act(() => {
      result.current.bindings.pointerDown(source, pointerEvent(handle, { x: 0, y: 0 }));
      result.current.bindings.pointerMove(pointerEvent(handle, { x: 9, y: 0 }));
      result.current.bindings.lostPointerCapture();
    });
    expect(overlay.hide).toHaveBeenCalled();

    act(() => result.current.bindings.activate(source, handle));
    act(() => window.dispatchEvent(new Event('blur')));
    expect(result.current.bindings.selectionSourceId).toBeNull();

    act(() => result.current.bindings.activate(source, handle));
    act(() => window.dispatchEvent(new Event('resize')));
    expect(result.current.bindings.selectionSourceId).toBeNull();

    act(() => result.current.bindings.activate(source, handle));
    rerender({ visible: [target] });
    expect(result.current.bindings.selectionSourceId).toBeNull();

    act(() => result.current.bindings.activate(target, handle));
    unmount();
    expect(overlay.hide).toHaveBeenCalled();
  });

  it('cancels an invalid drop without opening confirmation', () => {
    const { result } = setup();
    const handle = createHandle();
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: jest.fn(() => null),
    });

    act(() => {
      result.current.bindings.pointerDown(source, pointerEvent(handle, { x: 0, y: 0 }));
      result.current.bindings.pointerMove(pointerEvent(handle, { x: 7, y: 0 }));
      result.current.bindings.pointerUp(pointerEvent(handle, { x: 99, y: 99 }));
    });

    expect(result.current.confirmation).toBeNull();
  });
});
