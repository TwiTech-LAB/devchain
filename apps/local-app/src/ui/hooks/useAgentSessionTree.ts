import { useEffect, useMemo, useRef } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useFetchFactory } from '@/ui/hooks/useFetchFactory';
import { agentSessionTreeKey, fetchSessionTree, type SessionTreeNode } from '@/ui/lib/sessions';

export interface SessionTreeBranch {
  node: SessionTreeNode;
  children: SessionTreeBranch[];
  /** The `save_point` children: the `Before rollback` record first, then newest first. */
  savePoints: SessionTreeNode[];
}

function savePointOrder(a: SessionTreeNode, b: SessionTreeNode): number {
  if (a.beforeRollback !== b.beforeRollback) return a.beforeRollback ? -1 : 1;
  return b.startedAt.localeCompare(a.startedAt);
}

function indexTree(nodes: SessionTreeNode[]) {
  const byId = new Map<string, SessionTreeBranch>();
  for (const node of nodes) byId.set(node.id, { node, children: [], savePoints: [] });

  const roots: SessionTreeBranch[] = [];
  for (const branch of byId.values()) {
    const parent = branch.node.parentSessionId ? byId.get(branch.node.parentSessionId) : undefined;
    if (parent) {
      parent.children.push(branch);
      if (branch.node.kind === 'save_point') parent.savePoints.push(branch.node);
    } else roots.push(branch);
  }
  for (const branch of byId.values()) branch.savePoints.sort(savePointOrder);
  return { roots, byId };
}

export function useAgentSessionTree(
  agentId: string | null,
  projectId: string | null,
  liveSessionId?: string,
  { refetchOnMount = true }: { refetchOnMount?: boolean } = {},
) {
  const apiFetch = useFetchFactory();
  const previousLive = useRef({ agentId, projectId, liveSessionId });
  const query = useInfiniteQuery({
    queryKey: agentSessionTreeKey(agentId, projectId),
    enabled: Boolean(agentId && projectId),
    refetchOnMount,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      fetchSessionTree(agentId!, projectId!, pageParam, apiFetch, signal),
    getNextPageParam: (page) => (page.hasMore ? (page.nextCursor ?? undefined) : undefined),
  });
  const pages = query.data?.pages;
  const { roots, byId } = useMemo(
    () => indexTree(pages?.flatMap((page) => page.items ?? []) ?? []),
    [pages],
  );
  const { fetchNextPage, hasNextPage, isFetching, isFetchNextPageError, refetch } = query;

  useEffect(() => {
    const previous = previousLive.current;
    const liveChanged =
      agentId &&
      projectId &&
      previous.agentId === agentId &&
      previous.projectId === projectId &&
      previous.liveSessionId !== liveSessionId;
    if (liveChanged && isFetching) return;
    previousLive.current = { agentId, projectId, liveSessionId };

    if (liveChanged) {
      // A live change can reorder the roots and invalidate every cached cursor.
      void refetch();
      return;
    }

    // The live session can descend from an old root that sorts after the first page.
    if (
      liveSessionId &&
      !byId.has(liveSessionId) &&
      hasNextPage &&
      !isFetching &&
      !isFetchNextPageError
    ) {
      // The bar and the Sessions table both run this effect. Join a running page request
      // instead of cancelling it and sending the same request again.
      void fetchNextPage({ cancelRefetch: false });
    }
  }, [
    agentId,
    byId,
    fetchNextPage,
    hasNextPage,
    isFetchNextPageError,
    isFetching,
    liveSessionId,
    projectId,
    refetch,
  ]);

  return {
    roots,
    byId,
    savePoints: pages?.[0]?.savePoints,
    isLoading: query.isLoading,
    isError: query.isError,
    isFetching,
    hasNextPage,
    fetchNextPage,
    refetch,
  };
}
