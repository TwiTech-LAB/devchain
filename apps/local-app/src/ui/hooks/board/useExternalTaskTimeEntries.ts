import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ExternalTaskTimeEntryHistory,
  ExternalTaskTimeEntryInput,
} from '@/modules/external-integrations/models/external-provider.models';
import type {
  ExternalTimeEntryCreateResult,
  ExternalTimeEntryDeleteResult,
  ExternalTimeOperationReceiptView,
  ExternalTimeOperationVerifyResult,
} from '@/modules/external-integrations/models/external-time-mutation.models';
import { useFetchFactory } from '@/ui/hooks/useFetchFactory';
import type { ExternalBoardProvider } from '@/ui/lib/external-board';
import { externalMyWorkQueryKeys } from '@/ui/lib/external-my-work';
import { integrationConnectionGeneration } from '@/ui/lib/external-time';
import type { IntegrationConnectionEpoch } from '@/ui/lib/integration-connections';
import { fetchJsonOrThrow } from '@/ui/lib/sessions';

function timeOperationId(): string {
  return window.crypto.randomUUID();
}

export type TimeEntrySubmissionOrigin = 'manual' | 'estimate';
type TimeEntryWriteKind = 'create' | 'delete';

interface OperationContext {
  operationId: string;
  taskScope: string;
  operationScope: string;
  provider: ExternalBoardProvider;
  taskId: string;
  connectionEpoch: IntegrationConnectionEpoch;
  generation: string;
}

interface CreateRequest extends OperationContext {
  input: ExternalTaskTimeEntryInput;
  origin: TimeEntrySubmissionOrigin;
}

interface DeleteRequest extends OperationContext {
  remoteEntryId: string;
}

type ResolutionRequest = OperationContext;

type TaskWriteGuard = OperationContext & {
  status: 'pending' | 'unknown';
  kind: TimeEntryWriteKind;
};

function mutationHeaders(
  request: OperationContext,
  operationId = request.operationId,
): Record<string, string> {
  return {
    'X-DevChain-Connection-Epoch': request.generation,
    'Content-Type': 'application/json',
    'Idempotency-Key': operationId,
  };
}

/**
 * Duration-first time-entry management for one remote task: history loading,
 * entry creation, operation verification, and entry deletion — all behind
 * the epoch precondition header and idempotency keys the backend requires.
 *
 * Suppression contract: while the epoch, task identity, or `log_time`
 * capability is unaccepted, no history request runs, cached history stays
 * hidden, and every mutation refuses to dispatch.
 * History visibility is narrower: a closed history disclosure suppresses
 * only the history query and cached-history exposure, never mutations.
 */
export function useExternalTaskTimeEntries(
  provider: ExternalBoardProvider,
  taskId: string | null,
  {
    enabled,
    historyOpen,
    connectionEpoch,
    identityAccepted,
    timeTrackingEnabled,
  }: {
    enabled: boolean;
    historyOpen: boolean;
    connectionEpoch: IntegrationConnectionEpoch | null;
    identityAccepted: boolean;
    timeTrackingEnabled: boolean;
  },
) {
  const apiFetch = useFetchFactory();
  const queryClient = useQueryClient();
  const encodedTaskId = taskId ? encodeURIComponent(taskId) : '';
  const generation = integrationConnectionGeneration(connectionEpoch);
  const accepted = enabled && generation !== null && taskId !== null && identityAccepted;
  const historyAccepted = accepted && timeTrackingEnabled && historyOpen;
  // Duplicate risk survives credential replacement for the same provider task;
  // pending/error/success presentation remains bound to the admitted epoch.
  const taskScope = `${provider}\u0000${taskId ?? ''}`;
  const operationScope = `${provider}\u0000${connectionEpoch ?? ''}\u0000${taskId ?? ''}`;
  const currentTaskScopeRef = useRef(taskScope);
  const currentOperationScopeRef = useRef(operationScope);
  currentTaskScopeRef.current = taskScope;
  currentOperationScopeRef.current = operationScope;

  const timeEntriesKey = useMemo(
    () => externalMyWorkQueryKeys.taskTimeEntries(provider, connectionEpoch, taskId ?? ''),
    [provider, connectionEpoch, taskId],
  );
  const [writeGuard, setWriteGuardState] = useState<TaskWriteGuard | null>(null);
  const writeGuardRef = useRef<TaskWriteGuard | null>(null);
  const setWriteGuard = useCallback((guard: TaskWriteGuard | null): void => {
    writeGuardRef.current = guard;
    setWriteGuardState(guard);
  }, []);

  useEffect(() => {
    if (writeGuardRef.current && writeGuardRef.current.taskScope !== taskScope) {
      setWriteGuard(null);
    }
  }, [setWriteGuard, taskScope]);

  const historyQuery = useQuery({
    queryKey: timeEntriesKey,
    queryFn: ({ signal }) =>
      fetchJsonOrThrow<ExternalTaskTimeEntryHistory>(
        `/api/integrations/my-work/${provider}/tasks/${encodedTaskId}/time-entries`,
        { signal, headers: { 'X-DevChain-Connection-Epoch': generation ?? '' } },
        'Time entries could not be loaded.',
        '',
        apiFetch,
      ),
    enabled: historyAccepted,
  });

  const refetchAfterWrite = useCallback(
    async (request: OperationContext): Promise<void> => {
      if (
        currentTaskScopeRef.current !== request.taskScope ||
        currentOperationScopeRef.current !== request.operationScope
      ) {
        return;
      }
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: externalMyWorkQueryKeys.taskTimeEntries(
            request.provider,
            request.connectionEpoch,
            request.taskId,
          ),
          exact: true,
        }),
        queryClient.invalidateQueries({
          queryKey: externalMyWorkQueryKeys.taskDetail(
            request.provider,
            request.connectionEpoch,
            request.taskId,
          ),
          exact: true,
        }),
      ]);
    },
    [queryClient],
  );

  const clearMatchingGuard = useCallback(
    (request: OperationContext): void => {
      if (
        currentTaskScopeRef.current === request.taskScope &&
        writeGuardRef.current?.operationId === request.operationId
      ) {
        setWriteGuard(null);
      }
    },
    [setWriteGuard],
  );

  const retainUnknownGuard = useCallback(
    (request: OperationContext, operationId: string, kind: TimeEntryWriteKind): void => {
      if (
        currentTaskScopeRef.current === request.taskScope &&
        writeGuardRef.current?.operationId === request.operationId
      ) {
        setWriteGuard({ ...request, operationId, kind, status: 'unknown' });
      }
    },
    [setWriteGuard],
  );

  const createMutation = useMutation({
    mutationFn: async (request: CreateRequest): Promise<ExternalTimeEntryCreateResult> =>
      fetchJsonOrThrow<ExternalTimeEntryCreateResult>(
        `/api/integrations/my-work/${request.provider}/tasks/${encodeURIComponent(request.taskId)}/time-entries`,
        {
          method: 'POST',
          headers: mutationHeaders(request),
          body: JSON.stringify(request.input),
        },
        'The time entry could not be submitted.',
        '',
        apiFetch,
      ),
    onSuccess: async (result, request) => {
      if (result.outcome === 'outcome_unknown') {
        retainUnknownGuard(request, result.receipt.operationId, 'create');
        return;
      }
      clearMatchingGuard(request);
      await refetchAfterWrite(request);
    },
    onError: (_error, request) => clearMatchingGuard(request),
  });

  const verifyMutation = useMutation({
    mutationFn: async (request: ResolutionRequest): Promise<ExternalTimeOperationVerifyResult> =>
      fetchJsonOrThrow<ExternalTimeOperationVerifyResult>(
        `/api/integrations/my-work/${request.provider}/time-operations/${encodeURIComponent(request.operationId)}/verify`,
        {
          method: 'POST',
          headers: mutationHeaders(request, timeOperationId()),
        },
        'The operation could not be verified.',
        '',
        apiFetch,
      ),
    onSuccess: async (result, request) => {
      if (result.resolved) {
        clearMatchingGuard(request);
        await refetchAfterWrite(request);
      }
    },
  });

  const acknowledgeMutation = useMutation({
    mutationFn: async (request: ResolutionRequest): Promise<ExternalTimeOperationReceiptView> =>
      fetchJsonOrThrow<ExternalTimeOperationReceiptView>(
        `/api/integrations/my-work/${request.provider}/time-operations/${encodeURIComponent(request.operationId)}/acknowledge`,
        {
          method: 'POST',
          headers: mutationHeaders(request, timeOperationId()),
        },
        'The duplicate risk could not be acknowledged.',
        '',
        apiFetch,
      ),
    onSuccess: async (_result, request) => {
      clearMatchingGuard(request);
      await refetchAfterWrite(request);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (request: DeleteRequest): Promise<ExternalTimeEntryDeleteResult> =>
      fetchJsonOrThrow<ExternalTimeEntryDeleteResult>(
        `/api/integrations/my-work/${request.provider}/tasks/${encodeURIComponent(request.taskId)}/time-entries/${encodeURIComponent(request.remoteEntryId)}`,
        {
          method: 'DELETE',
          headers: mutationHeaders(request),
        },
        'The time entry could not be deleted.',
        '',
        apiFetch,
      ),
    onSuccess: async (result, request) => {
      if (result.outcome === 'outcome_unknown') {
        retainUnknownGuard(request, result.receipt.operationId, 'delete');
        return;
      }
      clearMatchingGuard(request);
      await refetchAfterWrite(request);
    },
    onError: (_error, request) => clearMatchingGuard(request),
  });

  const operationContext = useCallback((): OperationContext | null => {
    if (!accepted || taskId === null || connectionEpoch === null || generation === null) {
      return null;
    }
    return {
      operationId: timeOperationId(),
      taskScope,
      operationScope,
      provider,
      taskId,
      connectionEpoch,
      generation,
    };
  }, [accepted, connectionEpoch, generation, operationScope, provider, taskId, taskScope]);

  const submitCreate = useCallback(
    (input: ExternalTaskTimeEntryInput, origin: TimeEntrySubmissionOrigin = 'manual'): void => {
      const context = operationContext();
      if (!context || !timeTrackingEnabled || writeGuardRef.current?.taskScope === taskScope) {
        return;
      }
      setWriteGuard({ ...context, kind: 'create', status: 'pending' });
      createMutation.mutate({ ...context, input, origin });
    },
    [createMutation, operationContext, setWriteGuard, taskScope, timeTrackingEnabled],
  );

  const submitDelete = useCallback(
    (remoteEntryId: string): void => {
      const context = operationContext();
      if (!context || !timeTrackingEnabled || writeGuardRef.current?.taskScope === taskScope) {
        return;
      }
      setWriteGuard({ ...context, kind: 'delete', status: 'pending' });
      deleteMutation.mutate({ ...context, remoteEntryId });
    },
    [deleteMutation, operationContext, setWriteGuard, taskScope, timeTrackingEnabled],
  );

  const verifyUnknown = useCallback(
    (operationId: string): void => {
      const context = operationContext();
      const guard = writeGuardRef.current;
      if (
        !context ||
        !timeTrackingEnabled ||
        guard?.status !== 'unknown' ||
        guard.operationId !== operationId ||
        guard.operationScope !== operationScope
      ) {
        return;
      }
      verifyMutation.mutate({ ...context, operationId });
    },
    [operationContext, operationScope, timeTrackingEnabled, verifyMutation],
  );

  const acknowledgeUnknown = useCallback(
    (operationId: string): void => {
      const context = operationContext();
      const guard = writeGuardRef.current;
      if (
        !context ||
        !timeTrackingEnabled ||
        guard?.status !== 'unknown' ||
        guard.operationId !== operationId ||
        guard.taskScope !== taskScope
      ) {
        return;
      }
      acknowledgeMutation.mutate({ ...context, operationId });
    },
    [acknowledgeMutation, operationContext, taskScope, timeTrackingEnabled],
  );

  const activeGuard = writeGuard?.taskScope === taskScope ? writeGuard : null;
  const createPresented = createMutation.variables?.operationScope === operationScope;
  const deletePresented = deleteMutation.variables?.operationScope === operationScope;
  const verifyPresented = verifyMutation.variables?.operationScope === operationScope;
  const acknowledgePresented = acknowledgeMutation.variables?.operationScope === operationScope;

  return {
    // Cached data stays hidden while the block is suppressed.
    history: historyAccepted ? historyQuery : { ...historyQuery, data: undefined },
    create: {
      ...createMutation,
      data: createPresented ? createMutation.data : undefined,
      error: createPresented ? createMutation.error : null,
      isPending: createPresented && createMutation.isPending,
      isError: createPresented && createMutation.isError,
      isSuccess: createPresented && createMutation.isSuccess,
      isIdle: !createPresented || createMutation.isIdle,
    },
    createOrigin: createPresented ? (createMutation.variables?.origin ?? null) : null,
    submitCreate,
    delete: {
      ...deleteMutation,
      data: deletePresented ? deleteMutation.data : undefined,
      error: deletePresented ? deleteMutation.error : null,
      isPending: deletePresented && deleteMutation.isPending,
      isError: deletePresented && deleteMutation.isError,
      isSuccess: deletePresented && deleteMutation.isSuccess,
      isIdle: !deletePresented || deleteMutation.isIdle,
    },
    submitDelete,
    verify: {
      ...verifyMutation,
      data: verifyPresented ? verifyMutation.data : undefined,
      error: verifyPresented ? verifyMutation.error : null,
      isPending: verifyPresented && verifyMutation.isPending,
      isError: verifyPresented && verifyMutation.isError,
      isSuccess: verifyPresented && verifyMutation.isSuccess,
    },
    verifyUnknown,
    acknowledge: {
      ...acknowledgeMutation,
      data: acknowledgePresented ? acknowledgeMutation.data : undefined,
      error: acknowledgePresented ? acknowledgeMutation.error : null,
      isPending: acknowledgePresented && acknowledgeMutation.isPending,
      isError: acknowledgePresented && acknowledgeMutation.isError,
      isSuccess: acknowledgePresented && acknowledgeMutation.isSuccess,
    },
    acknowledgeUnknown,
    unknownOperationId: activeGuard?.status === 'unknown' ? activeGuard.operationId : null,
    blockedByUnknown: activeGuard?.status === 'unknown',
    canVerifyUnknown:
      activeGuard?.status === 'unknown' && activeGuard.operationScope === operationScope,
    writeBlocked: activeGuard !== null,
  };
}

export type ExternalTaskTimeEntriesController = ReturnType<typeof useExternalTaskTimeEntries>;
