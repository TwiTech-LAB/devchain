import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { BoardArchivedFilter } from '@/ui/pages/board/lib/board-api';
import type { Epic, EpicsQueryData } from '@/ui/types';

export interface UseBoardDragDropArgs {
  epicsKey: readonly ['epics', string | null | undefined, BoardArchivedFilter];
  parentFilter: string | undefined;
  onDropStatusChange: (
    epic: Pick<Epic, 'id' | 'parentId' | 'version'>,
    statusId: string,
    options?: { skipSuccessToast?: boolean },
  ) => void;
  debounceMs?: number;
}

export interface UseBoardDragDropResult {
  draggedEpic: Epic | null;
  activeDropStatusId: string | null;
  handleDragStart: (epic: Epic) => void;
  handleDragEnd: () => void;
  handleDragOverStatus: (statusId: string, event: React.DragEvent) => void;
  handleDrop: (statusId: string) => void;
}

export function useBoardDragDrop({
  epicsKey,
  parentFilter,
  onDropStatusChange,
  debounceMs = 300,
}: UseBoardDragDropArgs): UseBoardDragDropResult {
  const queryClient = useQueryClient();
  const [draggedEpic, setDraggedEpic] = useState<Epic | null>(null);
  const [activeDropStatusId, setActiveDropStatusId] = useState<string | null>(null);
  const updateTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    return () => {
      if (updateTimeoutRef.current) {
        clearTimeout(updateTimeoutRef.current);
      }
    };
  }, []);

  const handleDragStart = useCallback((epic: Epic) => {
    setDraggedEpic(epic);
    setActiveDropStatusId(epic.statusId ?? null);
  }, []);

  const handleDragEnd = useCallback(() => {
    setDraggedEpic(null);
    setActiveDropStatusId(null);
  }, []);

  const handleDragOverStatus = useCallback(
    (statusId: string, event: React.DragEvent) => {
      event.preventDefault();
      if (activeDropStatusId !== statusId) {
        setActiveDropStatusId(statusId);
      }
    },
    [activeDropStatusId],
  );

  const handleDrop = useCallback(
    (statusId: string) => {
      if (!draggedEpic || draggedEpic.statusId === statusId) {
        setDraggedEpic(null);
        setActiveDropStatusId(null);
        return;
      }

      const epicToUpdate = draggedEpic;

      // Optimistically update UI for current filter scope.
      queryClient.setQueryData(epicsKey, (old: EpicsQueryData | undefined) => ({
        ...old,
        items: ((old?.items ?? []) as Epic[]).map((e: Epic) =>
          e.id === epicToUpdate.id ? { ...e, statusId, updatedAt: new Date().toISOString() } : e,
        ),
      }));

      if (parentFilter && epicToUpdate.parentId === parentFilter) {
        queryClient.setQueryData(
          ['epics', 'parent', parentFilter],
          (old: EpicsQueryData | undefined) => ({
            ...old,
            items: ((old?.items ?? []) as Epic[]).map((e: Epic) =>
              e.id === epicToUpdate.id
                ? { ...e, statusId, updatedAt: new Date().toISOString() }
                : e,
            ),
          }),
        );
      }

      setDraggedEpic(null);
      setActiveDropStatusId(null);

      if (updateTimeoutRef.current) {
        clearTimeout(updateTimeoutRef.current);
      }

      updateTimeoutRef.current = setTimeout(() => {
        onDropStatusChange(epicToUpdate, statusId, { skipSuccessToast: true });
      }, debounceMs);
    },
    [draggedEpic, queryClient, epicsKey, parentFilter, onDropStatusChange, debounceMs],
  );

  return {
    draggedEpic,
    activeDropStatusId,
    handleDragStart,
    handleDragEnd,
    handleDragOverStatus,
    handleDrop,
  };
}
