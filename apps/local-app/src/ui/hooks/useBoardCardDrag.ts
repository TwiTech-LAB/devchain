import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type RefObject,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type {
  BoardCardDragPreviewHandle,
  BoardCardPointerPoint,
} from '@/ui/components/board/BoardCardDragPreview';
import { DRAG_THRESHOLD_PX } from '@/ui/hooks/useBoardRelationQuickLink';
import type { BoardCardDragModel } from '@/ui/pages/board/board-page-presentation';
import type { Epic } from '@/ui/types';

const SCROLL_EDGE_PX = 48;
const SCROLL_STEP_PX = 12;
const DROP_COLUMN_SELECTOR = '[data-board-drop-status-id]';

interface CardGesture {
  epic: Epic;
  source: HTMLElement;
  pointerId: number;
  start: BoardCardPointerPoint;
  current: BoardCardPointerPoint;
  dragging: boolean;
  dropElement: HTMLElement | null;
  restoreScrollSnap: (() => void) | null;
  removeListeners: () => void;
}

// The drop highlight is gesture-owned DOM state: routing it through React
// state would re-render every card on each column crossing.
function pointDropAt(gesture: CardGesture, column: HTMLElement | null): void {
  if (gesture.dropElement === column) return;
  gesture.dropElement?.removeAttribute('data-board-drop-active');
  column?.setAttribute('data-board-drop-active', '');
  gesture.dropElement = column;
}

export interface BoardCardDragBindings {
  pointerDown(epic: Epic, event: ReactPointerEvent<HTMLElement>, fence?: RefObject<boolean>): void;
}

export function useBoardCardDrag(
  visibleEpics: readonly Epic[],
  cardDrag: BoardCardDragModel,
  previewRef: RefObject<BoardCardDragPreviewHandle | null>,
  scrollContainerRef: RefObject<HTMLElement | null>,
): BoardCardDragBindings {
  const cardDragRef = useRef(cardDrag);
  cardDragRef.current = cardDrag;
  const gestureRef = useRef<CardGesture | null>(null);
  const frameRef = useRef<number | null>(null);
  const removeClickSuppressionRef = useRef<(() => void) | null>(null);
  const visibleIds = useMemo(() => new Set(visibleEpics.map((epic) => epic.id)), [visibleEpics]);

  const hitTest = useCallback((point: BoardCardPointerPoint): string | null => {
    const column =
      document.elementFromPoint(point.x, point.y)?.closest<HTMLElement>(DROP_COLUMN_SELECTOR) ??
      null;
    const gesture = gestureRef.current;
    if (gesture) pointDropAt(gesture, column);
    return column?.dataset.boardDropStatusId ?? null;
  }, []);

  const suppressClick = useCallback((): void => {
    removeClickSuppressionRef.current?.();
    const listener = (event: MouseEvent): void => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener('click', listener, { capture: true, once: true });
    const remove = (): void => {
      window.clearTimeout(timer);
      window.removeEventListener('click', listener, true);
      removeClickSuppressionRef.current = null;
    };
    const timer = window.setTimeout(remove, 0);
    removeClickSuppressionRef.current = remove;
  }, []);

  const finish = useCallback(
    (release?: BoardCardPointerPoint): void => {
      const gesture = gestureRef.current;
      if (!gesture) return;
      const statusId = gesture.dragging && release ? hitTest(release) : null;
      gestureRef.current = null;
      gesture.removeListeners();
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      gesture.restoreScrollSnap?.();
      pointDropAt(gesture, null);
      if (!gesture.dragging) return;
      previewRef.current?.hide();
      suppressClick();
      if (statusId) cardDragRef.current.drop(gesture.epic, statusId);
      else cardDragRef.current.cancel();
    },
    [hitTest, previewRef, suppressClick],
  );

  const pointerDown = useCallback(
    (epic: Epic, event: ReactPointerEvent<HTMLElement>, fence?: RefObject<boolean>): void => {
      if (
        !event.isPrimary ||
        event.button !== 0 ||
        fence?.current ||
        !(event.target instanceof Node) ||
        !event.currentTarget.contains(event.target) ||
        gestureRef.current
      )
        return;
      const source =
        event.currentTarget.closest<HTMLElement>('[data-board-card-drag-source]') ??
        event.currentTarget;
      const scrollContainer = scrollContainerRef.current;
      // A pending frame hit-tests after its own scroll step, so a scroll event
      // only needs its own hit test when no frame is queued (a wheel scroll).
      const hitTestOnScroll = (): void => {
        const gesture = gestureRef.current;
        if (gesture?.dragging && frameRef.current === null) hitTest(gesture.current);
      };
      const edgeScroll = (point: BoardCardPointerPoint): boolean => {
        if (!scrollContainer) return false;
        const rect = scrollContainer.getBoundingClientRect();
        const inside =
          point.x >= rect.left &&
          point.x <= rect.right &&
          point.y >= rect.top &&
          point.y <= rect.bottom;
        if (!inside) return false;
        let step = 0;
        if (point.x - rect.left <= SCROLL_EDGE_PX) step = -SCROLL_STEP_PX;
        else if (rect.right - point.x <= SCROLL_EDGE_PX) step = SCROLL_STEP_PX;
        if (step === 0) return false;
        const previous = scrollContainer.scrollLeft;
        scrollContainer.scrollLeft += step;
        return scrollContainer.scrollLeft !== previous;
      };
      const runFrame = (): void => {
        frameRef.current = null;
        const gesture = gestureRef.current;
        if (!gesture?.dragging) return;
        const scrolled = edgeScroll(gesture.current);
        hitTest(gesture.current);
        if (scrolled) frameRef.current = window.requestAnimationFrame(runFrame);
      };
      const move = (moveEvent: PointerEvent): void => {
        const gesture = gestureRef.current;
        if (!gesture || gesture.pointerId !== moveEvent.pointerId) return;
        gesture.current = { x: moveEvent.clientX, y: moveEvent.clientY };
        if (!gesture.dragging) {
          const dx = gesture.current.x - gesture.start.x;
          const dy = gesture.current.y - gesture.start.y;
          if (dx * dx + dy * dy <= DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
          gesture.dragging = true;
          if (scrollContainer) {
            const snapClasses = ['snap-x', 'snap-mandatory'].filter((name) =>
              scrollContainer.classList.contains(name),
            );
            const hadSnapNone = scrollContainer.classList.contains('snap-none');
            scrollContainer.classList.remove(...snapClasses);
            scrollContainer.classList.add('snap-none');
            gesture.restoreScrollSnap = () => {
              if (!hadSnapNone) scrollContainer.classList.remove('snap-none');
              scrollContainer.classList.add(...snapClasses);
            };
          }
          previewRef.current?.show(gesture.source, gesture.start, gesture.current);
          pointDropAt(gesture, gesture.source.closest<HTMLElement>(DROP_COLUMN_SELECTOR));
          cardDragRef.current.start(gesture.epic);
        } else previewRef.current?.update(gesture.current);
        if (frameRef.current !== null) return;
        frameRef.current = window.requestAnimationFrame(runFrame);
      };
      const up = (upEvent: PointerEvent): void => {
        if (gestureRef.current?.pointerId === upEvent.pointerId)
          finish({ x: upEvent.clientX, y: upEvent.clientY });
      };
      const cancelPointer = (cancelEvent: PointerEvent): void => {
        if (gestureRef.current?.pointerId === cancelEvent.pointerId) finish();
      };
      const cancel = (): void => finish();
      const keyDown = (keyEvent: KeyboardEvent): void => {
        if (keyEvent.key === 'Escape') finish();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', cancelPointer);
      window.addEventListener('blur', cancel);
      window.addEventListener('keydown', keyDown);
      scrollContainer?.addEventListener('scroll', hitTestOnScroll, true);
      gestureRef.current = {
        epic,
        source,
        pointerId: event.pointerId,
        start: { x: event.clientX, y: event.clientY },
        current: { x: event.clientX, y: event.clientY },
        dragging: false,
        dropElement: null,
        restoreScrollSnap: null,
        removeListeners: () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          window.removeEventListener('pointercancel', cancelPointer);
          window.removeEventListener('blur', cancel);
          window.removeEventListener('keydown', keyDown);
          scrollContainer?.removeEventListener('scroll', hitTestOnScroll, true);
        },
      };
    },
    [finish, hitTest, previewRef, scrollContainerRef],
  );

  useEffect(() => {
    const gesture = gestureRef.current;
    if (gesture && !visibleIds.has(gesture.epic.id)) finish();
  }, [finish, visibleIds]);

  useEffect(
    () => () => {
      finish();
      removeClickSuppressionRef.current?.();
    },
    [finish],
  );

  return useMemo(() => ({ pointerDown }), [pointerDown]);
}
