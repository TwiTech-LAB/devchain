import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ExternalTaskTimeEntryHistory,
  ExternalTaskTimeEntryInput,
} from '@/modules/external-integrations/models/external-provider.models';
import type {
  ExternalTimeEntryCreateResult,
  ExternalTimeEntryDeleteResult,
  ExternalTimeEntryUpdateResult,
  ExternalTimeOperationReceiptView,
  ExternalTimeOperationVerifyResult,
} from '@/modules/external-integrations/models/external-time-mutation.models';
import { useFetchFactory } from '@/ui/hooks/useFetchFactory';
import type { ExternalBoardProvider } from '@/ui/lib/external-board';
import { externalMyWorkQueryKeys } from '@/ui/lib/external-my-work';
import { integrationConnectionGeneration } from '@/ui/lib/external-time';
import type { IntegrationConnectionEpoch } from '@/ui/lib/integration-connections';
import {
  validIntegrationProjectId,
  withIntegrationProjectId,
} from '@/ui/lib/integration-project-scope';
import { fetchJsonOrThrow } from '@/ui/lib/sessions';

function timeOperationId(): string {
  return window.crypto.randomUUID();
}

type TimeEntryWriteKind = 'create' | 'update' | 'delete';

interface OperationContext {
  operationId: string;
  taskScope: string;
  operationScope: string;
  provider: ExternalBoardProvider;
  projectId: string;
  taskId: string;
  remoteScopeKey: string;
  connectionEpoch: IntegrationConnectionEpoch;
  generation: string;
}

interface CreateRequest extends OperationContext {
  input: ExternalTaskTimeEntryInput;
}

interface DeleteRequest extends OperationContext {
  remoteEntryId: string;
}

interface UpdateRequest extends DeleteRequest {
  input: ExternalTaskTimeEntryInput;
}

type ResolutionRequest = OperationContext;

type TaskWriteGuard = OperationContext & {
  status: 'pending' | 'unknown';
  kind: TimeEntryWriteKind;
  /** Server-owned verify availability for the unknown receipt. */
  canVerify: boolean;
  /** Receipt expiry (ISO); Verify hides at this deadline, the lock stays. */
  expiresAt: string | null;
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
    projectId,
    remoteScopeKey,
    identityAccepted,
    timeTrackingEnabled,
  }: {
    enabled: boolean;
    historyOpen: boolean;
    connectionEpoch: IntegrationConnectionEpoch | null;
    projectId: string | null;
    remoteScopeKey: string | null;
    identityAccepted: boolean;
    timeTrackingEnabled: boolean;
  },
) {
  const apiFetch = useFetchFactory();
  const queryClient = useQueryClient();
  const encodedTaskId = taskId ? encodeURIComponent(taskId) : '';
  const scopedProjectId = validIntegrationProjectId(projectId);
  const generation = integrationConnectionGeneration(connectionEpoch);
  const normalizedScopeKey = remoteScopeKey?.trim() ?? '';
  // Scope is authoritative mutation input, but task-detail cache eviction must
  // not erase it mid-write. The base excludes epoch because duplicate risk
  // survives connection replacement for the same durable remote task.
  const identityBase = `${scopedProjectId ?? ''}\u0000${provider}\u0000${taskId ?? ''}`;
  const rememberedIdentityRef = useRef({ base: identityBase, remoteScopeKey: '' });
  if (rememberedIdentityRef.current.base !== identityBase) {
    rememberedIdentityRef.current = { base: identityBase, remoteScopeKey: '' };
  }
  if (normalizedScopeKey.length > 0) {
    rememberedIdentityRef.current.remoteScopeKey = normalizedScopeKey;
  }
  const effectiveScopeKey = normalizedScopeKey || rememberedIdentityRef.current.remoteScopeKey;
  const accepted =
    enabled &&
    scopedProjectId !== null &&
    generation !== null &&
    taskId !== null &&
    effectiveScopeKey.length > 0 &&
    identityAccepted;
  const historyAccepted = accepted && timeTrackingEnabled && historyOpen;
  // Duplicate risk survives credential replacement for the same provider task;
  // pending/error/success presentation remains bound to the admitted epoch.
  const taskScope = `${scopedProjectId ?? ''}\u0000${provider}\u0000${effectiveScopeKey}\u0000${taskId ?? ''}`;
  const operationScope = `${scopedProjectId ?? ''}\u0000${provider}\u0000${connectionEpoch ?? ''}\u0000${effectiveScopeKey}\u0000${taskId ?? ''}`;
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
        withIntegrationProjectId(
          `/api/integrations/my-work/${provider}/tasks/${encodedTaskId}/time-entries`,
          scopedProjectId,
        ),
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
    (
      request: OperationContext,
      kind: TimeEntryWriteKind,
      receipt: ExternalTimeOperationReceiptView,
    ): void => {
      if (
        currentTaskScopeRef.current === request.taskScope &&
        writeGuardRef.current?.operationId === request.operationId
      ) {
        setWriteGuard({
          ...request,
          operationId: receipt.operationId,
          kind,
          status: 'unknown',
          canVerify: receipt.canVerify,
          expiresAt: receipt.expiresAt,
        });
      }
    },
    [setWriteGuard],
  );

  const createMutation = useMutation({
    mutationFn: async (request: CreateRequest): Promise<ExternalTimeEntryCreateResult> =>
      fetchJsonOrThrow<ExternalTimeEntryCreateResult>(
        withIntegrationProjectId(
          `/api/integrations/my-work/${request.provider}/tasks/${encodeURIComponent(request.taskId)}/time-entries?scopeKey=${encodeURIComponent(request.remoteScopeKey)}`,
          request.projectId,
        ),
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
        retainUnknownGuard(request, 'create', result.receipt);
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
        withIntegrationProjectId(
          `/api/integrations/my-work/${request.provider}/time-operations/${encodeURIComponent(request.operationId)}/verify`,
          request.projectId,
        ),
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
        withIntegrationProjectId(
          `/api/integrations/my-work/${request.provider}/time-operations/${encodeURIComponent(request.operationId)}/acknowledge`,
          request.projectId,
        ),
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
        withIntegrationProjectId(
          `/api/integrations/my-work/${request.provider}/tasks/${encodeURIComponent(request.taskId)}/time-entries/${encodeURIComponent(request.remoteEntryId)}?scopeKey=${encodeURIComponent(request.remoteScopeKey)}`,
          request.projectId,
        ),
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
        retainUnknownGuard(request, 'delete', result.receipt);
        return;
      }
      clearMatchingGuard(request);
      await refetchAfterWrite(request);
    },
    onError: (_error, request) => clearMatchingGuard(request),
  });

  const updateMutation = useMutation({
    mutationFn: async (request: UpdateRequest): Promise<ExternalTimeEntryUpdateResult> =>
      fetchJsonOrThrow<ExternalTimeEntryUpdateResult>(
        withIntegrationProjectId(
          `/api/integrations/my-work/${request.provider}/tasks/${encodeURIComponent(request.taskId)}/time-entries/${encodeURIComponent(request.remoteEntryId)}?scopeKey=${encodeURIComponent(request.remoteScopeKey)}`,
          request.projectId,
        ),
        {
          method: 'PUT',
          headers: mutationHeaders(request),
          body: JSON.stringify(request.input),
        },
        'The time entry could not be updated.',
        '',
        apiFetch,
      ),
    onSuccess: async (result, request) => {
      if (result.outcome === 'outcome_unknown') {
        retainUnknownGuard(request, 'update', result.receipt);
        return;
      }
      clearMatchingGuard(request);
      await refetchAfterWrite(request);
    },
    onError: (_error, request) => clearMatchingGuard(request),
  });

  const operationContext = useCallback((): OperationContext | null => {
    if (
      !accepted ||
      scopedProjectId === null ||
      taskId === null ||
      connectionEpoch === null ||
      generation === null
    ) {
      return null;
    }
    return {
      operationId: timeOperationId(),
      taskScope,
      operationScope,
      provider,
      projectId: scopedProjectId,
      taskId,
      remoteScopeKey: effectiveScopeKey,
      connectionEpoch,
      generation,
    };
  }, [
    accepted,
    connectionEpoch,
    generation,
    effectiveScopeKey,
    operationScope,
    provider,
    scopedProjectId,
    taskId,
    taskScope,
  ]);

  const submitCreate = useCallback(
    (input: ExternalTaskTimeEntryInput): void => {
      const context = operationContext();
      if (!context || !timeTrackingEnabled || writeGuardRef.current?.taskScope === taskScope) {
        return;
      }
      setWriteGuard({
        ...context,
        kind: 'create',
        status: 'pending',
        canVerify: false,
        expiresAt: null,
      });
      createMutation.mutate({ ...context, input });
    },
    [createMutation, operationContext, setWriteGuard, taskScope, timeTrackingEnabled],
  );

  const submitDelete = useCallback(
    (remoteEntryId: string): void => {
      const context = operationContext();
      if (!context || !timeTrackingEnabled || writeGuardRef.current?.taskScope === taskScope) {
        return;
      }
      setWriteGuard({
        ...context,
        kind: 'delete',
        status: 'pending',
        canVerify: false,
        expiresAt: null,
      });
      deleteMutation.mutate({ ...context, remoteEntryId });
    },
    [deleteMutation, operationContext, setWriteGuard, taskScope, timeTrackingEnabled],
  );

  const submitUpdate = useCallback(
    (remoteEntryId: string, input: ExternalTaskTimeEntryInput): void => {
      const context = operationContext();
      if (!context || !timeTrackingEnabled || writeGuardRef.current?.taskScope === taskScope) {
        return;
      }
      setWriteGuard({
        ...context,
        kind: 'update',
        status: 'pending',
        canVerify: false,
        expiresAt: null,
      });
      updateMutation.mutate({ ...context, remoteEntryId, input });
    },
    [operationContext, setWriteGuard, taskScope, timeTrackingEnabled, updateMutation],
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
      // After the receipt deadline the server store has dropped the receipt,
      // so its acknowledgement endpoint must 404. The explicit user action
      // then clears exactly this local guard — no provider request, no
      // receipt request — and only on the epoch that owns the receipt: a
      // replaced connection's guard is not this epoch's to settle.
      const deadlineMs = guard.expiresAt !== null ? Date.parse(guard.expiresAt) : null;
      if (deadlineMs !== null && !Number.isNaN(deadlineMs) && Date.now() >= deadlineMs) {
        if (guard.operationScope !== operationScope) {
          return;
        }
        setWriteGuard(null);
        return;
      }
      acknowledgeMutation.mutate({ ...context, operationId });
    },
    [
      acknowledgeMutation,
      operationContext,
      operationScope,
      setWriteGuard,
      taskScope,
      timeTrackingEnabled,
    ],
  );

  const activeGuard = writeGuard?.taskScope === taskScope ? writeGuard : null;
  const verifyDeadlineMs =
    activeGuard?.status === 'unknown' && activeGuard.expiresAt !== null
      ? Date.parse(activeGuard.expiresAt)
      : null;
  const [verifyClockMs, setVerifyClockMs] = useState(() => Date.now());

  // Verify lives exactly as long as its receipt. A suspended tab throttles
  // timers, so focus and visibility resume re-read the wall clock too.
  // Expiry hides only Verify; the unknown write lock stays until resolution.
  useEffect(() => {
    const refreshVerifyClock = () => setVerifyClockMs(Date.now());
    refreshVerifyClock();
    if (verifyDeadlineMs === null) {
      return;
    }
    const timer = window.setTimeout(refreshVerifyClock, Math.max(0, verifyDeadlineMs - Date.now()));
    window.addEventListener('focus', refreshVerifyClock);
    document.addEventListener('visibilitychange', refreshVerifyClock);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('focus', refreshVerifyClock);
      document.removeEventListener('visibilitychange', refreshVerifyClock);
    };
  }, [verifyDeadlineMs]);

  const createPresented = createMutation.variables?.operationScope === operationScope;
  const updatePresented = updateMutation.variables?.operationScope === operationScope;
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
    submitCreate,
    update: {
      ...updateMutation,
      data: updatePresented ? updateMutation.data : undefined,
      error: updatePresented ? updateMutation.error : null,
      isPending: updatePresented && updateMutation.isPending,
      isError: updatePresented && updateMutation.isError,
      isSuccess: updatePresented && updateMutation.isSuccess,
      isIdle: !updatePresented || updateMutation.isIdle,
    },
    submitUpdate,
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
    unknownOperationKind: activeGuard?.status === 'unknown' ? activeGuard.kind : null,
    blockedByUnknown: activeGuard?.status === 'unknown',
    // The server receipt owns availability; the client adds only the live
    // operation scope and the receipt's own deadline. A missing or malformed
    // expiry fails closed.
    canVerifyUnknown:
      activeGuard?.status === 'unknown' &&
      activeGuard.operationScope === operationScope &&
      activeGuard.canVerify &&
      verifyDeadlineMs !== null &&
      !Number.isNaN(verifyDeadlineMs) &&
      verifyClockMs < verifyDeadlineMs,
    writeBlocked: activeGuard !== null,
  };
}

export type ExternalTaskTimeEntriesController = ReturnType<typeof useExternalTaskTimeEntries>;
