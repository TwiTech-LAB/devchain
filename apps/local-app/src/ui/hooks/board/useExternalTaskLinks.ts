import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type {
  ExternalTaskLinkLookupInput,
  ExternalTaskLinkStateSummary,
} from '@/modules/external-integrations/models/external-provider.models';
import { useFetchFactory } from '@/ui/hooks/useFetchFactory';
import type { ExternalBoardProvider } from '@/ui/lib/external-board';
import { externalMyWorkQueryKeys } from '@/ui/lib/external-my-work';
import type { IntegrationConnectionEpoch } from '@/ui/lib/integration-connections';

export function useExternalTaskLinks(
  provider: ExternalBoardProvider,
  inputs: ExternalTaskLinkLookupInput[],
  {
    enabled = true,
    connectionEpoch,
  }: { enabled?: boolean; connectionEpoch: IntegrationConnectionEpoch | null },
) {
  const apiFetch = useFetchFactory();
  const normalized = [...inputs].sort(
    (left, right) =>
      left.scopeKey.localeCompare(right.scopeKey) || left.taskId.localeCompare(right.taskId),
  );
  const query = useQuery({
    queryKey: [...externalMyWorkQueryKeys.links(provider, connectionEpoch), normalized],
    queryFn: async ({ signal }): Promise<{ items: ExternalTaskLinkStateSummary[] }> => {
      const response = await apiFetch(`/api/integrations/my-work/${provider}/links/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: normalized }),
        signal,
      });
      if (!response.ok) throw new Error('DevChain link state could not be loaded.');
      return response.json();
    },
    enabled: enabled && connectionEpoch !== null && normalized.length > 0,
    // Completed moves shrink the input set; keeping the previous page as
    // placeholder data stops remaining link badges from blinking off and on.
    placeholderData: keepPreviousData,
  });

  return {
    ...query,
    data: enabled ? query.data : undefined,
  };
}
