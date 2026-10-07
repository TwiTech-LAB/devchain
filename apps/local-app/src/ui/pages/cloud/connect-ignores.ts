import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useHomeQueryClient } from '@/ui/components/BackendBoundary';
import { readErrorMessage } from '@/ui/hooks/useRemotes';
import { HOME_BACKEND, apiFetch } from '@/ui/lib/api-transport';
import { FILE_SYNC_IGNORES_CHANGED } from '@/modules/file-sync/file-sync.dto';
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

interface ProjectIgnores {
  ignores: string[];
  revision: number;
}
export class FileListChangedError extends Error {}

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
  const query = useQuery(
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
        const body = (await response.json()) as ProjectIgnores;
        if (
          !Array.isArray(body.ignores) ||
          !Number.isSafeInteger(body.revision) ||
          body.revision < 0
        )
          throw new Error('The server returned no file list.');
        return body;
      },
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
  const queryClient = useHomeQueryClient();
  return useCallback(
    async (projectId: string, ignores: string[] | null, revision: number) => {
      const queryKey = ignoresQueryKey(projectId);
      let result: SaveProjectIgnoresResult;
      try {
        result = await saveProjectIgnores(projectId, ignores, revision);
      } catch (error) {
        if (error instanceof FileListChangedError)
          await queryClient.invalidateQueries({ queryKey });
        throw error;
      }
      await queryClient.cancelQueries({ queryKey });
      queryClient.setQueryData(queryKey, { ignores: result.ignores, revision: result.revision });
      await queryClient.invalidateQueries({
        queryKey: [HOME_BACKEND, 'file-sync-auto-fix', projectId],
      });
      return result;
    },
    [queryClient],
  );
}

async function saveProjectIgnores(
  projectId: string,
  ignores: string[] | null,
  revision: number,
): Promise<SaveProjectIgnoresResult> {
  const response = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/file-sync/ignores`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ignores, revision }),
    },
    { backend: HOME_BACKEND },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: unknown;
      code?: unknown;
    } | null;
    const message =
      typeof body?.message === 'string' ? body.message : 'Could not save the file list.';
    // Only a changed list resets the draft; another 409, such as a running Force sync, keeps it.
    throw body?.code === FILE_SYNC_IGNORES_CHANGED
      ? new FileListChangedError(message)
      : new Error(message);
  }
  return response.json() as Promise<SaveProjectIgnoresResult>;
}
