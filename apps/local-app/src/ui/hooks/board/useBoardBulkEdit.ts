import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/ui/hooks/use-toast';
import { useFetchFactory } from '@/ui/hooks/useFetchFactory';
import {
  bulkUpdateEpicsApi,
  fetchSubEpics,
  type BulkUpdateEpicsPayload,
} from '@/ui/pages/board/lib/board-api';
import type { Epic } from '@/ui/types/domain';
import type { BoardBulkEditController, BoardBulkEditRow } from '@/ui/types/board-bulk-edit';
import { boardCacheKeys } from '@/ui/lib/board-cache';

interface UseBoardBulkEditOptions {
  selectedProjectId: string | null | undefined;
}

interface BoardBulkEditBaselineRow {
  statusId: string;
  agentId: string | null;
  version: number;
}

type BoardBulkEditBaseline = Record<string, BoardBulkEditBaselineRow>;

interface BoardBulkEditSession {
  generation: number;
  projectId: string;
  parentId: string;
  rows: readonly BoardBulkEditRow[];
  baseline: BoardBulkEditBaseline;
  error: string | null;
  isLoading: boolean;
}

interface BulkUpdateMutationVars {
  generation: number;
  projectId: string;
  parentId: string;
  updates: BulkUpdateEpicsPayload['updates'];
}

function normalizeId(value: string | null | undefined): string | null {
  return value ?? null;
}

function snapshotEpic(epic: Epic): Epic {
  return { ...epic, tags: [...epic.tags] };
}

function createRow(epic: Epic): BoardBulkEditRow {
  const snapshot = snapshotEpic(epic);
  return {
    epic: snapshot,
    statusId: snapshot.statusId,
    agentId: normalizeId(snapshot.agentId),
  };
}

function createBaseline(rows: readonly BoardBulkEditRow[]): BoardBulkEditBaseline {
  return Object.fromEntries(
    rows.map((row) => [
      row.epic.id,
      {
        statusId: row.statusId,
        agentId: normalizeId(row.agentId),
        version: row.epic.version,
      },
    ]),
  );
}

function buildUpdates(
  rows: readonly BoardBulkEditRow[],
  baseline: BoardBulkEditBaseline,
): BulkUpdateEpicsPayload['updates'] {
  return rows.flatMap((row) => {
    const original = baseline[row.epic.id];
    if (!original) return [];

    const agentId = normalizeId(row.agentId);
    const update: BulkUpdateEpicsPayload['updates'][number] = {
      id: row.epic.id,
      version: original.version,
    };

    if (row.statusId !== original.statusId) {
      update.statusId = row.statusId;
    }
    if (agentId !== original.agentId) {
      update.agentId = agentId;
    }

    return Object.keys(update).length > 2 ? [update] : [];
  });
}

function readChildren(payload: unknown): Epic[] {
  if (!payload || typeof payload !== 'object' || !('items' in payload)) return [];
  const { items } = payload as { items?: unknown };
  return Array.isArray(items) ? (items as Epic[]) : [];
}

export function useBoardBulkEdit({
  selectedProjectId,
}: UseBoardBulkEditOptions): BoardBulkEditController {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const apiFetch = useFetchFactory();
  const [session, setSession] = useState<BoardBulkEditSession | null>(null);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const selectedProjectIdRef = useRef(selectedProjectId);
  const previousProjectIdRef = useRef(selectedProjectId);
  selectedProjectIdRef.current = selectedProjectId;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (previousProjectIdRef.current === selectedProjectId) return;
    previousProjectIdRef.current = selectedProjectId;
    generationRef.current += 1;
    setSession(null);
  }, [selectedProjectId]);

  const isCurrentSession = useCallback(
    (generation: number, projectId: string) =>
      mountedRef.current &&
      generationRef.current === generation &&
      selectedProjectIdRef.current === projectId,
    [],
  );

  const visibleSession = session && session.projectId === selectedProjectId ? session : null;

  const mutation = useMutation({
    mutationFn: ({ parentId, updates }: BulkUpdateMutationVars) =>
      bulkUpdateEpicsApi({ parentId, updates }, apiFetch),
    onSuccess: async (_result, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: boardCacheKeys.all }),
        queryClient.invalidateQueries({
          queryKey: boardCacheKeys.subCounts(variables.parentId),
        }),
        queryClient.invalidateQueries({
          queryKey: boardCacheKeys.children(variables.parentId),
        }),
      ]);

      if (!isCurrentSession(variables.generation, variables.projectId)) {
        return;
      }

      toast({
        title: 'Updates applied',
        description: 'Bulk changes saved successfully.',
      });
      generationRef.current += 1;
      setSession(null);
    },
    onError: (error: unknown, variables) => {
      if (!isCurrentSession(variables.generation, variables.projectId)) {
        return;
      }

      const message = error instanceof Error ? error.message : 'Failed to apply bulk updates';
      setSession((current) =>
        current?.generation === variables.generation ? { ...current, error: message } : current,
      );
      toast({ title: 'Error', description: message, variant: 'destructive' });
    },
  });

  const open = useCallback(
    (epic: Epic) => {
      const projectId = selectedProjectIdRef.current;
      if (epic.parentId || !projectId || epic.projectId !== projectId) return;

      const generation = generationRef.current + 1;
      generationRef.current = generation;
      const parentRow = createRow(epic);
      const initialRows = [parentRow];
      setSession({
        generation,
        projectId,
        parentId: parentRow.epic.id,
        rows: initialRows,
        baseline: createBaseline(initialRows),
        error: null,
        isLoading: true,
      });

      void (async () => {
        try {
          const payload: unknown = await fetchSubEpics(parentRow.epic.id, apiFetch);
          if (!isCurrentSession(generation, projectId)) {
            return;
          }

          const rows = [parentRow, ...readChildren(payload).map(createRow)];
          setSession((current) =>
            current?.generation === generation
              ? {
                  ...current,
                  rows,
                  baseline: createBaseline(rows),
                  error: null,
                  isLoading: false,
                }
              : current,
          );
        } catch (error) {
          if (!isCurrentSession(generation, projectId)) {
            return;
          }

          const message = error instanceof Error ? error.message : 'Failed to load sub-epics';
          setSession((current) =>
            current?.generation === generation
              ? { ...current, error: message, isLoading: false }
              : current,
          );
        }
      })();
    },
    [apiFetch, isCurrentSession],
  );

  const close = useCallback(() => {
    generationRef.current += 1;
    setSession(null);
  }, []);

  const changeRow = useCallback(
    (epicId: string, field: 'statusId' | 'agentId', value: string | null) => {
      setSession((current) => {
        if (!current || current.projectId !== selectedProjectIdRef.current) return current;
        if (field === 'statusId' && value === null) return current;
        return {
          ...current,
          error: null,
          rows: current.rows.map((row) =>
            row.epic.id === epicId ? { ...row, [field]: value } : row,
          ),
        };
      });
    },
    [],
  );

  const updates = useMemo(
    () => (visibleSession ? buildUpdates(visibleSession.rows, visibleSession.baseline) : []),
    [visibleSession],
  );
  const isSubmitting =
    mutation.isPending && mutation.variables?.generation === visibleSession?.generation;

  const submit = useCallback(() => {
    if (!visibleSession || visibleSession.isLoading || isSubmitting) return;
    if (updates.length === 0) {
      toast({
        title: 'No changes',
        description: 'Update at least one epic before saving.',
      });
      return;
    }

    mutation.mutate({
      generation: visibleSession.generation,
      projectId: visibleSession.projectId,
      parentId: visibleSession.parentId,
      updates,
    });
  }, [isSubmitting, mutation, toast, updates, visibleSession]);

  return {
    isOpen: visibleSession !== null,
    rows: visibleSession?.rows ?? [],
    error: visibleSession?.error ?? null,
    isLoading: visibleSession?.isLoading ?? false,
    isSubmitting,
    canSubmit:
      visibleSession !== null && !visibleSession.isLoading && !isSubmitting && updates.length > 0,
    open,
    close,
    changeRow,
    submit,
  };
}
