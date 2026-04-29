import { useQuery } from '@tanstack/react-query';
import { fetchJsonOrThrow } from '../lib/sessions';
import type { FolderScopeEntry } from '../../modules/codebase-overview-analyzer/types/scope.types';

export interface ScopeConfigResponse {
  entries: FolderScopeEntry[];
  storageMode: 'repo-file' | 'local-only';
}

export const scopeQueryKeys = {
  config: (projectId: string) => ['codebase-overview', projectId, 'scope'] as const,
};

export function useScopeConfig(projectId: string | null) {
  return useQuery({
    queryKey: scopeQueryKeys.config(projectId ?? ''),
    queryFn: () =>
      fetchJsonOrThrow<ScopeConfigResponse>(`/api/projects/${projectId}/codebase-overview/scope`),
    enabled: !!projectId,
    staleTime: Infinity,
    gcTime: 1000 * 60 * 30,
  });
}
