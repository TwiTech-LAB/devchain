import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { EpicRelationDragOverlayHandle } from '@/ui/components/board/EpicRelationDragOverlay';
import type { Epic } from '@/ui/types';

const DRAG_THRESHOLD_PX = 6;

interface ActivePointerGesture {
  phase: 'armed' | 'dragging';
  source: Epic;
  handle: HTMLButtonElement;
  pointerId: number;
  start: { x: number; y: number };
}

export interface EpicRelationConfirmation {
  source: Epic;
  target: Epic;
}

export interface BoardRelationQuickLinkBindings {
  readonly selectionSourceId: string | null;
  pointerDown(epic: Epic, event: ReactPointerEvent<HTMLButtonElement>): void;
  pointerMove(event: ReactPointerEvent<HTMLButtonElement>): void;
  pointerUp(event: ReactPointerEvent<HTMLButtonElement>): void;
  pointerCancel(): void;
  lostPointerCapture(): void;
  activate(epic: Epic, handle: HTMLButtonElement): void;
  selectTarget(epic: Epic): void;
  cancel(): void;
}

export interface UseBoardRelationQuickLinkResult {
  bindings: BoardRelationQuickLinkBindings;
  confirmation: EpicRelationConfirmation | null;
  cancel: () => void;
  complete: () => void;
}

function releasePointerCapture(gesture: ActivePointerGesture | null): void {
  if (!gesture) return;
  if (
    typeof gesture.handle.hasPointerCapture === 'function' &&
    gesture.handle.hasPointerCapture(gesture.pointerId)
  ) {
    gesture.handle.releasePointerCapture(gesture.pointerId);
  }
}

export function useBoardRelationQuickLink(
  visibleEpics: readonly Epic[],
  overlayRef: MutableRefObject<EpicRelationDragOverlayHandle | null>,
): UseBoardRelationQuickLinkResult {
  const visibleEpicMap = useMemo(
    () => new Map(visibleEpics.map((epic) => [epic.id, epic])),
    [visibleEpics],
  );
  const visibleEpicMapRef = useRef(visibleEpicMap);
  visibleEpicMapRef.current = visibleEpicMap;
  const gestureRef = useRef<ActivePointerGesture | null>(null);
  const sourceHandleRef = useRef<HTMLButtonElement | null>(null);
  const selectionSourceRef = useRef<Epic | null>(null);
  const confirmationRef = useRef<EpicRelationConfirmation | null>(null);
  const suppressClickRef = useRef(false);
  const suppressClickTimerRef = useRef<number | null>(null);
  const [selectionSource, setSelectionSource] = useState<Epic | null>(null);
  const [confirmation, setConfirmation] = useState<EpicRelationConfirmation | null>(null);

  const clearSuppressClickTimer = useCallback((): void => {
    if (suppressClickTimerRef.current !== null) {
      window.clearTimeout(suppressClickTimerRef.current);
      suppressClickTimerRef.current = null;
    }
  }, []);

  const suppressGeneratedClick = useCallback((): void => {
    clearSuppressClickTimer();
    suppressClickRef.current = true;
    suppressClickTimerRef.current = window.setTimeout(() => {
      suppressClickRef.current = false;
      suppressClickTimerRef.current = null;
    }, 0);
  }, [clearSuppressClickTimer]);

  const cancelInternal = useCallback(
    ({
      restoreFocus = true,
      updateState = true,
      preserveClickSuppression = false,
    }: {
      restoreFocus?: boolean;
      updateState?: boolean;
      preserveClickSuppression?: boolean;
    } = {}) => {
      const focusTarget = sourceHandleRef.current;
      const gesture = gestureRef.current;
      gestureRef.current = null;
      releasePointerCapture(gesture);
      overlayRef.current?.hide();
      if (!preserveClickSuppression) {
        clearSuppressClickTimer();
        suppressClickRef.current = false;
      }
      selectionSourceRef.current = null;
      confirmationRef.current = null;
      sourceHandleRef.current = null;
      if (updateState) {
        setSelectionSource(null);
        setConfirmation(null);
      }
      if (restoreFocus && focusTarget?.isConnected) {
        queueMicrotask(() => focusTarget.isConnected && focusTarget.focus());
      }
    },
    [clearSuppressClickTimer, overlayRef],
  );

  const openConfirmation = useCallback(
    (source: Epic, target: Epic): void => {
      if (source.id === target.id) return;
      const gesture = gestureRef.current;
      gestureRef.current = null;
      releasePointerCapture(gesture);
      overlayRef.current?.hide();
      selectionSourceRef.current = null;
      setSelectionSource(null);
      const next = { source, target };
      confirmationRef.current = next;
      setConfirmation(next);
    },
    [overlayRef],
  );

  const pointerDown = useCallback(
    (epic: Epic, event: ReactPointerEvent<HTMLButtonElement>): void => {
      if (event.button !== 0) return;
      cancelInternal({ restoreFocus: false });
      event.stopPropagation();
      const handle = event.currentTarget;
      sourceHandleRef.current = handle;
      gestureRef.current = {
        phase: 'armed',
        source: epic,
        handle,
        pointerId: event.pointerId,
        start: { x: event.clientX, y: event.clientY },
      };
      handle.setPointerCapture?.(event.pointerId);
    },
    [cancelInternal],
  );

  const pointerMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>): void => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      const point = { x: event.clientX, y: event.clientY };
      if (gesture.phase === 'armed') {
        const dx = point.x - gesture.start.x;
        const dy = point.y - gesture.start.y;
        if (dx * dx + dy * dy <= DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
        gesture.phase = 'dragging';
        const rect = gesture.handle.getBoundingClientRect();
        overlayRef.current?.show(
          { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
          point,
        );
        return;
      }
      overlayRef.current?.update(point);
    },
    [overlayRef],
  );

  const pointerUp = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>): void => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      gestureRef.current = null;
      releasePointerCapture(gesture);
      if (gesture.phase !== 'dragging') return;

      suppressGeneratedClick();
      overlayRef.current?.hide();
      const targetElement = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>('[data-relation-epic-id]');
      const targetId = targetElement?.dataset.relationEpicId;
      const target = targetId ? visibleEpicMapRef.current.get(targetId) : undefined;
      if (target && target.id !== gesture.source.id) {
        openConfirmation(gesture.source, target);
      } else {
        cancelInternal({ restoreFocus: false, preserveClickSuppression: true });
      }
    },
    [cancelInternal, openConfirmation, overlayRef, suppressGeneratedClick],
  );

  const activate = useCallback(
    (epic: Epic, handle: HTMLButtonElement): void => {
      if (suppressClickRef.current) {
        suppressClickRef.current = false;
        clearSuppressClickTimer();
        return;
      }
      cancelInternal({ restoreFocus: false });
      sourceHandleRef.current = handle;
      selectionSourceRef.current = epic;
      setSelectionSource(epic);
    },
    [cancelInternal, clearSuppressClickTimer],
  );

  const selectTarget = useCallback(
    (target: Epic): void => {
      const source = selectionSourceRef.current;
      if (source) openConfirmation(source, target);
    },
    [openConfirmation],
  );

  useEffect(() => {
    const activeSource =
      gestureRef.current?.source ?? selectionSourceRef.current ?? confirmationRef.current?.source;
    if (activeSource && !visibleEpicMap.has(activeSource.id)) {
      cancelInternal({ restoreFocus: false });
    }
  }, [cancelInternal, visibleEpicMap]);

  useEffect(() => {
    const cancelForWindowChange = (): void => cancelInternal({ restoreFocus: false });
    const cancelForEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') cancelInternal();
    };
    window.addEventListener('blur', cancelForWindowChange);
    window.addEventListener('resize', cancelForWindowChange);
    window.addEventListener('keydown', cancelForEscape);
    return () => {
      window.removeEventListener('blur', cancelForWindowChange);
      window.removeEventListener('resize', cancelForWindowChange);
      window.removeEventListener('keydown', cancelForEscape);
      cancelInternal({ restoreFocus: false, updateState: false });
    };
  }, [cancelInternal]);

  const bindings = useMemo<BoardRelationQuickLinkBindings>(
    () => ({
      selectionSourceId: selectionSource?.id ?? null,
      pointerDown,
      pointerMove,
      pointerUp,
      pointerCancel: () => cancelInternal({ restoreFocus: false }),
      lostPointerCapture: () => {
        if (gestureRef.current) cancelInternal({ restoreFocus: false });
      },
      activate,
      selectTarget,
      cancel: cancelInternal,
    }),
    [
      activate,
      cancelInternal,
      pointerDown,
      pointerMove,
      pointerUp,
      selectTarget,
      selectionSource?.id,
    ],
  );

  return {
    bindings,
    confirmation,
    cancel: cancelInternal,
    complete: () => cancelInternal(),
  };
}
