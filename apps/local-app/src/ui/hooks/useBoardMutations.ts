import { useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  bulkUpdateEpicsApi,
  createEpic,
  deleteEpic,
  type BoardArchivedFilter,
  updateEpic,
} from '@/ui/pages/board/lib/board-api';
import type { Epic, EpicsQueryData } from '@/ui/types';

type ToastFn = (args: { title: string; description: string; variant?: 'destructive' }) => void;

export type BoardBulkEditRow = {
  epic: Epic;
  statusId: string;
  agentId: string | null;
};

export type BoardBulkBaseline = Record<string, { statusId: string; agentId: string | null }>;

type UpdateEpicMutationVars = {
  id: string;
  data: Partial<Epic>;
  skipSuccessToast?: boolean;
};

type BulkUpdateMutationVars = {
  rows: BoardBulkEditRow[];
  baseline: BoardBulkBaseline;
  parentId?: string | null;
};

export interface UseBoardMutationsArgs {
  epicsKey: readonly ['epics', string | null | undefined, BoardArchivedFilter];
  toast: ToastFn;
  onCreateSuccess: () => void;
  onUpdateSuccess: () => void;
  onDeleteSettled: () => void;
  onBulkSuccess: () => void;
  onBulkError: (message: string) => void;
}

export interface UseBoardMutationsResult {
  createMutation: ReturnType<
    typeof useMutation<unknown, unknown, Partial<Epic>, { previousData: unknown }>
  >;
  updateMutation: ReturnType<
    typeof useMutation<unknown, unknown, UpdateEpicMutationVars, { previousData: unknown }>
  >;
  deleteMutation: ReturnType<
    typeof useMutation<unknown, unknown, string, { previousData: unknown }>
  >;
  bulkUpdateMutation: ReturnType<typeof useMutation<unknown, unknown, BulkUpdateMutationVars>>;
  mutateDeleteEpic: (epicId: string) => void;
  deleteEpicsByIds: (epicIds: string[]) => Promise<void>;
  mutateUpdateEpicStatus: (
    epic: Pick<Epic, 'id' | 'version'>,
    statusId: string,
    options?: { skipSuccessToast?: boolean },
  ) => void;
  mutateUpdateEpicStatusAsync: (
    epic: Pick<Epic, 'id' | 'version'>,
    statusId: string,
    options?: { skipSuccessToast?: boolean },
  ) => Promise<unknown>;
  mutateUpdateEpicAgentAsync: (
    epic: Pick<Epic, 'id' | 'version'>,
    agentId: string | null,
    options?: { skipSuccessToast?: boolean },
  ) => Promise<unknown>;
  mutateBulkUpdate: (vars: BulkUpdateMutationVars) => void;
}

export function useBoardMutations({
  epicsKey,
  toast,
  onCreateSuccess,
  onUpdateSuccess,
  onDeleteSettled,
  onBulkSuccess,
  onBulkError,
}: UseBoardMutationsArgs): UseBoardMutationsResult {
  const queryClient = useQueryClient();

  const createMutation = useMutation({
    mutationFn: createEpic,
    onMutate: async (newEpic) => {
      await queryClient.cancelQueries({ queryKey: ['epics'] });
      const previousData = queryClient.getQueryData(epicsKey);

      queryClient.setQueryData(epicsKey, (old: EpicsQueryData | undefined) => ({
        ...old,
        items: [
          {
            id: `temp-${Date.now()}`,
            ...newEpic,
            version: 1,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          ...((old?.items ?? []) as Epic[]),
        ],
      }));

      return { previousData };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['epics'] });
      onCreateSuccess();
      toast({
        title: 'Success',
        description: 'Epic created successfully',
      });
    },
    onError: (error, _variables, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(epicsKey, context.previousData);
      }
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to create epic',
        variant: 'destructive',
      });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: UpdateEpicMutationVars) => updateEpic(id, data),
    onMutate: async ({ id, data }) => {
      await queryClient.cancelQueries({ queryKey: ['epics'] });
      const previousData = queryClient.getQueryData(epicsKey);

      queryClient.setQueryData(epicsKey, (old: EpicsQueryData | undefined) => ({
        ...old,
        items: ((old?.items ?? []) as Epic[]).map((e: Epic) =>
          e.id === id ? { ...e, ...data, updatedAt: new Date().toISOString() } : e,
        ),
      }));

      return { previousData };
    },
    onSuccess: (_result, variables) => {
      queryClient.invalidateQueries({ queryKey: ['epics'] });
      if (!variables?.skipSuccessToast) {
        toast({
          title: 'Success',
          description: 'Epic updated successfully',
        });
      }
      onUpdateSuccess();
    },
    onError: (error, _variables, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(epicsKey, context.previousData);
      }
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to update epic',
        variant: 'destructive',
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteEpic,
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: ['epics'] });
      const previousData = queryClient.getQueryData(epicsKey);

      queryClient.setQueryData(epicsKey, (old: EpicsQueryData | undefined) => ({
        ...old,
        items: ((old?.items ?? []) as Epic[]).filter((e: Epic) => e.id !== id),
      }));

      return { previousData };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['epics'] });
      onDeleteSettled();
      toast({
        title: 'Success',
        description: 'Epic deleted successfully',
      });
    },
    onError: (error, _variables, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(epicsKey, context.previousData);
      }
      onDeleteSettled();
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to delete epic',
        variant: 'destructive',
      });
    },
  });

  const bulkUpdateMutation = useMutation({
    mutationFn: async ({ rows, baseline, parentId }: BulkUpdateMutationVars) => {
      const updates = rows
        .map((row) => {
          const original = baseline[row.epic.id];
          if (!original) return null;
          const payload: {
            id: string;
            statusId?: string;
            agentId?: string | null;
            version: number;
          } = { id: row.epic.id, version: row.epic.version };
          if (row.statusId !== original.statusId) {
            payload.statusId = row.statusId;
          }
          if ((row.agentId ?? null) !== (original.agentId ?? null)) {
            payload.agentId = row.agentId ?? null;
          }
          return Object.keys(payload).length > 2 ? payload : null;
        })
        .filter(Boolean) as Array<{
        id: string;
        statusId?: string;
        agentId?: string | null;
        version: number;
      }>;

      if (!updates.length) {
        return { updated: [], parentId };
      }

      const updated = await bulkUpdateEpicsApi({ parentId: parentId ?? null, updates });
      return { updated, parentId };
    },
    onSuccess: (_result, variables) => {
      queryClient.invalidateQueries({ queryKey: ['epics'] });
      if (variables?.parentId) {
        queryClient.invalidateQueries({ queryKey: ['epics', variables.parentId, 'sub-counts'] });
        queryClient.invalidateQueries({ queryKey: ['epics', 'parent', variables.parentId] });
      }
      toast({
        title: 'Updates applied',
        description: 'Bulk changes saved successfully.',
      });
      onBulkSuccess();
    },
    onError: (error: unknown) => {
      const message = error instanceof Error ? error.message : 'Failed to apply bulk updates';
      onBulkError(message);
      toast({
        title: 'Error',
        description: message,
        variant: 'destructive',
      });
    },
  });

  const mutateDeleteEpic = useCallback(
    (epicId: string) => {
      deleteMutation.mutate(epicId);
    },
    [deleteMutation],
  );

  const deleteEpicsByIds = useCallback(
    async (epicIds: string[]) => {
      for (const id of epicIds) {
        await deleteMutation.mutateAsync(id);
      }
    },
    [deleteMutation],
  );

  const mutateUpdateEpicStatus = useCallback(
    (
      epic: Pick<Epic, 'id' | 'version'>,
      statusId: string,
      options?: { skipSuccessToast?: boolean },
    ) => {
      updateMutation.mutate({
        id: epic.id,
        data: { statusId, version: epic.version },
        skipSuccessToast: options?.skipSuccessToast,
      });
    },
    [updateMutation],
  );

  const mutateUpdateEpicStatusAsync = useCallback(
    (
      epic: Pick<Epic, 'id' | 'version'>,
      statusId: string,
      options?: { skipSuccessToast?: boolean },
    ) => {
      return updateMutation.mutateAsync({
        id: epic.id,
        data: { statusId, version: epic.version },
        skipSuccessToast: options?.skipSuccessToast,
      });
    },
    [updateMutation],
  );

  const mutateUpdateEpicAgentAsync = useCallback(
    (
      epic: Pick<Epic, 'id' | 'version'>,
      agentId: string | null,
      options?: { skipSuccessToast?: boolean },
    ) => {
      return updateMutation.mutateAsync({
        id: epic.id,
        data: { agentId, version: epic.version },
        skipSuccessToast: options?.skipSuccessToast,
      });
    },
    [updateMutation],
  );

  const mutateBulkUpdate = useCallback(
    (vars: BulkUpdateMutationVars) => {
      bulkUpdateMutation.mutate(vars);
    },
    [bulkUpdateMutation],
  );

  return {
    createMutation,
    updateMutation,
    deleteMutation,
    bulkUpdateMutation,
    mutateDeleteEpic,
    deleteEpicsByIds,
    mutateUpdateEpicStatus,
    mutateUpdateEpicStatusAsync,
    mutateUpdateEpicAgentAsync,
    mutateBulkUpdate,
  };
}
