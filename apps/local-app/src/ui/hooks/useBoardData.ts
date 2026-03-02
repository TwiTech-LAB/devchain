import { useCallback, useMemo } from 'react';
import { useQuery, useQueries } from '@tanstack/react-query';
import type { BoardFilterParams } from '@/ui/lib/url-filters';
import {
  fetchStatuses,
  fetchEpics,
  fetchSubEpics,
  fetchSubEpicCounts,
  fetchAgents,
} from '@/ui/pages/board/lib/board-api';
import type { Agent, Epic, Status } from '@/ui/types';

export interface UseBoardDataArgs {
  selectedProjectId: string | null | undefined;
  filters: BoardFilterParams;
}

export interface UseBoardDataResult {
  archivedFilter: 'active' | 'archived' | 'all';
  epicsKey: readonly ['epics', string | null | undefined, 'active' | 'archived' | 'all'];
  statusesData: { items?: Status[] } | undefined;
  statusesLoading: boolean;
  epicsData: { items?: Epic[] } | undefined;
  agentsData: { items?: Agent[] } | undefined;
  subEpicsData: { items?: Epic[] } | undefined;
  subEpicsLoading: boolean;
  sortedStatuses: Status[];
  visibleStatuses: Status[];
  agentMap: Map<string, Agent>;
  getAgentName: (agentId: string | null) => string | null;
  activeParent: Epic | null;
  parentCandidates: Epic[];
  getEpicsByStatus: (statusId: string) => Epic[];
  subEpicStatusCountsByEpicId: Record<string, Record<string, number>>;
  subEpicCountsMap: Record<string, number>;
}

export function useBoardData({ selectedProjectId, filters }: UseBoardDataArgs): UseBoardDataResult {
  // Query key only includes server-relevant params (projectId, archived type)
  // UI-only params (view, page, pageSize, status) are excluded to prevent unnecessary refetches
  const archivedFilter = filters.archived ?? 'active';
  const epicsKey = useMemo(
    () => ['epics', selectedProjectId, archivedFilter] as const,
    [selectedProjectId, archivedFilter],
  );

  const { data: statusesData, isLoading: statusesLoading } = useQuery({
    queryKey: ['statuses', selectedProjectId],
    queryFn: () => fetchStatuses(selectedProjectId as string),
    enabled: !!selectedProjectId,
  });

  const { data: epicsData } = useQuery({
    // Align cache with URL filters using canonical serialization
    queryKey: epicsKey,
    queryFn: () => fetchEpics(selectedProjectId as string, archivedFilter),
    enabled: !!selectedProjectId,
  });

  const { data: agentsData } = useQuery({
    queryKey: ['agents', selectedProjectId],
    queryFn: () => fetchAgents(selectedProjectId as string),
    enabled: !!selectedProjectId,
  });

  const { data: subEpicsData, isLoading: subEpicsLoading } = useQuery({
    // Query key only includes parentId - UI params excluded to prevent unnecessary refetches
    queryKey: ['epics', 'parent', filters.parent ?? null],
    queryFn: () => fetchSubEpics((filters.parent as string) ?? ''),
    enabled: !!filters.parent,
  });

  const sortedStatuses = useMemo(() => {
    return (statusesData?.items || []).sort((a: Status, b: Status) => a.position - b.position);
  }, [statusesData]);

  // Client-side status filtering: filter statuses based on URL filter (for Kanban columns)
  // When filters.status is set, only show those statuses; otherwise show all
  const visibleStatuses = useMemo(() => {
    if (!filters.status || filters.status.length === 0) {
      return sortedStatuses;
    }
    // Create a Set for O(1) lookup - filters.status contains status IDs
    const selectedStatusIds = new Set(filters.status);
    return sortedStatuses.filter((s: Status) => selectedStatusIds.has(s.id));
  }, [sortedStatuses, filters.status]);

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const agent of agentsData?.items || []) {
      map.set(agent.id, agent);
    }
    return map;
  }, [agentsData]);

  const getAgentName = useCallback(
    (agentId: string | null) => {
      if (!agentId) {
        return null;
      }
      return agentMap.get(agentId)?.name ?? null;
    },
    [agentMap],
  );

  const activeParent = useMemo(() => {
    if (!filters.parent) {
      return null;
    }
    return epicsData?.items.find((epic: Epic) => epic.id === filters.parent) ?? null;
  }, [epicsData, filters.parent]);

  const parentCandidates = useMemo(() => {
    const items = (epicsData?.items ?? []) as Epic[];
    return items.filter((epic: Epic) => !epic.parentId);
  }, [epicsData]);

  const getEpicsByStatus = useCallback(
    (statusId: string) => {
      if (filters.parent) {
        return ((subEpicsData?.items ?? []) as Epic[]).filter(
          (epic: Epic) => epic.statusId === statusId,
        );
      }
      return ((epicsData?.items ?? []) as Epic[]).filter(
        (epic: Epic) => epic.statusId === statusId && (!epic.parentId || epic.parentId === null),
      );
    },
    [filters.parent, epicsData, subEpicsData],
  );

  const topLevelEpics = useMemo(
    () => ((epicsData?.items ?? []) as Epic[]).filter((epic: Epic) => !epic.parentId),
    [epicsData],
  );

  const subEpicCountQueries = useQueries({
    queries: topLevelEpics.map((epic) => ({
      queryKey: ['epics', epic.id, 'sub-counts'],
      queryFn: () => fetchSubEpicCounts(epic.id),
      enabled: !!selectedProjectId && !filters.parent,
      staleTime: 30000,
    })),
  });

  const subEpicStatusCountsByEpicId = useMemo(() => {
    const map: Record<string, Record<string, number>> = {};
    topLevelEpics.forEach((epic, index) => {
      map[epic.id] = (subEpicCountQueries[index]?.data as Record<string, number> | undefined) ?? {};
    });
    return map;
  }, [topLevelEpics, subEpicCountQueries]);

  // Build a map of sub-epic counts (children of each epic) from the currently loaded epics
  const subEpicCountsMap = useMemo(() => {
    const map: Record<string, number> = {};
    const items = (epicsData?.items as Epic[] | undefined) ?? [];
    items.forEach((epic) => {
      if (epic.parentId) {
        map[epic.parentId] = (map[epic.parentId] ?? 0) + 1;
      }
    });
    return map;
  }, [epicsData]);

  return {
    archivedFilter,
    epicsKey,
    statusesData,
    statusesLoading,
    epicsData,
    agentsData,
    subEpicsData,
    subEpicsLoading,
    sortedStatuses,
    visibleStatuses,
    agentMap,
    getAgentName,
    activeParent,
    parentCandidates,
    getEpicsByStatus,
    subEpicStatusCountsByEpicId,
    subEpicCountsMap,
  };
}
