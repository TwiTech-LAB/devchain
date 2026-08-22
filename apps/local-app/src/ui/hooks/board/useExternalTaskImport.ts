import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ExternalTaskImportResponse,
  ExternalTaskDetail,
  ExternalTaskLinkStateSummary,
} from '@/modules/external-integrations/models/external-provider.models';
import { useFetchFactory } from '@/ui/hooks/useFetchFactory';
import type { ExternalBoardProvider } from '@/ui/lib/external-board';
import { safeExternalTaskUrl } from '@/ui/lib/external-board';
import { externalMyWorkQueryKeys, epicExternalSourceQueryKeys } from '@/ui/lib/external-my-work';
import type { IntegrationConnectionEpoch } from '@/ui/lib/integration-connections';
import { fetchJsonOrThrow } from '@/ui/lib/sessions';
import { fetchStatuses } from '@/ui/pages/board/lib/board-api';

export interface ExternalImportProject {
  id: string;
  name: string;
}

export interface ExternalImportStatus {
  id: string;
  projectId: string;
  label: string;
  color: string;
  position: number;
}

export interface ExternalTaskImportForm {
  projectId: string;
  statusId: string;
  title: string;
  description: string;
}

export function useExternalTaskImport(
  provider: ExternalBoardProvider,
  detail: ExternalTaskDetail | null,
  projectId: string,
  {
    enabled = true,
    connectionEpoch,
  }: { enabled?: boolean; connectionEpoch: IntegrationConnectionEpoch | null },
) {
  const apiFetch = useFetchFactory();
  const queryClient = useQueryClient();
  const projects = useQuery({
    queryKey: ['projects', 'all'],
    queryFn: async (): Promise<{ items: ExternalImportProject[] }> => {
      const response = await apiFetch('/api/projects?limit=10000');
      if (!response.ok) throw new Error('DevChain projects could not be loaded.');
      return response.json();
    },
    enabled,
  });
  const statuses = useQuery({
    queryKey: ['statuses', projectId],
    queryFn: (): Promise<{ items: ExternalImportStatus[] }> => fetchStatuses(projectId, apiFetch),
    enabled: enabled && projectId !== '',
  });

  const mutation = useMutation({
    mutationFn: async (form: ExternalTaskImportForm): Promise<ExternalTaskImportResponse> => {
      if (!enabled || !connectionEpoch || !detail) {
        throw new Error('External task import is unavailable.');
      }
      const webUrl = safeExternalTaskUrl(provider, detail.webUrl);
      if (!webUrl) throw new Error('The remote task source URL is unavailable.');
      return fetchJsonOrThrow<ExternalTaskImportResponse>(
        '/api/epics/import-external-task',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectId: form.projectId,
            statusId: form.statusId,
            agentId: null,
            title: form.title.trim(),
            description: form.description.trim() || null,
            remote: {
              provider,
              scopeKey: detail.location.scopeKey,
              taskId: detail.remoteId,
              remoteKey: detail.remoteKey,
              title: detail.title,
              description: detail.description,
              webUrl,
              workAreaId: detail.location.workAreaId,
              workAreaName: detail.location.workAreaName,
              statusName: detail.status.name,
            },
          }),
        },
        'Task import failed.',
        '',
        apiFetch,
      );
    },
    onSuccess: async (result) => {
      const link: ExternalTaskLinkStateSummary = {
        scopeKey: detail?.location.scopeKey ?? '',
        taskId: detail?.remoteId ?? '',
        linked: true,
        epicId: result.epic.id,
        projectId: result.epic.projectId,
        projectName:
          projects.data?.items.find((project) => project.id === result.epic.projectId)?.name ??
          null,
      };
      queryClient.setQueriesData<{ items: ExternalTaskLinkStateSummary[] }>(
        { queryKey: externalMyWorkQueryKeys.links(provider, connectionEpoch) },
        (current) =>
          current
            ? {
                items: current.items.map((item) =>
                  item.scopeKey === link.scopeKey && item.taskId === link.taskId ? link : item,
                ),
              }
            : current,
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['epics'] }),
        // A new import gives its Epic a stored source; every Board batch
        // entry (and the Epic detail read) must re-resolve.
        queryClient.invalidateQueries({ queryKey: epicExternalSourceQueryKeys.all }),
        queryClient.invalidateQueries({
          queryKey: externalMyWorkQueryKeys.taskDetail(
            provider,
            connectionEpoch,
            detail?.remoteId ?? '',
          ),
        }),
        queryClient.invalidateQueries({
          queryKey: externalMyWorkQueryKeys.links(provider, connectionEpoch),
        }),
      ]);
    },
  });

  return {
    projects: enabled ? projects : { ...projects, data: undefined },
    statuses: enabled ? statuses : { ...statuses, data: undefined },
    mutation,
  };
}
