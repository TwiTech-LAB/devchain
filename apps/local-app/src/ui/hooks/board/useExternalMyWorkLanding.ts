import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import type {
  ExternalMyWorkResult,
  ExternalTaskLinkLookupInput,
  ExternalWorkArea,
} from '@/modules/external-integrations/models/external-provider.models';
import { useIntegrationConnections } from '@/ui/hooks/useIntegrationConnections';
import { useSelectedProject } from '@/ui/hooks/useProjectSelection';
import { useExternalMyWork } from '@/ui/hooks/board/useExternalMyWork';
import { useExternalTaskLinks } from '@/ui/hooks/board/useExternalTaskLinks';
import { externalMyWorkQueryKeys } from '@/ui/lib/external-my-work';
import {
  EXTERNAL_COMPLETED_QUERY_PARAM,
  externalProviderSourceUrl,
  readExternalCompletedParam,
  type ExternalBoardProvider,
} from '@/ui/lib/external-board';
import { getIntegrationConnectionEpoch } from '@/ui/lib/integration-connections';
import { projectWorkAreaTaskHierarchy } from '@/ui/lib/external-work-area';

export type ExternalWorkAreaCardModel = {
  key: string;
  remoteId: string;
  scopeKey: string;
  name: string;
  kindLabel: string;
  description: string | null;
  assignedTaskCount: number;
  /**
   * Linked count over the exact same visibleTasks set as assignedTaskCount.
   * Null while the link read is loading, placeholder, or failed — never a
   * fabricated zero.
   */
  linkedTaskCount: number | null;
  locationLabel: string;
  workflowSummary: string;
  refreshState: ExternalWorkArea['refresh']['state'];
};

export type ExternalMyWorkLandingStatus =
  | 'disconnected'
  | 'unavailable'
  | 'connections-loading'
  | 'loading'
  | 'unsupported'
  | 'error'
  | 'empty'
  | 'ready';

export interface ExternalMyWorkLanding {
  status: ExternalMyWorkLandingStatus;
  sourceUrl: string | null;
  cards: ExternalWorkAreaCardModel[];
  visibleCardCount: number;
  search: string;
  setSearch: (value: string) => void;
  includeCompleted: boolean;
  toggleIncludeCompleted: () => void;
  isRefreshing: boolean;
  isStale: boolean;
  error: Error | null;
  refreshedAt: string | null;
  refresh: () => void;
}

type SupportedSnapshot = Extract<ExternalMyWorkResult, { supported: true }>;

const KIND_LABELS: Record<ExternalWorkArea['kind'], string> = {
  list: 'List',
  board: 'Board',
  project: 'Project',
};

function locationLabel(workArea: ExternalWorkArea): string {
  return workArea.hierarchy.map((location) => location.name).join(' / ');
}

function workflowSummary(workArea: ExternalWorkArea): string {
  const names = workArea.workflow.columns.map((column) => column.name);
  if (names.length === 0) return 'Workflow unavailable';
  const shown = names.slice(0, 5).join(' → ');
  return names.length > 5 ? `${shown} → +${names.length - 5} more` : shown;
}

function toCardModel(
  workArea: ExternalWorkArea,
  assignedTaskCount: number,
  linkedTaskCount: number | null,
): ExternalWorkAreaCardModel {
  return {
    key: `${workArea.scopeKey}:${workArea.remoteId}`,
    remoteId: workArea.remoteId,
    scopeKey: workArea.scopeKey,
    name: workArea.name,
    kindLabel: KIND_LABELS[workArea.kind],
    description: workArea.description,
    assignedTaskCount,
    linkedTaskCount,
    locationLabel: locationLabel(workArea),
    workflowSummary: workflowSummary(workArea),
    refreshState: workArea.refresh.state,
  };
}

// Must stay the compound identity the links batch deduplicates on: scope key
// and task ID together, never task ID alone.
function linkIdentityKey(scopeKey: string, taskId: string): string {
  return `${scopeKey}\u0000${taskId}`;
}

function isSupportedSnapshot(result: unknown): result is SupportedSnapshot {
  return (
    !!result && typeof result === 'object' && (result as { supported?: unknown }).supported === true
  );
}

// The includeCompleted toggle switches the query key; TanStack does not carry
// placeholder data into an errored key, so the most recent successful snapshot
// for the provider prefix becomes the stale fallback.
function latestCachedSnapshot(
  queryClient: ReturnType<typeof useQueryClient>,
  provider: ExternalBoardProvider,
  connectionEpoch: string,
): SupportedSnapshot | null {
  let best: { updatedAt: number; snapshot: SupportedSnapshot } | null = null;
  for (const query of queryClient.getQueryCache().findAll({
    queryKey: externalMyWorkQueryKeys.landing(provider, connectionEpoch),
  })) {
    if (!isSupportedSnapshot(query.state.data)) continue;
    if (!best || query.state.dataUpdatedAt > best.updatedAt) {
      best = { updatedAt: query.state.dataUpdatedAt, snapshot: query.state.data };
    }
  }
  return best?.snapshot ?? null;
}

export function useExternalMyWorkLanding(
  provider: ExternalBoardProvider,
  { enabled = true }: { enabled?: boolean } = {},
): ExternalMyWorkLanding {
  const queryClient = useQueryClient();
  const { selectedProjectId: selectedProjectIdValue } = useSelectedProject();
  const selectedProjectId = selectedProjectIdValue ?? null;
  const [searchParams, setSearchParams] = useSearchParams();
  const { connections, isLoading: connectionsLoading } = useIntegrationConnections({
    projectId: selectedProjectId,
    enabled,
  });
  const [search, setSearch] = useState('');
  // Completed scope is URL-addressable so refresh, direct navigation, and browser Back
  // all restore the same data scope the user selected.
  const includeCompleted = readExternalCompletedParam(searchParams);
  const toggleIncludeCompleted = () => {
    const next = new URLSearchParams(searchParams);
    if (includeCompleted) {
      next.delete(EXTERNAL_COMPLETED_QUERY_PARAM);
    } else {
      next.set(EXTERNAL_COMPLETED_QUERY_PARAM, '1');
    }
    setSearchParams(next, { replace: true });
  };

  const connection = connections.find((candidate) => candidate.provider === provider);
  const connectionEpoch = getIntegrationConnectionEpoch(connection);
  const connected = connectionEpoch !== null;

  const query = useExternalMyWork(provider, {
    includeCompleted,
    enabled: enabled && connected,
    connectionEpoch,
    projectId: selectedProjectId,
  });

  const effectiveSnapshot = useMemo<SupportedSnapshot | null>(() => {
    if (!enabled) return null;
    if (isSupportedSnapshot(query.data)) return query.data;
    if (query.isError && connectionEpoch) {
      return latestCachedSnapshot(queryClient, provider, connectionEpoch);
    }
    return null;
  }, [connectionEpoch, enabled, provider, query.data, query.isError, queryClient]);

  const workAreaProjections = useMemo(
    () =>
      effectiveSnapshot
        ? effectiveSnapshot.workAreas.map((workArea) => ({
            workArea,
            visibleTasks: projectWorkAreaTaskHierarchy(effectiveSnapshot.tasks, workArea)
              .visibleTasks,
          }))
        : [],
    [effectiveSnapshot],
  );

  // Link identities derive from the same visibleTasks projection as the
  // assigned counts, so grouped subtasks never reach the link read.
  const linkIdentities = useMemo<ExternalTaskLinkLookupInput[]>(
    () =>
      workAreaProjections.flatMap(({ workArea, visibleTasks }) =>
        visibleTasks.map((visibleTask) => ({
          scopeKey: workArea.scopeKey,
          taskId: visibleTask.remoteId,
        })),
      ),
    [workAreaProjections],
  );

  const linksQuery = useExternalTaskLinks(provider, linkIdentities, {
    enabled,
    connectionEpoch,
    // Coverage only: checkpoint minutes are the Kanban-side read.
    includeLoggedMinutes: false,
    projectId: selectedProjectId,
  });

  // Placeholder data belongs to a previous input set and an error carries no
  // data, so only a fresh result may produce a numeric linked count.
  const linkedCountResolved =
    linksQuery.data !== undefined && !linksQuery.isPlaceholderData && !linksQuery.isError;

  const linkedIdentities = useMemo(() => {
    const linked = new Set<string>();
    if (!linkedCountResolved) return linked;
    for (const item of linksQuery.data?.items ?? []) {
      if (item?.linked) {
        linked.add(linkIdentityKey(item.scopeKey, item.taskId));
      }
    }
    return linked;
  }, [linkedCountResolved, linksQuery.data]);

  const cards = useMemo(
    () =>
      workAreaProjections.map(({ workArea, visibleTasks }) =>
        toCardModel(
          workArea,
          visibleTasks.length,
          linkedCountResolved
            ? visibleTasks.filter((visibleTask) =>
                linkedIdentities.has(linkIdentityKey(workArea.scopeKey, visibleTask.remoteId)),
              ).length
            : null,
        ),
      ),
    [linkedCountResolved, linkedIdentities, workAreaProjections],
  );

  const normalizedSearch = search.trim().toLowerCase();
  const filteredCards = useMemo(() => {
    if (!normalizedSearch) return cards;
    return cards.filter((card) =>
      [card.name, card.locationLabel, card.description ?? '']
        .join(' ')
        .toLowerCase()
        .includes(normalizedSearch),
    );
  }, [cards, normalizedSearch]);

  const status: ExternalMyWorkLandingStatus = !enabled
    ? 'unavailable'
    : connectionsLoading
      ? 'connections-loading'
      : !connected
        ? 'disconnected'
        : query.data?.supported === false
          ? 'unsupported'
          : query.isError && effectiveSnapshot === null
            ? 'error'
            : effectiveSnapshot === null
              ? 'loading'
              : effectiveSnapshot.workAreas.length === 0
                ? 'empty'
                : 'ready';

  const sourceUrl =
    enabled && connected
      ? externalProviderSourceUrl(provider, effectiveSnapshot?.workAreas[0]?.scopeKey)
      : null;

  return {
    status,
    sourceUrl,
    cards: filteredCards,
    visibleCardCount: cards.length,
    search,
    setSearch,
    includeCompleted,
    toggleIncludeCompleted,
    isRefreshing: enabled && query.isFetching,
    isStale: enabled && query.isError && effectiveSnapshot !== null,
    error: enabled ? query.error : null,
    refreshedAt: effectiveSnapshot ? effectiveSnapshot.refreshedAt : null,
    refresh: () => {
      if (!enabled) return;
      void query.refetch();
    },
  };
}
