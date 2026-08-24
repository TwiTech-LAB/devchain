import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type {
  ExternalMyWorkResult,
  ExternalTaskActionResult,
  ExternalTaskStatusOption,
  ExternalWorkAreaColumn,
} from '@/modules/external-integrations/models/external-provider.models';
import { useFetchFactory } from '@/ui/hooks/useFetchFactory';
import { fetchExternalMyWorkSnapshot } from '@/ui/hooks/board/useExternalMyWork';
import type { ExternalBoardProvider } from '@/ui/lib/external-board';
import { externalMyWorkQueryKeys } from '@/ui/lib/external-my-work';
import {
  canRestoreExternalTaskFromInclusiveSnapshot,
  settleExternalTaskStatusSnapshots,
  type ExternalMyWorkSupportedSnapshot,
} from '@/ui/lib/external-my-work-snapshot';
import { fetchFreshExternalTaskDetail } from '@/ui/lib/external-task-detail-query';
import type { IntegrationConnectionEpoch } from '@/ui/lib/integration-connections';
import { fetchJsonOrThrow } from '@/ui/lib/sessions';

interface EditorContext {
  provider: ExternalBoardProvider;
  connectionEpoch: IntegrationConnectionEpoch;
  parentTaskId: string;
  childTaskId: string;
}

interface LandingSnapshotKeys {
  activeOnly: ReturnType<typeof externalMyWorkQueryKeys.landingSnapshot>;
  completedInclusive: ReturnType<typeof externalMyWorkQueryKeys.landingSnapshot>;
}

interface EditorBase {
  taskId: string;
}

export type ExternalSubtaskStatusEditor =
  | (EditorBase & { phase: 'loading' })
  | (EditorBase & {
      phase: 'ready';
      currentStatus: ExternalWorkAreaColumn;
      options: ExternalTaskStatusOption[];
    })
  | (EditorBase & {
      phase: 'unavailable';
      currentStatus: ExternalWorkAreaColumn;
      reason: 'unsupported' | 'no_transitions';
    })
  | (EditorBase & { phase: 'pending'; selectedStatus: ExternalTaskStatusOption })
  | (EditorBase & { phase: 'error'; error: Error })
  | (EditorBase & { phase: 'success'; confirmedStatus: ExternalTaskStatusOption });

export interface UseExternalSubtaskStatusEditorOptions {
  connectionEpoch: IntegrationConnectionEpoch | null;
  parentTaskId: string | null;
  enabled?: boolean;
}

interface CurrentScope {
  provider: ExternalBoardProvider;
  connectionEpoch: IntegrationConnectionEpoch | null;
  parentTaskId: string | null;
  enabled: boolean;
}

function sameContext(left: EditorContext, right: CurrentScope): boolean {
  return (
    right.enabled &&
    left.provider === right.provider &&
    left.connectionEpoch === right.connectionEpoch &&
    left.parentTaskId === right.parentTaskId
  );
}

function asError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}

function isSupportedSnapshot(
  snapshot: ExternalMyWorkResult | undefined,
): snapshot is ExternalMyWorkSupportedSnapshot {
  return snapshot?.supported === true;
}

function landingSnapshotKeys(context: EditorContext): LandingSnapshotKeys {
  return {
    activeOnly: externalMyWorkQueryKeys.landingSnapshot(
      context.provider,
      context.connectionEpoch,
      false,
    ),
    completedInclusive: externalMyWorkQueryKeys.landingSnapshot(
      context.provider,
      context.connectionEpoch,
      true,
    ),
  };
}

/**
 * Lazily loads and changes one direct subtask status. No child query exists
 * until `activate` is called. A fresh detail response is the sole source of
 * capabilities and transitions, and every failed load or write discards those
 * transitions so retry must read them again.
 */
export function useExternalSubtaskStatusEditor(
  provider: ExternalBoardProvider,
  { connectionEpoch, parentTaskId, enabled = true }: UseExternalSubtaskStatusEditorOptions,
) {
  const apiFetch = useFetchFactory();
  const queryClient = useQueryClient();
  const [editor, setEditor] = useState<ExternalSubtaskStatusEditor | null>(null);
  const editorRef = useRef<ExternalSubtaskStatusEditor | null>(null);
  const editorContextRef = useRef<EditorContext | null>(null);
  const scopeRef = useRef<CurrentScope>({ provider, connectionEpoch, parentTaskId, enabled });
  scopeRef.current = { provider, connectionEpoch, parentTaskId, enabled };
  const aliveRef = useRef(true);
  const presentationNonceRef = useRef(0);
  const writeOwnerNonceRef = useRef(0);
  const writeLatchRef = useRef<number | null>(null);

  const publish = useCallback((next: ExternalSubtaskStatusEditor | null): void => {
    editorRef.current = next;
    if (aliveRef.current) setEditor(next);
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      presentationNonceRef.current += 1;
      writeLatchRef.current = null;
    };
  }, []);

  useEffect(() => {
    presentationNonceRef.current += 1;
    writeLatchRef.current = null;
    editorContextRef.current = null;
    publish(null);
  }, [connectionEpoch, enabled, parentTaskId, provider, publish]);

  const isCurrentPresentation = useCallback((context: EditorContext, nonce: number): boolean => {
    return (
      aliveRef.current &&
      presentationNonceRef.current === nonce &&
      sameContext(context, scopeRef.current) &&
      editorContextRef.current === context
    );
  }, []);

  const loadFresh = useCallback(
    async (context: EditorContext): Promise<void> => {
      const nonce = ++presentationNonceRef.current;
      editorContextRef.current = context;
      publish({ taskId: context.childTaskId, phase: 'loading' });

      try {
        const detail = await fetchFreshExternalTaskDetail(
          queryClient,
          apiFetch,
          context.provider,
          context.connectionEpoch,
          context.childTaskId,
        );
        if (!isCurrentPresentation(context, nonce)) return;

        const supported = detail.actions.some(
          (action) => action.action === 'change_status' && action.supported,
        );
        if (!supported) {
          publish({
            taskId: context.childTaskId,
            phase: 'unavailable',
            currentStatus: detail.status,
            reason: 'unsupported',
          });
          return;
        }
        if (detail.allowedStatuses.length === 0) {
          publish({
            taskId: context.childTaskId,
            phase: 'unavailable',
            currentStatus: detail.status,
            reason: 'no_transitions',
          });
          return;
        }
        publish({
          taskId: context.childTaskId,
          phase: 'ready',
          currentStatus: detail.status,
          options: detail.allowedStatuses,
        });
      } catch (error) {
        if (!isCurrentPresentation(context, nonce)) return;
        publish({
          taskId: context.childTaskId,
          phase: 'error',
          error: asError(error, 'Subtask detail could not be loaded.'),
        });
      }
    },
    [apiFetch, isCurrentPresentation, publish, queryClient],
  );

  const activate = useCallback(
    (childTaskId: string): void => {
      const scope = scopeRef.current;
      if (
        childTaskId === '' ||
        !scope.enabled ||
        scope.connectionEpoch === null ||
        scope.parentTaskId === null ||
        writeLatchRef.current !== null
      ) {
        return;
      }
      if (editorRef.current?.taskId === childTaskId && editorRef.current.phase === 'loading')
        return;

      void loadFresh({
        provider: scope.provider,
        connectionEpoch: scope.connectionEpoch,
        parentTaskId: scope.parentTaskId,
        childTaskId,
      });
    },
    [loadFresh],
  );

  const retry = useCallback((): void => {
    const current = editorRef.current;
    const context = editorContextRef.current;
    if (
      !current ||
      current.phase !== 'error' ||
      !context ||
      writeLatchRef.current !== null ||
      !sameContext(context, scopeRef.current)
    ) {
      return;
    }
    void loadFresh(context);
  }, [loadFresh]);

  const deactivate = useCallback((): void => {
    if (writeLatchRef.current !== null) return;
    presentationNonceRef.current += 1;
    editorContextRef.current = null;
    publish(null);
  }, [publish]);

  const selectStatus = useCallback(
    (actionValue: string): void => {
      const current = editorRef.current;
      const context = editorContextRef.current;
      if (
        current?.phase !== 'ready' ||
        !context ||
        !sameContext(context, scopeRef.current) ||
        writeLatchRef.current !== null
      ) {
        return;
      }
      const selected = current.options.find((option) => option.actionValue === actionValue);
      if (!selected) return;

      const ownerNonce = ++writeOwnerNonceRef.current;
      writeLatchRef.current = ownerNonce;
      const presentationNonce = presentationNonceRef.current;
      publish({ taskId: context.childTaskId, phase: 'pending', selectedStatus: selected });

      void (async () => {
        try {
          const snapshotKeys = landingSnapshotKeys(context);
          const activeSnapshot = queryClient.getQueryData<ExternalMyWorkResult>(
            snapshotKeys.activeOnly,
          );
          let inclusiveSnapshot = queryClient.getQueryData<ExternalMyWorkResult>(
            snapshotKeys.completedInclusive,
          );
          const childMissingFromActive =
            isSupportedSnapshot(activeSnapshot) &&
            !activeSnapshot.tasks.some((entry) => entry.task.remoteId === context.childTaskId);
          const reopensCompletedChild =
            current.currentStatus.category === 'completed' && selected.category !== 'completed';
          if (reopensCompletedChild && childMissingFromActive) {
            if (!isSupportedSnapshot(inclusiveSnapshot)) {
              inclusiveSnapshot = await queryClient.fetchQuery({
                queryKey: snapshotKeys.completedInclusive,
                queryFn: ({ signal }) =>
                  fetchExternalMyWorkSnapshot(apiFetch, context.provider, true, signal),
                staleTime: 0,
              });
            }
            if (
              !isSupportedSnapshot(inclusiveSnapshot) ||
              !canRestoreExternalTaskFromInclusiveSnapshot(
                activeSnapshot,
                inclusiveSnapshot,
                context.childTaskId,
              )
            ) {
              throw new Error(
                'DevChain cannot reconstruct this subtask in assigned work. Refresh the connected board, or open the task in the provider and change it there.',
              );
            }
          }
          if (!isCurrentPresentation(context, presentationNonce)) return;

          await fetchJsonOrThrow<ExternalTaskActionResult>(
            `/api/integrations/my-work/${context.provider}/tasks/${encodeURIComponent(
              context.childTaskId,
            )}/status`,
            {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ status: selected.actionValue }),
            },
            'The subtask status could not be updated.',
            '',
            apiFetch,
          );
        } catch (error) {
          if (isCurrentPresentation(context, presentationNonce)) {
            publish({
              taskId: context.childTaskId,
              phase: 'error',
              error: asError(error, 'The subtask status could not be updated.'),
            });
          }
          return;
        } finally {
          if (writeLatchRef.current === ownerNonce) writeLatchRef.current = null;
        }

        const snapshotKeys = landingSnapshotKeys(context);
        const activeSnapshot = queryClient.getQueryData<ExternalMyWorkResult>(
          snapshotKeys.activeOnly,
        );
        const inclusiveSnapshot = queryClient.getQueryData<ExternalMyWorkResult>(
          snapshotKeys.completedInclusive,
        );
        const settled = settleExternalTaskStatusSnapshots(
          {
            activeOnly: isSupportedSnapshot(activeSnapshot) ? activeSnapshot : undefined,
            completedInclusive: isSupportedSnapshot(inclusiveSnapshot)
              ? inclusiveSnapshot
              : undefined,
          },
          context.childTaskId,
          selected,
        );
        if (settled.activeOnly) {
          queryClient.setQueryData(snapshotKeys.activeOnly, settled.activeOnly);
        }
        if (settled.completedInclusive) {
          queryClient.setQueryData(snapshotKeys.completedInclusive, settled.completedInclusive);
        }

        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: externalMyWorkQueryKeys.landing(context.provider, context.connectionEpoch),
            refetchType: 'none',
          }),
          queryClient.invalidateQueries({
            queryKey: externalMyWorkQueryKeys.taskDetail(
              context.provider,
              context.connectionEpoch,
              context.parentTaskId,
            ),
            exact: true,
          }),
          queryClient.invalidateQueries({
            queryKey: externalMyWorkQueryKeys.taskDetail(
              context.provider,
              context.connectionEpoch,
              context.childTaskId,
            ),
            exact: true,
          }),
        ]);

        if (isCurrentPresentation(context, presentationNonce)) {
          publish({
            taskId: context.childTaskId,
            phase: 'success',
            confirmedStatus: selected,
          });
        }
      })();
    },
    [apiFetch, isCurrentPresentation, publish, queryClient],
  );

  return {
    editor,
    activate,
    retry,
    deactivate,
    selectStatus,
    isStatusPending: writeLatchRef.current !== null,
  };
}
