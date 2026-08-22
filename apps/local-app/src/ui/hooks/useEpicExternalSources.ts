import { useQuery } from '@tanstack/react-query';
import type { ExternalTaskSourceSummary } from '@/modules/external-integrations/models/external-provider.models';
import { useFetchFactory } from '@/ui/hooks/useFetchFactory';
import { epicExternalSourceQueryKeys } from '@/ui/lib/external-my-work';

export function useEpicExternalSources(
  epicId: string | undefined,
  { enabled = true }: { enabled?: boolean } = {},
) {
  const apiFetch = useFetchFactory();
  const query = useQuery({
    queryKey: epicExternalSourceQueryKeys.detail(epicId ?? ''),
    queryFn: async ({ signal }): Promise<{ items: ExternalTaskSourceSummary[] }> => {
      const response = await apiFetch(
        `/api/epics/${encodeURIComponent(epicId!)}/external-sources`,
        {
          signal,
        },
      );
      if (!response.ok) throw new Error('External task source could not be loaded.');
      return response.json();
    },
    enabled: enabled && Boolean(epicId),
  });
  return { ...query, data: enabled ? query.data : undefined };
}
