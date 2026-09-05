import type { IntegrationConnectionEpoch } from '@/ui/lib/integration-connections';

const DISCONNECTED_EPOCH_KEY = 'disconnected';

/**
 * Key segment for a possibly-absent connection epoch. Disconnected providers
 * share one sentinel family that is never fetched (queries stay disabled while
 * the epoch is null), so a null epoch can never key into live data.
 */
export function connectionEpochKey(connectionEpoch: IntegrationConnectionEpoch | null): string {
  return connectionEpoch ?? DISCONNECTED_EPOCH_KEY;
}

export const externalMyWorkQueryKeys = {
  all: ['external-my-work'] as const,
  provider: (provider: string) => [...externalMyWorkQueryKeys.all, provider] as const,
  epoch: (provider: string, connectionEpoch: IntegrationConnectionEpoch | null) =>
    [...externalMyWorkQueryKeys.provider(provider), connectionEpochKey(connectionEpoch)] as const,
  landing: (provider: string, connectionEpoch: IntegrationConnectionEpoch | null) =>
    [...externalMyWorkQueryKeys.epoch(provider, connectionEpoch), 'landing'] as const,
  // Active-only and completed-inclusive snapshots must never share a cache
  // entry; the scope flag extends the landing key. Work-area boards derive
  // from this same snapshot via `select`, so there is no separate work-area
  // cache family to keep coherent.
  landingSnapshot: (
    provider: string,
    connectionEpoch: IntegrationConnectionEpoch | null,
    includeCompleted: boolean,
  ) =>
    [...externalMyWorkQueryKeys.landing(provider, connectionEpoch), { includeCompleted }] as const,
  // Task detail and task comments are siblings beneath the epoch prefix so
  // detail invalidation can never refetch comment history, while connection
  // replacement still removes both families through the provider prefix.
  taskDetail: (
    provider: string,
    connectionEpoch: IntegrationConnectionEpoch | null,
    taskId: string,
  ) =>
    [...externalMyWorkQueryKeys.epoch(provider, connectionEpoch), 'task-detail', taskId] as const,
  taskComments: (
    provider: string,
    connectionEpoch: IntegrationConnectionEpoch | null,
    taskId: string,
  ) =>
    [...externalMyWorkQueryKeys.epoch(provider, connectionEpoch), 'task-comments', taskId] as const,
  // Time-entry history is a third sibling: history refetches never touch
  // detail or comments, and detail invalidation never refetches history.
  taskTimeEntries: (
    provider: string,
    connectionEpoch: IntegrationConnectionEpoch | null,
    taskId: string,
  ) =>
    [
      ...externalMyWorkQueryKeys.epoch(provider, connectionEpoch),
      'task-time-entries',
      taskId,
    ] as const,
  taskEstimateLogState: (
    provider: string,
    connectionEpoch: IntegrationConnectionEpoch | null,
    projectId: string,
    taskId: string,
    remoteScopeKey: string,
    runtimeScope: 'main' | 'isolated',
  ) =>
    [
      ...externalMyWorkQueryKeys.epoch(provider, connectionEpoch),
      'task-estimate-log-state',
      projectId,
      taskId,
      remoteScopeKey,
      runtimeScope,
    ] as const,
  links: (provider: string, connectionEpoch: IntegrationConnectionEpoch | null) =>
    [...externalMyWorkQueryKeys.epoch(provider, connectionEpoch), 'links'] as const,
  // Pure and logged-minutes-enriched link batches must never share a cache
  // entry; the flag extends the links family so prefix invalidation still
  // reaches both variants.
  linksBatch: (
    provider: string,
    connectionEpoch: IntegrationConnectionEpoch | null,
    includeLoggedMinutes: boolean,
  ) =>
    [
      ...externalMyWorkQueryKeys.links(provider, connectionEpoch),
      { includeLoggedMinutes },
    ] as const,
};

export const epicExternalSourceQueryKeys = {
  all: ['epic-external-sources'] as const,
  detail: (epicId: string) => [...epicExternalSourceQueryKeys.all, epicId] as const,
  // Sorted Epic IDs make the key stable while status/search filters move cards
  // in and out of view: one Board context, one cache entry.
  batch: (sortedEpicIds: readonly string[]) =>
    [...epicExternalSourceQueryKeys.all, 'batch', sortedEpicIds] as const,
};
