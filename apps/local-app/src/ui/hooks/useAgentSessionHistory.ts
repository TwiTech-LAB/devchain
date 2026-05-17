import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useFetchFactory } from '@/ui/hooks/useFetchFactory';

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

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
  name: string | null;
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
  fetchFn: FetchFn,
): Promise<SessionHistoryResponse> {
  const params = new URLSearchParams({ projectId, limit: '20' });
  if (cursor) params.set('cursor', cursor);
  const res = await fetchFn(
    `/api/sessions/agents/${encodeURIComponent(agentId)}/history?${params}`,
  );
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(text || `HTTP ${res.status}`);
  }
  return res.json() as Promise<SessionHistoryResponse>;
}

const PAGE_SIZE = 20;

export function useAgentSessionHistory(agentId: string, projectId: string) {
  const [currentPageIndex, setCurrentPageIndex] = useState(0);
  const cursorStackRef = useRef<(string | undefined)[]>([undefined]);
  const apiFetch = useFetchFactory();

  useEffect(() => {
    cursorStackRef.current = [undefined];
    setCurrentPageIndex(0);
  }, [agentId, projectId]);

  const cursor = cursorStackRef.current[currentPageIndex] ?? undefined;

  const query = useQuery({
    queryKey: ['agentSessionHistory', agentId, projectId, currentPageIndex, cursor],
    queryFn: () => fetchPage(agentId, projectId, cursor, apiFetch),
    enabled: !!agentId && !!projectId,
  });

  const total = query.data?.total ?? 0;
  const totalPages = total === 0 ? 1 : Math.ceil(total / PAGE_SIZE);

  const goNext = useCallback(() => {
    if (!query.data?.hasMore) return;

    const nextCursor = query.data.nextCursor;
    const stack = cursorStackRef.current;
    const nextIndex = currentPageIndex + 1;

    if (nextIndex === stack.length && nextCursor != null) {
      stack.push(nextCursor);
    }

    setCurrentPageIndex(nextIndex);
  }, [currentPageIndex, query.data]);

  const goPrev = useCallback(() => {
    if (currentPageIndex > 0) {
      setCurrentPageIndex((i) => i - 1);
    }
  }, [currentPageIndex]);

  const resetToFirstPage = useCallback(() => {
    cursorStackRef.current = [undefined];
    setCurrentPageIndex(0);
  }, []);

  const refetch = useCallback(() => {
    return query.refetch();
  }, [query]);

  return {
    items: query.data?.items ?? [],
    total,
    currentPage: currentPageIndex + 1,
    totalPages,
    hasNext: !!query.data?.hasMore,
    hasPrev: currentPageIndex > 0,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isError: query.isError,
    goNext,
    goPrev,
    resetToFirstPage,
    refetch,
  };
}
