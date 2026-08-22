import { useQuery } from '@tanstack/react-query';
import { fetchExternalMyWorkSnapshot } from '@/ui/hooks/board/useExternalMyWork';
import { useFetchFactory } from '@/ui/hooks/useFetchFactory';
import type { ExternalBoardProvider } from '@/ui/lib/external-board';
import { externalMyWorkQueryKeys } from '@/ui/lib/external-my-work';
import { buildExternalWorkAreaBoard } from '@/ui/lib/external-work-area';
import type { IntegrationConnectionEpoch } from '@/ui/lib/integration-connections';

export interface UseExternalWorkAreaOptions {
  enabled?: boolean;
  connectionEpoch: IntegrationConnectionEpoch | null;
  includeCompleted: boolean;
}

/**
 * Derives one work-area board from the landing snapshot cache entry. Landing
 * and board views share a single fetch and a single invalidation target;
 * `select` memoizes the per-board projection.
 */
export function useExternalWorkArea(
  provider: ExternalBoardProvider,
  workAreaId: string,
  { enabled = true, connectionEpoch, includeCompleted }: UseExternalWorkAreaOptions,
) {
  const apiFetch = useFetchFactory();

  return useQuery({
    queryKey: externalMyWorkQueryKeys.landingSnapshot(provider, connectionEpoch, includeCompleted),
    queryFn: ({ signal }) =>
      fetchExternalMyWorkSnapshot(apiFetch, provider, includeCompleted, signal),
    enabled: enabled && connectionEpoch !== null,
    select: (snapshot) => {
      if (!snapshot.supported) {
        throw new Error(`${snapshot.descriptor.displayName} does not support My Work.`);
      }
      return buildExternalWorkAreaBoard(provider, snapshot, workAreaId);
    },
  });
}
