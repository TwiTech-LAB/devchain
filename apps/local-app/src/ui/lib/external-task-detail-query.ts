import type { QueryClient, UseQueryOptions } from '@tanstack/react-query';
import type { ExternalTaskDetail } from '@/modules/external-integrations/models/external-provider.models';
import type { ExternalBoardProvider } from '@/ui/lib/external-board';
import { externalMyWorkQueryKeys } from '@/ui/lib/external-my-work';
import type { IntegrationConnectionEpoch } from '@/ui/lib/integration-connections';
import {
  validIntegrationProjectId,
  withIntegrationProjectId,
} from '@/ui/lib/integration-project-scope';
import { fetchJsonOrThrow, type FetchFn } from '@/ui/lib/sessions';

/**
 * Canonical task-detail query options. Every task-detail read — the dialog
 * controller, board moves, and quick import — must go through this helper so
 * all writers share one cache entry under the connection epoch and no caller
 * drifts its own URL, key, or error text.
 */
export function externalTaskDetailQueryOptions(
  apiFetch: FetchFn,
  provider: ExternalBoardProvider,
  connectionEpoch: IntegrationConnectionEpoch | null,
  projectId: string | null,
  taskId: string,
  { enabled = true }: { enabled?: boolean } = {},
): UseQueryOptions<ExternalTaskDetail, Error, ExternalTaskDetail, readonly unknown[]> {
  return {
    queryKey: externalMyWorkQueryKeys.taskDetail(provider, connectionEpoch, taskId),
    queryFn: ({ signal }) =>
      fetchJsonOrThrow<ExternalTaskDetail>(
        withIntegrationProjectId(
          `/api/integrations/my-work/${provider}/tasks/${encodeURIComponent(taskId)}`,
          projectId,
        ),
        { signal },
        'Task detail could not be loaded.',
        '',
        apiFetch,
      ),
    enabled:
      enabled &&
      connectionEpoch !== null &&
      validIntegrationProjectId(projectId) !== null &&
      taskId !== '',
  };
}

/**
 * One fresh provider load, never a warm cache entry. Every action that must
 * decide against current remote state — a board move (consecutive Jira moves
 * must see current transitions) and quick import (the link decision) — reads
 * through this, so the freshness policy has a single home.
 */
export function fetchFreshExternalTaskDetail(
  queryClient: QueryClient,
  apiFetch: FetchFn,
  provider: ExternalBoardProvider,
  connectionEpoch: IntegrationConnectionEpoch | null,
  projectId: string,
  taskId: string,
): Promise<ExternalTaskDetail> {
  return queryClient.fetchQuery({
    ...externalTaskDetailQueryOptions(apiFetch, provider, connectionEpoch, projectId, taskId),
    staleTime: 0,
  });
}
