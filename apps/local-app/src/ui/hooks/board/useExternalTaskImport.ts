import { useCallback, useRef } from 'react';
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
import {
  isSameIntegrationPresentationScope,
  validIntegrationProjectId,
  type IntegrationPresentationScope,
} from '@/ui/lib/integration-project-scope';
import { fetchJsonOrThrow, type FetchFn } from '@/ui/lib/sessions';
import { fetchStatuses } from '@/ui/pages/board/lib/board-api';
import { boardCacheKeys } from '@/ui/lib/board-cache';

export interface ExternalImportStatus {
  id: string;
  projectId: string;
  label: string;
  color: string;
  position: number;
}

export interface ExternalTaskImportForm {
  statusId: string;
  title: string;
  description: string;
}

export interface ExternalTaskImportMutationVariables {
  scope: IntegrationPresentationScope;
  detail: ExternalTaskDetail;
  form: ExternalTaskImportForm;
  projectAttribution: {
    id: string;
    name: string | null;
  };
  cacheKeys: {
    epics: ReturnType<typeof boardCacheKeys.project>;
    links: ReturnType<typeof externalMyWorkQueryKeys.links>;
    taskDetail: ReturnType<typeof externalMyWorkQueryKeys.taskDetail>;
    epicSources: typeof epicExternalSourceQueryKeys.all;
  };
  apiFetch: FetchFn;
}

interface ExternalTaskImportCallbacks {
  onSuccess?: (result: ExternalTaskImportResponse) => void;
  onError?: (error: Error) => void;
  onSettled?: (result: ExternalTaskImportResponse | undefined, error: Error | null) => void;
}

export function useExternalTaskImport(
  provider: ExternalBoardProvider,
  detail: ExternalTaskDetail | null,
  projectId: string | null,
  {
    enabled = true,
    connectionEpoch,
    projectName = null,
  }: {
    enabled?: boolean;
    connectionEpoch: IntegrationConnectionEpoch | null;
    projectName?: string | null;
  },
) {
  const apiFetch = useFetchFactory();
  const queryClient = useQueryClient();
  const scopedProjectId = validIntegrationProjectId(projectId);
  const presentationScope: IntegrationPresentationScope | null =
    enabled && scopedProjectId !== null && connectionEpoch !== null && detail !== null
      ? {
          projectId: scopedProjectId,
          provider,
          connectionEpoch,
          taskId: detail.remoteId,
        }
      : null;
  const presentationScopeRef = useRef(presentationScope);
  presentationScopeRef.current = presentationScope;
  const submissionRef = useRef<{
    scope: IntegrationPresentationScope;
    detail: ExternalTaskDetail;
    projectName: string | null;
    apiFetch: FetchFn;
  } | null>(null);
  submissionRef.current =
    presentationScope !== null && detail !== null
      ? { scope: presentationScope, detail, projectName, apiFetch }
      : null;

  const isCurrentScope = useCallback(
    (scope: IntegrationPresentationScope) =>
      isSameIntegrationPresentationScope(scope, presentationScopeRef.current),
    [],
  );
  const statuses = useQuery({
    queryKey: ['statuses', scopedProjectId],
    queryFn: (): Promise<{ items: ExternalImportStatus[] }> =>
      fetchStatuses(scopedProjectId!, apiFetch),
    enabled: enabled && scopedProjectId !== null,
  });

  const mutation = useMutation<
    ExternalTaskImportResponse,
    Error,
    ExternalTaskImportMutationVariables
  >({
    mutationFn: async (variables): Promise<ExternalTaskImportResponse> => {
      const { scope, detail: capturedDetail, form, apiFetch: capturedFetch } = variables;
      const webUrl = safeExternalTaskUrl(scope.provider, capturedDetail.webUrl);
      if (!webUrl) throw new Error('The remote task source URL is unavailable.');
      return fetchJsonOrThrow<ExternalTaskImportResponse>(
        '/api/epics/import-external-task',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectId: scope.projectId,
            statusId: form.statusId,
            agentId: null,
            title: form.title.trim(),
            description: form.description.trim() || null,
            remote: {
              provider: scope.provider,
              scopeKey: capturedDetail.location.scopeKey,
              taskId: capturedDetail.remoteId,
              remoteKey: capturedDetail.remoteKey,
              title: capturedDetail.title,
              description: capturedDetail.description,
              webUrl,
              workAreaId: capturedDetail.location.workAreaId,
              workAreaName: capturedDetail.location.workAreaName,
              statusName: capturedDetail.status.name,
            },
          }),
        },
        'Task import failed.',
        '',
        capturedFetch,
      );
    },
    onSuccess: async (result, variables) => {
      const { scope, detail: capturedDetail, projectAttribution, cacheKeys } = variables;
      // A project-scoped import always returns the submitting project's own
      // Epic and link. Decoration attributes only that project — another
      // project's task is never presented as this import's result.
      // The import response carries no checkpoint knowledge: each patched item
      // keeps its prior loggedMinutes, and an authoritative refetch supplies
      // the confirmed figure later.
      const link: ExternalTaskLinkStateSummary = {
        scopeKey: capturedDetail.location.scopeKey,
        taskId: capturedDetail.remoteId,
        linked: true,
        epicId: result.epic.id,
        projectId: projectAttribution.id,
        projectName: projectAttribution.name,
        loggedMinutes: null,
      };
      queryClient.setQueriesData<{ items: ExternalTaskLinkStateSummary[] }>(
        { queryKey: cacheKeys.links },
        (current) =>
          current
            ? {
                items: current.items.map((item) =>
                  item.scopeKey === link.scopeKey && item.taskId === link.taskId
                    ? { ...link, loggedMinutes: item.loggedMinutes }
                    : item,
                ),
              }
            : current,
      );
      const invalidations = [
        queryClient.invalidateQueries({ queryKey: cacheKeys.epics }),
        queryClient.invalidateQueries({ queryKey: cacheKeys.taskDetail }),
        queryClient.invalidateQueries({ queryKey: cacheKeys.links }),
      ];
      // Global Epic-source families can include the newly imported Epic only
      // while this submission still owns the visible presentation. A stale
      // project settlement reconciles only its captured project/epoch keys.
      if (isCurrentScope(scope)) {
        invalidations.push(queryClient.invalidateQueries({ queryKey: cacheKeys.epicSources }));
      }
      await Promise.all(invalidations);
    },
  });

  const captureVariables = useCallback(
    (form: ExternalTaskImportForm): ExternalTaskImportMutationVariables | null => {
      const submission = submissionRef.current;
      if (submission === null) return null;
      const { scope, detail: capturedDetail } = submission;
      return {
        scope,
        detail: capturedDetail,
        form: { ...form },
        projectAttribution: { id: scope.projectId, name: submission.projectName },
        cacheKeys: {
          epics: boardCacheKeys.project(scope.projectId),
          links: externalMyWorkQueryKeys.links(scope.provider, scope.connectionEpoch),
          taskDetail: externalMyWorkQueryKeys.taskDetail(
            scope.provider,
            scope.connectionEpoch,
            scope.taskId,
          ),
          epicSources: epicExternalSourceQueryKeys.all,
        },
        apiFetch: submission.apiFetch,
      };
    },
    [],
  );

  const mutate = useCallback(
    (form: ExternalTaskImportForm, callbacks?: ExternalTaskImportCallbacks) => {
      const variables = captureVariables(form);
      if (variables === null) return;
      mutation.mutate(variables, {
        onSuccess: (result, settledVariables) => {
          if (isCurrentScope(settledVariables.scope)) callbacks?.onSuccess?.(result);
        },
        onError: (error, settledVariables) => {
          if (isCurrentScope(settledVariables.scope)) callbacks?.onError?.(error);
        },
        onSettled: (result, error, settledVariables) => {
          if (isCurrentScope(settledVariables.scope)) {
            callbacks?.onSettled?.(result, error);
          }
        },
      });
    },
    [captureVariables, isCurrentScope, mutation],
  );

  const mutateAsync = useCallback(
    (form: ExternalTaskImportForm) => {
      const variables = captureVariables(form);
      return variables === null
        ? Promise.reject(new Error('External task import is unavailable.'))
        : mutation.mutateAsync(variables);
    },
    [captureVariables, mutation],
  );

  const mutationPresentationCurrent =
    mutation.variables === undefined || isCurrentScope(mutation.variables.scope);
  const presentedMutation = {
    ...mutation,
    mutate,
    mutateAsync,
    data: mutationPresentationCurrent ? mutation.data : undefined,
    error: mutationPresentationCurrent ? mutation.error : null,
    variables: mutationPresentationCurrent ? mutation.variables : undefined,
    status: mutationPresentationCurrent ? mutation.status : ('idle' as const),
    isIdle: mutationPresentationCurrent ? mutation.isIdle : true,
    isPending: mutationPresentationCurrent ? mutation.isPending : false,
    isSuccess: mutationPresentationCurrent ? mutation.isSuccess : false,
    isError: mutationPresentationCurrent ? mutation.isError : false,
    failureCount: mutationPresentationCurrent ? mutation.failureCount : 0,
    failureReason: mutationPresentationCurrent ? mutation.failureReason : null,
    submittedAt: mutationPresentationCurrent ? mutation.submittedAt : 0,
  };

  return {
    statuses: enabled ? statuses : { ...statuses, data: undefined },
    mutation: presentedMutation,
  };
}
