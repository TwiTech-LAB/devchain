import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import type {
  ExternalMyWorkResult,
  ExternalWorkArea,
} from '@/modules/external-integrations/models/external-provider.models';
import { useIntegrationConnections } from '@/ui/hooks/useIntegrationConnections';
import { useExternalMyWork } from '@/ui/hooks/board/useExternalMyWork';
import { externalMyWorkQueryKeys } from '@/ui/lib/external-my-work';
import {
  EXTERNAL_COMPLETED_QUERY_PARAM,
  readExternalCompletedParam,
  type ExternalBoardProvider,
} from '@/ui/lib/external-board';
import { getIntegrationConnectionEpoch } from '@/ui/lib/integration-connections';

export type ExternalWorkAreaCardModel = {
  key: string;
  remoteId: string;
  scopeKey: string;
  name: string;
  kindLabel: string;
  description: string | null;
  assignedTaskCount: number;
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

function toCardModel(workArea: ExternalWorkArea): ExternalWorkAreaCardModel {
  return {
    key: `${workArea.scopeKey}:${workArea.remoteId}`,
    remoteId: workArea.remoteId,
    scopeKey: workArea.scopeKey,
    name: workArea.name,
    kindLabel: KIND_LABELS[workArea.kind],
    description: workArea.description,
    assignedTaskCount: workArea.assignedTaskCount,
    locationLabel: locationLabel(workArea),
    workflowSummary: workflowSummary(workArea),
    refreshState: workArea.refresh.state,
  };
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
  const [searchParams, setSearchParams] = useSearchParams();
  const { connections, isLoading: connectionsLoading } = useIntegrationConnections({ enabled });
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
  });

  const effectiveSnapshot = useMemo<SupportedSnapshot | null>(() => {
    if (!enabled) return null;
    if (isSupportedSnapshot(query.data)) return query.data;
    if (query.isError && connectionEpoch) {
      return latestCachedSnapshot(queryClient, provider, connectionEpoch);
    }
    return null;
  }, [connectionEpoch, enabled, provider, query.data, query.isError, queryClient]);

  const cards = useMemo(
    () => (effectiveSnapshot ? effectiveSnapshot.workAreas.map(toCardModel) : []),
    [effectiveSnapshot],
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

  return {
    status,
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
