import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useHomeQueryClient } from '@/ui/components/BackendBoundary';
import { readErrorMessage } from '@/ui/hooks/useRemotes';
import { HOME_BACKEND, apiFetch } from '@/ui/lib/api-transport';

/**
 * The user's edits of a project's ignore list, kept until Connect saves them.
 * `restored` asks the server to drop the project's own list for the defaults.
 */
export interface IgnoreDraft {
  list: string[];
  restored: boolean;
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

function ignoresPath(projectId: string): string {
  return `/api/file-sync/projects/${encodeURIComponent(projectId)}/ignores`;
}

const ignoresQueryKey = (projectId: string | null) =>
  [HOME_BACKEND, 'file-sync-ignores', projectId] as const;

/** The project's ignore patterns on this PC; the defaults when it has none of its own. */
export function useProjectIgnores(projectId: string | null) {
  return useQuery(
    {
      queryKey: ignoresQueryKey(projectId),
      queryFn: async ({ signal }) => {
        const response = await apiFetch(
          ignoresPath(projectId!),
          { signal },
          { backend: HOME_BACKEND },
        );
        if (!response.ok) {
          throw new Error(await readErrorMessage(response, 'Could not read the file list.'));
        }
        const body = (await response.json()) as { ignores?: unknown };
        if (!Array.isArray(body.ignores)) throw new Error('The server returned no file list.');
        return body.ignores.filter((pattern): pattern is string => typeof pattern === 'string');
      },
      enabled: projectId !== null,
      staleTime: Infinity,
      retry: false,
    },
    useHomeQueryClient(),
  );
}

/**
 * Saves the project's list (null returns it to the defaults), then marks the
 * cached list stale, so a flow opened later edits the saved list.
 */
export function useSaveProjectIgnores() {
  const queryClient = useHomeQueryClient();
  return useCallback(
    async (projectId: string, ignores: string[] | null) => {
      await saveProjectIgnores(projectId, ignores);
      void queryClient.invalidateQueries({ queryKey: ignoresQueryKey(projectId) });
    },
    [queryClient],
  );
}

async function saveProjectIgnores(projectId: string, ignores: string[] | null): Promise<void> {
  const response = await apiFetch(
    ignoresPath(projectId),
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ignores }),
    },
    { backend: HOME_BACKEND },
  );
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Could not save the file list.'));
  }
}
