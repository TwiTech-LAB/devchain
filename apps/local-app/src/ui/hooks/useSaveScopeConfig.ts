import { useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchJsonOrThrow, SessionApiError } from '../lib/sessions';
import type { FolderScopeEntry } from '../../modules/codebase-overview-analyzer/types/scope.types';
import type { ScopeConfigResponse } from './useScopeConfig';

export function useSaveScopeConfig(projectId: string) {
  const queryClient = useQueryClient();

  return useMutation<ScopeConfigResponse, SessionApiError, FolderScopeEntry[]>({
    mutationFn: (entries: FolderScopeEntry[]) => {
      const userOnly = entries.filter((e) => e.origin === 'user');
      return fetchJsonOrThrow<ScopeConfigResponse>(
        `/api/projects/${projectId}/codebase-overview/scope`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ entries: userOnly }),
        },
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['codebase-overview', projectId] });
    },
  });
}
