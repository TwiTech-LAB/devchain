import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { createPortal } from 'react-dom';

export interface BoardCardPointerPoint {
  x: number;
  y: number;
}

export interface BoardCardDragPreviewHandle {
  show(source: HTMLElement, start: BoardCardPointerPoint, current: BoardCardPointerPoint): void;
  update(current: BoardCardPointerPoint): void;
  hide(): void;
}

export const BoardCardDragPreview = forwardRef<BoardCardDragPreviewHandle>(
  function BoardCardDragPreview(_props, ref) {
    const rootRef = useRef<HTMLDivElement | null>(null);
    const offsetRef = useRef<BoardCardPointerPoint | null>(null);
    const pointRef = useRef<BoardCardPointerPoint | null>(null);
    const frameRef = useRef<number | null>(null);

    const cancelFrame = (): void => {
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      pointRef.current = null;
    };

    const move = (point: BoardCardPointerPoint): void => {
      const root = rootRef.current;
      const offset = offsetRef.current;
      if (root && offset) {
        root.style.transform = `translate3d(${point.x - offset.x}px, ${point.y - offset.y}px, 0)`;
      }
    };

    useEffect(() => cancelFrame, []);
    useImperativeHandle(
      ref,
      () => ({
        show(source, start, current) {
          cancelFrame();
          const root = rootRef.current;
          if (!root) return;
          const rect = source.getBoundingClientRect();
          const clone = source.cloneNode(true) as HTMLElement;
          clone.removeAttribute('id');
          clone.querySelectorAll('[id]').forEach((element) => element.removeAttribute('id'));
          root.replaceChildren(clone);
          root.style.width = `${rect.width}px`;
          root.style.display = 'block';
          offsetRef.current = { x: start.x - rect.left, y: start.y - rect.top };
          move(current);
        },
        update(current) {
          if (!offsetRef.current) return;
          pointRef.current = current;
          if (frameRef.current !== null) return;
          frameRef.current = window.requestAnimationFrame(() => {
            frameRef.current = null;
            if (pointRef.current) move(pointRef.current);
            pointRef.current = null;
          });
        },
        hide() {
          cancelFrame();
          offsetRef.current = null;
          rootRef.current?.replaceChildren();
          if (rootRef.current) rootRef.current.style.display = 'none';
        },
      }),
      [],
    );

    return createPortal(
      <div
        ref={rootRef}
        aria-hidden="true"
        className="pointer-events-none fixed left-0 top-0 z-[80]"
        style={{ display: 'none' }}
        data-testid="board-card-drag-preview"
      />,
      document.body,
    );
  },
);
