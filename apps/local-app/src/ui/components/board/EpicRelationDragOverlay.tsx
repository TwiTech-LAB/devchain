import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface RelationPointerPoint {
  x: number;
  y: number;
}

export interface EpicRelationDragOverlayHandle {
  show(start: RelationPointerPoint, current: RelationPointerPoint): void;
  update(current: RelationPointerPoint): void;
  hide(): void;
}

interface OverlayGeometry {
  start: RelationPointerPoint;
  current: RelationPointerPoint;
}

export const EpicRelationDragOverlay = forwardRef<EpicRelationDragOverlayHandle>(
  function EpicRelationDragOverlay(_props, ref) {
    const [geometry, setGeometry] = useState<OverlayGeometry | null>(null);
    const geometryRef = useRef<OverlayGeometry | null>(null);
    const pendingPointRef = useRef<RelationPointerPoint | null>(null);
    const frameRef = useRef<number | null>(null);

    const cancelFrame = (): void => {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      pendingPointRef.current = null;
    };

    useEffect(() => cancelFrame, []);

    useImperativeHandle(
      ref,
      () => ({
        show(start, current) {
          cancelFrame();
          geometryRef.current = { start, current };
          setGeometry(geometryRef.current);
        },
        update(current) {
          if (!geometryRef.current) return;
          pendingPointRef.current = current;
          if (frameRef.current !== null) return;
          frameRef.current = window.requestAnimationFrame(() => {
            frameRef.current = null;
            const point = pendingPointRef.current;
            pendingPointRef.current = null;
            if (!point || !geometryRef.current) return;
            geometryRef.current = { ...geometryRef.current, current: point };
            setGeometry(geometryRef.current);
          });
        },
        hide() {
          cancelFrame();
          geometryRef.current = null;
          setGeometry(null);
        },
      }),
      [],
    );

    if (!geometry || typeof document === 'undefined') return null;

    return createPortal(
      <svg
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-[80] h-screen w-screen overflow-visible"
        data-testid="epic-relation-drag-overlay"
      >
        <line
          x1={geometry.start.x}
          y1={geometry.start.y}
          x2={geometry.current.x}
          y2={geometry.current.y}
          className="stroke-primary"
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray="7 5"
        />
      </svg>,
      document.body,
    );
  },
);
