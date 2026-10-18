import { useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PROVIDER_USAGE_SETTINGS_DEFAULTS, type ProviderUsageResponse } from '@devchain/shared';
import { useFetchFactory } from '@/ui/hooks/useFetchFactory';
import { useRealtimeDispatch } from '@/ui/hooks/useRealtimeDispatch';
import {
  exactTopic,
  type RealtimeInvalidationRegistry,
} from '@/ui/lib/realtime-invalidation-registry';

export const providerUsageQueryKey = (projectId: string) => ['provider-usage', projectId];

const PROVIDER_USAGE_REALTIME: RealtimeInvalidationRegistry = [
  {
    match: exactTopic('provider-usage'),
    type: 'updated',
    entries: [{ kind: 'invalidate', queryKey: ['provider-usage'] }],
  },
];

type FetchFn = ReturnType<typeof useFetchFactory>;

/** Null for a non-OK answer or another body: an older or unreachable backend shows no rings. */
async function fetchProviderUsage(
  apiFetch: FetchFn,
  projectId: string,
  maxAgeSec: number,
): Promise<ProviderUsageResponse | null> {
  const params = new URLSearchParams({ projectId, maxAgeSec: String(maxAgeSec) });
  const response = await apiFetch(`/api/provider-usage?${params.toString()}`);
  if (!response.ok) return null;
  const body = (await response.json()) as Partial<ProviderUsageResponse> | null;
  return Array.isArray(body?.accounts) && body?.config ? (body as ProviderUsageResponse) : null;
}

function openProjectMaxAgeMin(data: ProviderUsageResponse | null | undefined): number {
  return data?.config.openProjectMaxAgeMin ?? PROVIDER_USAGE_SETTINGS_DEFAULTS.openProjectMaxAgeMin;
}

/**
 * Usage of the project's accounts, read from the backend that owns the project. Each
 * read asks the server to check accounts older than `openProjectMaxAgeMin`; the server
 * announces new data with `provider-usage.updated` on the project's socket.
 */
export function useProviderUsage(projectId: string | null) {
  const apiFetch = useFetchFactory();
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => providerUsageQueryKey(projectId ?? ''), [projectId]);

  const query = useQuery({
    queryKey,
    enabled: projectId !== null,
    queryFn: () => {
      const cached = queryClient.getQueryData<ProviderUsageResponse | null>(queryKey);
      return fetchProviderUsage(apiFetch, projectId ?? '', openProjectMaxAgeMin(cached) * 60);
    },
    refetchInterval: (current) => openProjectMaxAgeMin(current.state.data) * 60_000,
  });

  useRealtimeDispatch(PROVIDER_USAGE_REALTIME);

  const hoverMaxAgeSec = query.data?.config.hoverMaxAgeSec;
  /** Starts a check of accounts older than `hoverMaxAgeSec`; the server never checks a token account here. */
  const refreshForHover = useCallback(async () => {
    if (projectId === null || hoverMaxAgeSec === undefined) return;
    const data = await fetchProviderUsage(apiFetch, projectId, hoverMaxAgeSec);
    if (data) queryClient.setQueryData(queryKey, data);
  }, [apiFetch, hoverMaxAgeSec, projectId, queryClient, queryKey]);

  return { data: query.data ?? null, refreshForHover };
}
