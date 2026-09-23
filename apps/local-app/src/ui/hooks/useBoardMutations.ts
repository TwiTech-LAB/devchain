import { useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createEpic, deleteEpic, updateEpic } from '@/ui/pages/board/lib/board-api';
import type { Epic, EpicsQueryData } from '@/ui/types';
import { useFetchFactory } from '@/ui/hooks/useFetchFactory';
import { boardCacheKeys } from '@/ui/lib/board-cache';

type ToastFn = (args: { title: string; description: string; variant?: 'destructive' }) => void;

type UpdateEpicMutationVars = {
  id: string;
  data: Partial<Epic>;
  skipSuccessToast?: boolean;
};

export interface UseBoardMutationsArgs {
  epicsKey: ReturnType<typeof boardCacheKeys.list>;
  toast: ToastFn;
  onCreateSuccess: () => void;
  onDeleteSettled: () => void;
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
}

export function useBoardMutations({
  epicsKey,
  toast,
  onCreateSuccess,
  onDeleteSettled,
}: UseBoardMutationsArgs): UseBoardMutationsResult {
  const queryClient = useQueryClient();
  const apiFetch = useFetchFactory();

  const createMutation = useMutation({
    mutationFn: (data: Partial<Epic>) => createEpic(data, apiFetch),
    onMutate: async (newEpic) => {
      await queryClient.cancelQueries({ queryKey: boardCacheKeys.all });
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
      queryClient.invalidateQueries({ queryKey: boardCacheKeys.all });
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
    mutationFn: ({ id, data }: UpdateEpicMutationVars) => updateEpic(id, data, apiFetch),
    onMutate: async ({ id, data }) => {
      await queryClient.cancelQueries({ queryKey: boardCacheKeys.all });
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
      queryClient.invalidateQueries({ queryKey: boardCacheKeys.all });
      if (!variables?.skipSuccessToast) {
        toast({
          title: 'Success',
          description: 'Epic updated successfully',
        });
      }
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
    mutationFn: (id: string) => deleteEpic(id, apiFetch),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: boardCacheKeys.all });
      const previousData = queryClient.getQueryData(epicsKey);

      queryClient.setQueryData(epicsKey, (old: EpicsQueryData | undefined) => ({
        ...old,
        items: ((old?.items ?? []) as Epic[]).filter((e: Epic) => e.id !== id),
      }));

      return { previousData };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: boardCacheKeys.all });
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

  return {
    createMutation,
    updateMutation,
    deleteMutation,
    mutateDeleteEpic,
    deleteEpicsByIds,
    mutateUpdateEpicStatus,
    mutateUpdateEpicStatusAsync,
    mutateUpdateEpicAgentAsync,
  };
}
