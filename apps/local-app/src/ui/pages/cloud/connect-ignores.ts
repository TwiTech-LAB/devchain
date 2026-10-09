import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useHomeQueryClient } from '@/ui/components/BackendBoundary';
import { useRemoteVmApi } from './lib/remote-vm-api-context';
import { FileListChangedError } from './lib/remote-vm-errors';
import { projectIgnoresQueryKey, fileSyncAutoFixQueryKey } from './lib/remote-vm-query-keys';
import type { SaveProjectIgnoresResult } from '@/modules/remotes/sync/remote-file-sync.dto';

/**
 * The user's edits of a project's ignore list, kept until they are saved.
 * `restored` asks the server to drop the project's own list for the defaults.
 */
export interface IgnoreDraft {
  list: string[];
  restored: boolean;
  revision?: number;
  /** Explicit editor additions and restored defaults retain their manual origin. */
  manualPatterns?: string[];
}

/**
 * What Connect will save: nothing, the defaults, or the edited list.
 * `reordered`: kept patterns changed their order, which matters because
 * Syncthing applies the first matching pattern.
 */
export type IgnoreChange =
  | { kind: 'none' }
  | { kind: 'restore' }
  | { kind: 'list'; list: string[]; added: string[]; removed: string[]; reordered: boolean };

const sameOrder = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((pattern, index) => pattern === b[index]);

export function ignoreChange(loaded: readonly string[], draft: IgnoreDraft | null): IgnoreChange {
  if (!draft) return { kind: 'none' };
  if (draft.restored) return { kind: 'restore' };
  if (sameOrder(draft.list, loaded)) return { kind: 'none' };
  const added = draft.list.filter((pattern) => !loaded.includes(pattern));
  const removed = loaded.filter((pattern) => !draft.list.includes(pattern));
  const reordered = !sameOrder(
    draft.list.filter((pattern) => loaded.includes(pattern)),
    loaded.filter((pattern) => draft.list.includes(pattern)),
  );
  return { kind: 'list', list: draft.list, added, removed, reordered };
}

/** The project's ignore patterns on this PC; the defaults when it has none of its own. */
export function useProjectIgnores(projectId: string | null) {
  const api = useRemoteVmApi();
  const query = useQuery(
    {
      queryKey: projectIgnoresQueryKey(projectId),
      queryFn: ({ signal }) => api.readProjectIgnores(projectId!, signal),
      enabled: projectId !== null,
      staleTime: Infinity,
      refetchOnMount: 'always',
      retry: false,
    },
    useHomeQueryClient(),
  );
  return { ...query, data: query.data?.ignores, revision: query.data?.revision };
}

/**
 * Saves the project's list (null returns it to the defaults), then caches the
 * saved list from the reply. The next edit starts from the saved list at once;
 * a read still in flight is cancelled, so its older list cannot replace it.
 */
export function useSaveProjectIgnores() {
  const api = useRemoteVmApi();
  const queryClient = useHomeQueryClient();
  return useCallback(
    async (projectId: string, ignores: string[] | null, revision: number) => {
      const queryKey = projectIgnoresQueryKey(projectId);
      let result: SaveProjectIgnoresResult;
      try {
        result = await api.saveProjectIgnores(projectId, ignores, revision);
      } catch (error) {
        if (error instanceof FileListChangedError)
          await queryClient.invalidateQueries({ queryKey });
        throw error;
      }
      await queryClient.cancelQueries({ queryKey });
      queryClient.setQueryData(queryKey, { ignores: result.ignores, revision: result.revision });
      await queryClient.invalidateQueries({
        queryKey: fileSyncAutoFixQueryKey(projectId),
      });
      return result;
    },
    [api, queryClient],
  );
}
