import type { QueryClient } from '@tanstack/react-query';
import type { RealtimeInvalidationRegistry } from './realtime-invalidation-registry';
import type { BoardArchivedFilter } from '@/ui/pages/board/lib/board-api';

export const boardCacheKeys = {
  all: ['epics'] as const,
  project: (projectId: string) => ['epics', projectId] as const,
  list: (projectId: string | null | undefined, archivedFilter: BoardArchivedFilter) =>
    ['epics', projectId, archivedFilter] as const,
  children: (parentId: string | null | undefined) => ['epics', 'parent', parentId] as const,
  subCounts: (epicId: string) => ['epics', epicId, 'sub-counts'] as const,
};

type EpicEventPayload = {
  epic?: { parentId?: string | null } | null;
  parentId?: string | null;
  changes?: {
    parentId?: {
      previous?: string | null;
      current?: string | null;
    };
  };
};

function extractAffectedParentIds(payload: Record<string, unknown>): string[] {
  const typed = payload as unknown as EpicEventPayload;
  const parentIds = new Set<string>();
  const currentParentId = typed.epic?.parentId ?? typed.parentId ?? null;

  if (currentParentId) {
    parentIds.add(currentParentId);
  }

  const parentChange = typed.changes?.parentId;
  if (parentChange?.previous) {
    parentIds.add(parentChange.previous);
  }
  if (parentChange?.current) {
    parentIds.add(parentChange.current);
  }

  return [...parentIds];
}

function invalidateSubEpicCounts(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({
    predicate: (query) => query.queryKey[0] === 'epics' && query.queryKey[2] === 'sub-counts',
  });
}

export function createBoardInvalidationRegistry({
  projectId,
  parentFilter,
}: {
  projectId: string | null | undefined;
  parentFilter: string | undefined;
}): RealtimeInvalidationRegistry {
  if (!projectId) return [];

  const topic = `project/${projectId}/epics`;
  const entries: RealtimeInvalidationRegistry[number]['entries'] = [
    { kind: 'invalidate', queryKey: [...boardCacheKeys.project(projectId)] },
    {
      kind: 'custom-handler',
      handler: (payload, queryClient) => {
        const parentIds = extractAffectedParentIds(payload);
        for (const parentId of parentIds) {
          queryClient.invalidateQueries({ queryKey: boardCacheKeys.subCounts(parentId) });
        }
        if (parentFilter && (parentIds.length === 0 || parentIds.includes(parentFilter))) {
          queryClient.invalidateQueries({ queryKey: boardCacheKeys.children(parentFilter) });
        }
      },
    },
  ];

  return ['created', 'updated', 'deleted'].map((type) => ({
    match: (candidateTopic: string) => candidateTopic === topic,
    type,
    entries,
  }));
}

export function refreshBoardCache(
  queryClient: QueryClient,
  {
    projectId,
    parentFilter,
  }: {
    projectId: string | null | undefined;
    parentFilter: string | undefined;
  },
): void {
  if (!projectId) return;

  void queryClient.invalidateQueries({ queryKey: boardCacheKeys.project(projectId) });
  invalidateSubEpicCounts(queryClient);
  if (parentFilter) {
    void queryClient.invalidateQueries({ queryKey: boardCacheKeys.children(parentFilter) });
  }
}
