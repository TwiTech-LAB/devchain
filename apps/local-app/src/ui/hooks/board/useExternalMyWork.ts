import { useQuery } from '@tanstack/react-query';
import type { ExternalMyWorkResult } from '@/modules/external-integrations/models/external-provider.models';
import { useFetchFactory } from '@/ui/hooks/useFetchFactory';
import { connectionEpochKey, externalMyWorkQueryKeys } from '@/ui/lib/external-my-work';
import type { ExternalBoardProvider } from '@/ui/lib/external-board';
import type { IntegrationConnectionEpoch } from '@/ui/lib/integration-connections';
import { fetchJsonOrThrow, type FetchFn } from '@/ui/lib/sessions';

export interface UseExternalMyWorkOptions {
  includeCompleted: boolean;
  enabled: boolean;
  connectionEpoch: IntegrationConnectionEpoch | null;
}

/**
 * Single fetcher for the provider My Work snapshot. Every consumer (landing
 * grid and work-area boards) shares the landing cache entry built from this.
 */
export function fetchExternalMyWorkSnapshot(
  apiFetch: FetchFn,
  provider: ExternalBoardProvider,
  includeCompleted: boolean,
  signal?: AbortSignal,
): Promise<ExternalMyWorkResult> {
  return fetchJsonOrThrow<ExternalMyWorkResult>(
    `/api/integrations/my-work/${provider}?includeCompleted=${includeCompleted}`,
    { signal },
    'Assigned work could not be loaded.',
    '',
    apiFetch,
  );
}

export function useExternalMyWork(
  provider: ExternalBoardProvider,
  { includeCompleted, enabled, connectionEpoch }: UseExternalMyWorkOptions,
) {
  const apiFetch = useFetchFactory();

  return useQuery({
    queryKey: externalMyWorkQueryKeys.landingSnapshot(provider, connectionEpoch, includeCompleted),
    queryFn: ({ signal }) =>
      fetchExternalMyWorkSnapshot(apiFetch, provider, includeCompleted, signal),
    enabled: enabled && connectionEpoch !== null,
    // Completed-toggle transitions may retain their prior snapshot, but identity
    // transitions must never project one account's data into another account.
    placeholderData: (previousData, previousQuery) =>
      previousQuery?.queryKey[2] === connectionEpochKey(connectionEpoch) ? previousData : undefined,
  });
}
