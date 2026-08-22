import { useCallback, useEffect, useMemo, useState } from 'react';
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

/**
 * Duration-first time-entry management for one remote task: history loading,
 * entry creation, operation verification, and entry deletion — all behind
 * the epoch precondition header and idempotency keys the backend requires.
 *
 * Suppression contract: while the epoch, task identity, or `log_time`
 * capability is unaccepted, no history request runs, cached history stays
 * hidden, and every mutation refuses to dispatch.
 */
export function useExternalTaskTimeEntries(
  provider: ExternalBoardProvider,
  taskId: string | null,
  {
    enabled,
    connectionEpoch,
    identityAccepted,
    timeTrackingEnabled,
  }: {
    enabled: boolean;
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

  const timeEntriesKey = useMemo(
    () => externalMyWorkQueryKeys.taskTimeEntries(provider, connectionEpoch, taskId ?? ''),
    [provider, connectionEpoch, taskId],
  );
  const taskDetailKey = useMemo(
    () => externalMyWorkQueryKeys.taskDetail(provider, connectionEpoch, taskId ?? ''),
    [provider, connectionEpoch, taskId],
  );

  // A create whose outcome stayed unknown blocks new creates until the user
  // acknowledges the duplicate risk (verify or abandon) — the receipt store
  // guarantees the same operation id can never re-dispatch.
  const [unknownOperationId, setUnknownOperationId] = useState<string | null>(null);

  const timeHeaders = useMemo<Record<string, string>>(
    () => ({
      'X-DevChain-Connection-Epoch': generation ?? '',
      'Content-Type': 'application/json',
    }),
    [generation],
  );

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
    enabled: accepted && timeTrackingEnabled,
  });

  const refetchAfterWrite = useCallback(async (): Promise<void> => {
    // Writes change exactly two things: this task's history and its total.
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: timeEntriesKey, exact: true }),
      queryClient.invalidateQueries({ queryKey: taskDetailKey, exact: true }),
    ]);
  }, [queryClient, timeEntriesKey, taskDetailKey]);

  const createMutation = useMutation({
    mutationFn: async (input: ExternalTaskTimeEntryInput): Promise<ExternalTimeEntryCreateResult> =>
      fetchJsonOrThrow<ExternalTimeEntryCreateResult>(
        `/api/integrations/my-work/${provider}/tasks/${encodedTaskId}/time-entries`,
        {
          method: 'POST',
          headers: { ...timeHeaders, 'Idempotency-Key': timeOperationId() },
          body: JSON.stringify(input),
        },
        'The time entry could not be submitted.',
        '',
        apiFetch,
      ),
    onSuccess: async (result) => {
      if (result.outcome === 'outcome_unknown') {
        setUnknownOperationId(result.receipt.operationId);
        return;
      }
      await refetchAfterWrite();
    },
  });

  const verifyMutation = useMutation({
    mutationFn: async (operationId: string): Promise<ExternalTimeOperationVerifyResult> =>
      fetchJsonOrThrow<ExternalTimeOperationVerifyResult>(
        `/api/integrations/my-work/${provider}/time-operations/${encodeURIComponent(operationId)}/verify`,
        {
          method: 'POST',
          headers: { ...timeHeaders, 'Idempotency-Key': timeOperationId() },
        },
        'The operation could not be verified.',
        '',
        apiFetch,
      ),
    onSuccess: async (result) => {
      if (result.resolved) {
        setUnknownOperationId(null);
        await refetchAfterWrite();
      }
    },
  });

  const acknowledgeMutation = useMutation({
    mutationFn: async (operationId: string): Promise<ExternalTimeOperationReceiptView> =>
      fetchJsonOrThrow<ExternalTimeOperationReceiptView>(
        `/api/integrations/my-work/${provider}/time-operations/${encodeURIComponent(operationId)}/acknowledge`,
        {
          method: 'POST',
          headers: { ...timeHeaders, 'Idempotency-Key': timeOperationId() },
        },
        'The duplicate risk could not be acknowledged.',
        '',
        apiFetch,
      ),
    onSuccess: async () => {
      setUnknownOperationId(null);
      await refetchAfterWrite();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (remoteEntryId: string): Promise<ExternalTimeEntryDeleteResult> =>
      fetchJsonOrThrow<ExternalTimeEntryDeleteResult>(
        `/api/integrations/my-work/${provider}/tasks/${encodedTaskId}/time-entries/${encodeURIComponent(remoteEntryId)}`,
        {
          method: 'DELETE',
          headers: { ...timeHeaders, 'Idempotency-Key': timeOperationId() },
        },
        'The time entry could not be deleted.',
        '',
        apiFetch,
      ),
    onSuccess: async (result) => {
      if (result.outcome === 'outcome_unknown') {
        setUnknownOperationId(result.receipt.operationId);
        return;
      }
      await refetchAfterWrite();
    },
  });

  // An unknown outcome belongs to exactly one task on one provider: the
  // dialog reuses this hook instance across task switches, so the lock and
  // every operation surface must reset before the next task renders, never
  // carrying a prior task's ambiguity into its form.
  useEffect(() => {
    setUnknownOperationId(null);
    createMutation.reset();
    deleteMutation.reset();
    verifyMutation.reset();
    acknowledgeMutation.reset();
  }, [taskId, provider]);

  const submitCreate = useCallback(
    (input: ExternalTaskTimeEntryInput): void => {
      if (!accepted || !timeTrackingEnabled || unknownOperationId !== null) return;
      createMutation.mutate(input);
    },
    [accepted, timeTrackingEnabled, unknownOperationId, createMutation],
  );

  const submitDelete = useCallback(
    (remoteEntryId: string): void => {
      if (!accepted || !timeTrackingEnabled) return;
      deleteMutation.mutate(remoteEntryId);
    },
    [accepted, timeTrackingEnabled, deleteMutation],
  );

  const verifyUnknown = useCallback(
    (operationId: string): void => {
      if (!accepted) return;
      verifyMutation.mutate(operationId);
    },
    [accepted, verifyMutation],
  );

  const acknowledgeUnknown = useCallback(
    (operationId: string): void => {
      if (!accepted) return;
      acknowledgeMutation.mutate(operationId);
    },
    [accepted, acknowledgeMutation],
  );

  return {
    // Cached data stays hidden while the block is suppressed.
    history: accepted && timeTrackingEnabled ? historyQuery : { ...historyQuery, data: undefined },
    create: createMutation,
    submitCreate,
    delete: deleteMutation,
    submitDelete,
    verify: verifyMutation,
    verifyUnknown,
    acknowledge: acknowledgeMutation,
    acknowledgeUnknown,
    unknownOperationId,
    blockedByUnknown: unknownOperationId !== null,
  };
}
