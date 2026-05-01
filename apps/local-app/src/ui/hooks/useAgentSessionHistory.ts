import { useInfiniteQuery } from '@tanstack/react-query';

export interface SessionHistoryItem {
  id: string;
  providerSessionId: string | null;
  providerNameAtLaunch: string | null;
  status: 'stopped' | 'failed';
  startedAt: string;
  endedAt: string | null;
  lastActivityAt: string | null;
  sizeBytes: number | null;
  transcriptAvailable: boolean;
}

interface SessionHistoryResponse {
  items: SessionHistoryItem[];
  nextCursor: string | null;
  hasMore: boolean;
  total: number;
}

async function fetchPage(
  agentId: string,
  projectId: string,
  cursor: string | undefined,
): Promise<SessionHistoryResponse> {
  const params = new URLSearchParams({ projectId, limit: '20' });
  if (cursor) params.set('cursor', cursor);
  const res = await fetch(`/api/sessions/agents/${encodeURIComponent(agentId)}/history?${params}`);
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(text || `HTTP ${res.status}`);
  }
  return res.json() as Promise<SessionHistoryResponse>;
}

export function useAgentSessionHistory(agentId: string, projectId: string) {
  const query = useInfiniteQuery({
    queryKey: ['agentSessionHistory', agentId, projectId],
    queryFn: ({ pageParam }) => fetchPage(agentId, projectId, pageParam as string | undefined),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: !!agentId && !!projectId,
  });

  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  const total = query.data?.pages[0]?.total ?? 0;

  return {
    items,
    total,
    hasMore: !!query.hasNextPage,
    isLoading: query.isLoading,
    isFetchingMore: query.isFetchingNextPage,
    isError: query.isError,
    loadMore: query.fetchNextPage,
    refetch: query.refetch,
  };
}
