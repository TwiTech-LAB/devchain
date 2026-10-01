import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Epic, EpicsQueryData } from '@/ui/types';
import { boardCacheKeys } from '@/ui/lib/board-cache';

export interface UseBoardDragDropArgs {
  epicsKey: ReturnType<typeof boardCacheKeys.list>;
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
  handleDragStart: (epic: Epic) => void;
  handleDragEnd: () => void;
  handleDrop: (epic: Epic, statusId: string) => void;
}

export function useBoardDragDrop({
  epicsKey,
  parentFilter,
  onDropStatusChange,
  debounceMs = 300,
}: UseBoardDragDropArgs): UseBoardDragDropResult {
  const queryClient = useQueryClient();
  const [draggedEpic, setDraggedEpic] = useState<Epic | null>(null);
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
  }, []);

  const handleDragEnd = useCallback(() => {
    setDraggedEpic(null);
  }, []);

  const handleDrop = useCallback(
    (epicToUpdate: Epic, statusId: string) => {
      setDraggedEpic(null);
      if (epicToUpdate.statusId === statusId) return;

      // Optimistically update UI for current filter scope.
      queryClient.setQueryData(epicsKey, (old: EpicsQueryData | undefined) => ({
        ...old,
        items: ((old?.items ?? []) as Epic[]).map((e: Epic) =>
          e.id === epicToUpdate.id ? { ...e, statusId, updatedAt: new Date().toISOString() } : e,
        ),
      }));

      if (parentFilter && epicToUpdate.parentId === parentFilter) {
        queryClient.setQueryData(
          boardCacheKeys.children(parentFilter),
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

      if (updateTimeoutRef.current) {
        clearTimeout(updateTimeoutRef.current);
      }

      updateTimeoutRef.current = setTimeout(() => {
        onDropStatusChange(epicToUpdate, statusId, { skipSuccessToast: true });
      }, debounceMs);
    },
    [queryClient, epicsKey, parentFilter, onDropStatusChange, debounceMs],
  );

  return {
    draggedEpic,
    handleDragStart,
    handleDragEnd,
    handleDrop,
  };
}
