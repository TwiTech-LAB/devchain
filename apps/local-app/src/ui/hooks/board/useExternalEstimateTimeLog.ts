import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  EpicTimeDailyTotal,
  ExternalEstimateCreateTimeEntryResponse,
  ExternalEstimateLogStateView,
  ExternalEstimateOperationAction,
  ExternalEstimateResolveOperationResponse,
} from '@/modules/epic-time/models/epic-time.models';
import { useFetchFactory } from '@/ui/hooks/useFetchFactory';
import { useOptionalWorktreeTab } from '@/ui/hooks/useWorktreeTab';
import type { ExternalBoardProvider } from '@/ui/lib/external-board';
import { externalMyWorkQueryKeys } from '@/ui/lib/external-my-work';
import { integrationConnectionGeneration } from '@/ui/lib/external-time';
import type { IntegrationConnectionEpoch } from '@/ui/lib/integration-connections';
import {
  validIntegrationProjectId,
  withIntegrationProjectId,
} from '@/ui/lib/integration-project-scope';
import { fetchJsonOrThrow } from '@/ui/lib/sessions';

export interface ExternalEstimateCreateSnapshot {
  estimateTotalMinutes: number;
  expectedRevision: number;
  timeZone: string;
  remoteScopeKey: string;
  /** Immutable captured daily projection: unique ascending dates summing to the total. */
  dailySnapshot: EpicTimeDailyTotal[];
}

interface EstimateRequestContext {
  scopeId: string;
  provider: ExternalBoardProvider;
  projectId: string;
  taskId: string;
  remoteScopeKey: string;
  connectionEpoch: IntegrationConnectionEpoch;
  generation: string;
  queryKey: ReturnType<typeof externalMyWorkQueryKeys.taskEstimateLogState>;
}

interface CreateRequest extends EstimateRequestContext {
  requestKey: string;
  snapshot: ExternalEstimateCreateSnapshot;
}

interface SetRequest extends EstimateRequestContext {
  loggedMinutes: number;
  expectedRevision: number;
  timeZone: string;
}

interface ResolveRequest extends EstimateRequestContext {
  operationId: string;
  action: ExternalEstimateOperationAction;
  expectedRevision: number;
}

interface AssignLegacyRequest extends EstimateRequestContext {
  expectedLegacyRevision: number;
}

/** One fresh browser UUID per click; never a stable Epic or task id. */
function estimateRequestKey(): string {
  return window.crypto.randomUUID();
}

function mutationHeaders(
  request: EstimateRequestContext,
  operationId?: string,
): Record<string, string> {
  return {
    'X-DevChain-Connection-Epoch': request.generation,
    'Content-Type': 'application/json',
    ...(operationId ? { 'Idempotency-Key': operationId } : {}),
  };
}

/**
 * Main-runtime-only incremental estimate checkpoint controller. Disabled
 * runtimes observe an isolated key and expose no main-cache data; every
 * mutation carries an immutable project/provider/task/scope/epoch context.
 */
export function useExternalEstimateTimeLog(
  provider: ExternalBoardProvider,
  taskId: string | null,
  {
    enabled,
    connectionEpoch,
    projectId,
    remoteScopeKey,
  }: {
    enabled: boolean;
    connectionEpoch: IntegrationConnectionEpoch | null;
    projectId: string | null;
    remoteScopeKey: string | null;
  },
) {
  const apiFetch = useFetchFactory();
  const queryClient = useQueryClient();
  const { runtimeResolved, apiBase } = useOptionalWorktreeTab();
  const scopedProjectId = validIntegrationProjectId(projectId);
  const generation = integrationConnectionGeneration(connectionEpoch);
  const normalizedScopeKey = remoteScopeKey?.trim() ?? '';
  const admitted =
    enabled &&
    runtimeResolved &&
    apiBase === '' &&
    scopedProjectId !== null &&
    connectionEpoch !== null &&
    generation !== null &&
    taskId !== null &&
    normalizedScopeKey.length > 0;
  const runtimeScope = admitted ? 'main' : 'isolated';
  const scopeId = `${runtimeScope}\u0000${scopedProjectId ?? ''}\u0000${provider}\u0000${connectionEpoch ?? ''}\u0000${taskId ?? ''}\u0000${normalizedScopeKey}`;
  const stateKey = useMemo(
    () =>
      externalMyWorkQueryKeys.taskEstimateLogState(
        provider,
        connectionEpoch,
        scopedProjectId ?? '',
        taskId ?? '',
        normalizedScopeKey,
        runtimeScope,
      ),
    [connectionEpoch, normalizedScopeKey, provider, runtimeScope, scopedProjectId, taskId],
  );

  const stateQuery = useQuery({
    queryKey: stateKey,
    queryFn: ({ signal }) =>
      fetchJsonOrThrow<ExternalEstimateLogStateView>(
        withIntegrationProjectId(
          `/api/integrations/my-work/${provider}/tasks/${encodeURIComponent(taskId as string)}/estimate-log-state?scopeKey=${encodeURIComponent(normalizedScopeKey)}`,
          scopedProjectId,
        ),
        {
          signal,
          headers: { 'X-DevChain-Connection-Epoch': generation ?? '' },
        },
        'The estimate checkpoint could not be loaded.',
        '',
        apiFetch,
      ),
    enabled: admitted,
  });

  const requestContext = useCallback((): EstimateRequestContext | null => {
    if (
      !admitted ||
      scopedProjectId === null ||
      connectionEpoch === null ||
      generation === null ||
      taskId === null
    ) {
      return null;
    }
    return {
      scopeId,
      provider,
      projectId: scopedProjectId,
      taskId,
      remoteScopeKey: normalizedScopeKey,
      connectionEpoch,
      generation,
      queryKey: stateKey,
    };
  }, [
    admitted,
    connectionEpoch,
    generation,
    normalizedScopeKey,
    provider,
    scopeId,
    scopedProjectId,
    stateKey,
    taskId,
  ]);

  /**
   * Refreshes the link-decoration family for the captured provider and epoch.
   * The prefix covers every input set and both enrichment variants, and this
   * path never invalidates the checkpoint query itself, so no loop can form.
   */
  const invalidateLinks = useCallback(
    (request: Pick<EstimateRequestContext, 'provider' | 'connectionEpoch'>): Promise<void> =>
      queryClient.invalidateQueries({
        queryKey: externalMyWorkQueryKeys.links(request.provider, request.connectionEpoch),
      }),
    [queryClient],
  );

  const capturedLinksKey = useMemo(
    () =>
      admitted && connectionEpoch !== null
        ? externalMyWorkQueryKeys.links(provider, connectionEpoch)
        : null,
    [admitted, connectionEpoch, provider],
  );
  // Every successful admitted checkpoint fetch reconciles link decoration —
  // including a success-to-success refetch whose payload is structurally
  // equal, where TanStack structural sharing preserves the data reference and
  // the observed query props never change. The successful data-update
  // timestamp moves on every successful fetch, making it the settlement
  // signal. This path never invalidates the checkpoint query itself, so no
  // loop can form.
  const checkpointSucceeded = stateQuery.isSuccess && stateQuery.error === null;
  const checkpointDataUpdatedAt = stateQuery.dataUpdatedAt;
  useEffect(() => {
    if (capturedLinksKey === null || !checkpointSucceeded) return;
    void queryClient.invalidateQueries({ queryKey: capturedLinksKey });
  }, [capturedLinksKey, checkpointDataUpdatedAt, checkpointSucceeded, queryClient]);

  // One scheduled Verify expiry per pending operation: at the server-owned
  // receipt deadline Verify fails closed locally before the checkpoint
  // refetches exactly once. A failed refetch may retain stale query data, but
  // it can never restore the expired action. No polling, and no TTL is
  // recomputed from mount time.
  const verifyExpiresAt = admitted ? (stateQuery.data?.verifyExpiresAt ?? null) : null;
  const [expiredVerify, setExpiredVerify] = useState<{
    scopeId: string;
    deadline: string;
  } | null>(null);
  useEffect(() => {
    if (verifyExpiresAt === null) {
      setExpiredVerify(null);
      return;
    }
    const deadlineMs = Date.parse(verifyExpiresAt);
    const expireAndRefetch = () => {
      setExpiredVerify({ scopeId, deadline: verifyExpiresAt });
      void queryClient.invalidateQueries({ queryKey: stateKey, exact: true });
    };
    if (Number.isNaN(deadlineMs) || deadlineMs <= Date.now()) {
      expireAndRefetch();
      return;
    }
    setExpiredVerify(null);
    const timer = window.setTimeout(expireAndRefetch, deadlineMs - Date.now());
    return () => window.clearTimeout(timer);
  }, [queryClient, scopeId, stateKey, verifyExpiresAt]);

  const invalidateCheckpoint = useCallback(
    async (request: EstimateRequestContext, state: ExternalEstimateLogStateView): Promise<void> => {
      queryClient.setQueryData(request.queryKey, state);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: request.queryKey, exact: true }),
        invalidateLinks(request),
      ]);
    },
    [invalidateLinks, queryClient],
  );

  const invalidateProviderTime = useCallback(
    async (request: EstimateRequestContext): Promise<void> => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: externalMyWorkQueryKeys.taskDetail(
            request.provider,
            request.connectionEpoch,
            request.taskId,
          ),
          exact: true,
        }),
        queryClient.invalidateQueries({
          queryKey: externalMyWorkQueryKeys.taskTimeEntries(
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

  const createMutation = useMutation({
    mutationFn: (request: CreateRequest): Promise<ExternalEstimateCreateTimeEntryResponse> =>
      fetchJsonOrThrow<ExternalEstimateCreateTimeEntryResponse>(
        withIntegrationProjectId(
          `/api/integrations/my-work/${request.provider}/tasks/${encodeURIComponent(request.taskId)}/estimate-time-entries`,
          request.projectId,
        ),
        {
          method: 'POST',
          headers: mutationHeaders(request, request.requestKey),
          body: JSON.stringify({
            scopeKey: request.snapshot.remoteScopeKey,
            requestKey: request.requestKey,
            timeZone: request.snapshot.timeZone,
            estimateTotalMinutes: request.snapshot.estimateTotalMinutes,
            expectedRevision: request.snapshot.expectedRevision,
            dailySnapshot: request.snapshot.dailySnapshot,
          }),
        },
        'The new estimate time could not be logged.',
        '',
        apiFetch,
      ),
    onSuccess: async (result, request) => {
      await invalidateCheckpoint(request, result.state);
      // Any create outcome may have written provider entries — a settled
      // prefix always did, and an unknown item may have — so the detail,
      // history, and link decoration all refresh.
      await invalidateProviderTime(request);
    },
    onError: async (_error, request) => {
      // A transport failure cannot prove whether durable preparation or the
      // provider write occurred. Reset removes cached readiness before the
      // active query reconciles with server state, and every provider-derived
      // family a possibly settled or unknown prefix could touch refreshes.
      // The POST itself is never retried; the next explicit click uses a
      // fresh request key.
      await queryClient.resetQueries({ queryKey: request.queryKey, exact: true });
      await invalidateProviderTime(request);
      await invalidateLinks(request);
    },
  });

  const setMutation = useMutation({
    mutationFn: (request: SetRequest): Promise<ExternalEstimateLogStateView> =>
      fetchJsonOrThrow<ExternalEstimateLogStateView>(
        withIntegrationProjectId(
          `/api/integrations/my-work/${request.provider}/tasks/${encodeURIComponent(request.taskId)}/estimate-log-state`,
          request.projectId,
        ),
        {
          method: 'PUT',
          headers: mutationHeaders(request),
          body: JSON.stringify({
            scopeKey: request.remoteScopeKey,
            loggedMinutes: request.loggedMinutes,
            expectedRevision: request.expectedRevision,
            timeZone: request.timeZone,
          }),
        },
        'The logged estimate could not be updated.',
        '',
        apiFetch,
      ),
    onSuccess: (state, request) => invalidateCheckpoint(request, state),
  });

  const resolveMutation = useMutation({
    mutationFn: (request: ResolveRequest): Promise<ExternalEstimateResolveOperationResponse> =>
      fetchJsonOrThrow<ExternalEstimateResolveOperationResponse>(
        withIntegrationProjectId(
          `/api/integrations/my-work/${request.provider}/tasks/${encodeURIComponent(request.taskId)}/estimate-time-operations/${encodeURIComponent(request.operationId)}/resolve`,
          request.projectId,
        ),
        {
          method: 'POST',
          headers: mutationHeaders(request, request.operationId),
          body: JSON.stringify({
            scopeKey: request.remoteScopeKey,
            action: request.action,
            expectedRevision: request.expectedRevision,
          }),
        },
        'The estimate operation could not be resolved.',
        '',
        apiFetch,
      ),
    onSuccess: async (result, request) => {
      await invalidateCheckpoint(request, result.state);
      if (result.outcome === 'logged') {
        await invalidateProviderTime(request);
      }
    },
  });

  // One-time ownership recovery for unassigned legacy history. The request
  // captures the immutable project/remote-identity/epoch context plus the
  // legacy revision the caller saw; success returns the moved checkpoint.
  const assignLegacyMutation = useMutation({
    mutationFn: (request: AssignLegacyRequest): Promise<ExternalEstimateLogStateView> =>
      fetchJsonOrThrow<ExternalEstimateLogStateView>(
        withIntegrationProjectId(
          `/api/integrations/my-work/${request.provider}/tasks/${encodeURIComponent(request.taskId)}/estimate-log-legacy-assignment`,
          request.projectId,
        ),
        {
          method: 'POST',
          headers: mutationHeaders(request),
          body: JSON.stringify({
            scopeKey: request.remoteScopeKey,
            expectedLegacyRevision: request.expectedLegacyRevision,
          }),
        },
        'The previous logged time could not be assigned.',
        '',
        apiFetch,
      ),
    onSuccess: (state, request) => invalidateCheckpoint(request, state),
  });

  const submitCreate = useCallback(
    (snapshot: ExternalEstimateCreateSnapshot): void => {
      const request = requestContext();
      if (
        !request ||
        snapshot.remoteScopeKey !== request.remoteScopeKey ||
        stateQuery.data?.pending !== null ||
        createMutation.isPending ||
        setMutation.isPending ||
        resolveMutation.isPending
      ) {
        return;
      }
      createMutation.mutate({ ...request, requestKey: estimateRequestKey(), snapshot });
    },
    [
      createMutation,
      requestContext,
      resolveMutation.isPending,
      setMutation.isPending,
      stateQuery.data,
    ],
  );

  const setLoggedMinutes = useCallback(
    (loggedMinutes: number, expectedRevision: number, timeZone: string): void => {
      const request = requestContext();
      if (
        !request ||
        stateQuery.data?.pending !== null ||
        createMutation.isPending ||
        setMutation.isPending ||
        resolveMutation.isPending
      ) {
        return;
      }
      setMutation.mutate({ ...request, loggedMinutes, expectedRevision, timeZone });
    },
    [
      createMutation.isPending,
      requestContext,
      resolveMutation.isPending,
      setMutation,
      stateQuery.data,
    ],
  );

  const resolve = useCallback(
    (
      operationId: string,
      action: ExternalEstimateOperationAction,
      expectedRevision: number,
    ): void => {
      const request = requestContext();
      if (
        !request ||
        stateQuery.data?.pending?.operationId !== operationId ||
        createMutation.isPending ||
        setMutation.isPending ||
        resolveMutation.isPending
      ) {
        return;
      }
      resolveMutation.mutate({ ...request, operationId, action, expectedRevision });
    },
    [
      createMutation.isPending,
      requestContext,
      resolveMutation,
      setMutation.isPending,
      stateQuery.data,
    ],
  );

  /** Claims the unassigned legacy history for this project; available only
   * while the checkpoint reports it and no other estimate write is running. */
  const assignLegacy = useCallback((): void => {
    const request = requestContext();
    const legacyRevision = stateQuery.data?.legacyCheckpoint?.revision;
    if (
      !request ||
      legacyRevision === undefined ||
      createMutation.isPending ||
      setMutation.isPending ||
      resolveMutation.isPending ||
      assignLegacyMutation.isPending
    ) {
      return;
    }
    assignLegacyMutation.mutate({ ...request, expectedLegacyRevision: legacyRevision });
  }, [
    assignLegacyMutation,
    createMutation.isPending,
    requestContext,
    resolveMutation.isPending,
    setMutation.isPending,
    stateQuery.data,
  ]);

  const rawState = admitted ? stateQuery.data : undefined;
  const currentVerifyDeadline = rawState?.verifyExpiresAt ?? null;
  const verifyExpiredLocally =
    currentVerifyDeadline !== null &&
    expiredVerify?.scopeId === scopeId &&
    expiredVerify.deadline === currentVerifyDeadline;
  const state =
    rawState && verifyExpiredLocally && rawState.canVerify
      ? { ...rawState, canVerify: false }
      : rawState;
  const createPresented = createMutation.variables?.scopeId === scopeId;
  const setPresented = setMutation.variables?.scopeId === scopeId;
  const resolvePresented = resolveMutation.variables?.scopeId === scopeId;
  const assignLegacyPresented = assignLegacyMutation.variables?.scopeId === scopeId;
  const mutationPending =
    (createPresented && createMutation.isPending) ||
    (setPresented && setMutation.isPending) ||
    (resolvePresented && resolveMutation.isPending) ||
    (assignLegacyPresented && assignLegacyMutation.isPending);
  const writeBlocked =
    admitted && (state === undefined || state.pending !== null || mutationPending);

  return {
    admitted,
    state,
    /** One-shot checkpoint refetch for stale-capture recapture flows. */
    refetchCheckpoint: async (): Promise<void> => {
      if (!admitted) return;
      await stateQuery.refetch();
    },
    query: admitted
      ? { ...stateQuery, data: state }
      : { ...stateQuery, data: undefined, isSuccess: false, isFetched: false },
    create: {
      ...createMutation,
      data: createPresented ? createMutation.data : undefined,
      error: createPresented ? createMutation.error : null,
      isPending: createPresented && createMutation.isPending,
      isError: createPresented && createMutation.isError,
      isSuccess: createPresented && createMutation.isSuccess,
    },
    submitCreate,
    setLogged: {
      ...setMutation,
      data: setPresented ? setMutation.data : undefined,
      error: setPresented ? setMutation.error : null,
      isPending: setPresented && setMutation.isPending,
      isError: setPresented && setMutation.isError,
      isSuccess: setPresented && setMutation.isSuccess,
    },
    setLoggedMinutes,
    resolve: {
      ...resolveMutation,
      data: resolvePresented ? resolveMutation.data : undefined,
      error: resolvePresented ? resolveMutation.error : null,
      isPending: resolvePresented && resolveMutation.isPending,
      isError: resolvePresented && resolveMutation.isError,
      isSuccess: resolvePresented && resolveMutation.isSuccess,
    },
    resolveOperation: resolve,
    assignLegacy: {
      ...assignLegacyMutation,
      data: assignLegacyPresented ? assignLegacyMutation.data : undefined,
      error: assignLegacyPresented ? assignLegacyMutation.error : null,
      isPending: assignLegacyPresented && assignLegacyMutation.isPending,
      isError: assignLegacyPresented && assignLegacyMutation.isError,
      isSuccess: assignLegacyPresented && assignLegacyMutation.isSuccess,
    },
    submitAssignLegacy: assignLegacy,
    legacyCheckpoint: state?.legacyCheckpoint ?? null,
    mutationPending,
    durablePending: state?.pending !== null && state?.pending !== undefined,
    writeBlocked,
  };
}

export type ExternalEstimateTimeLogController = ReturnType<typeof useExternalEstimateTimeLog>;
