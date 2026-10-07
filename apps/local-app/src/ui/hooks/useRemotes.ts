import { useMemo, useRef } from 'react';
import { useQuery, type UseMutationResult } from '@tanstack/react-query';
import type { RemoteListItemDto } from '@/modules/remotes/dtos/remote.dto';
import { HOME_BACKEND, apiFetch } from '@/ui/lib/api-transport';
import type { WsEnvelope } from '@/ui/lib/socket';
import {
  REMOTES_LIST_QUERY_KEY,
  REMOTE_BINDINGS_QUERY_KEY,
  type RemoteProjectBindingRow,
} from '@/ui/lib/backend-provider';
import { useHomeQueryClient } from '@/ui/components/BackendBoundary';
import { useHomeSocket } from './useHomeSocket';
import { useCrudMutation } from './useCrudMutations';
import { getErrorMessage } from '@/ui/lib/toast-helpers';

// Fallback when a socket event is missed; the same interval BackendProvider polls at.
const REMOTES_POLL_MS = 30_000;

export interface CreateRemoteInput {
  name: string;
  baseUrl: string;
  apiKey?: string;
  /** Read on the VM; the certificate at `baseUrl` must match it. */
  certificateFingerprint: string;
}

/** The server's `message` from an error response, or `fallback`. */
export async function readErrorMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { message?: unknown } | null;
  return typeof body?.message === 'string' ? body.message : fallback;
}

async function fetchRemotes(signal: AbortSignal): Promise<RemoteListItemDto[]> {
  const res = await apiFetch('/api/remotes', { signal }, { backend: HOME_BACKEND });
  if (!res.ok)
    throw new Error(await readErrorMessage(res, `Failed to load remotes (${res.status})`));
  const body = (await res.json()) as { items?: RemoteListItemDto[] };
  return body.items ?? [];
}

async function fetchBindings(signal: AbortSignal): Promise<RemoteProjectBindingRow[]> {
  const res = await apiFetch('/api/remotes/bindings', { signal }, { backend: HOME_BACKEND });
  if (!res.ok) {
    throw new Error(await readErrorMessage(res, `Failed to load remote bindings (${res.status})`));
  }
  const body = (await res.json()) as { items?: RemoteProjectBindingRow[] };
  return body.items ?? [];
}

/** Home client for the Cloud page's Remote VM section: remotes, bindings, and their mutations. */
export function useRemotes() {
  const queryClient = useHomeQueryClient();
  const keyCandidates = useRef(new WeakMap<CreateRemoteInput, string>()).current;

  const remotesQuery = useQuery(
    {
      queryKey: REMOTES_LIST_QUERY_KEY,
      queryFn: ({ signal }) => fetchRemotes(signal),
      refetchInterval: REMOTES_POLL_MS,
    },
    queryClient,
  );

  const bindingsQuery = useQuery(
    {
      queryKey: REMOTE_BINDINGS_QUERY_KEY,
      queryFn: ({ signal }) => fetchBindings(signal),
      refetchInterval: REMOTES_POLL_MS,
    },
    queryClient,
  );

  // Patches the affected remote in place on a health tick; any other `remotes` event
  // (create/rename/delete) refetches both lists since the shape itself changed.
  useHomeSocket(
    {
      message: (envelope: unknown) => {
        const { topic, type, payload } = (envelope ?? {}) as Partial<WsEnvelope>;
        if (topic !== 'remotes') return;

        if (type === 'state' && payload && typeof payload === 'object') {
          const state = payload as Partial<RemoteListItemDto> & { remoteId?: string };
          if (!state.remoteId) return;
          queryClient.setQueryData<RemoteListItemDto[]>(REMOTES_LIST_QUERY_KEY, (current) =>
            current?.map((remote) =>
              remote.id === state.remoteId
                ? {
                    ...remote,
                    online: state.online ?? remote.online,
                    apiKeyRejected: state.apiKeyRejected ?? remote.apiKeyRejected,
                    version: state.version ?? remote.version,
                    versionMatches: state.versionMatches ?? remote.versionMatches,
                    uid: 'uid' in state ? (state.uid ?? null) : remote.uid,
                    gid: 'gid' in state ? (state.gid ?? null) : remote.gid,
                    dockerUserMismatch:
                      'dockerUserMismatch' in state
                        ? (state.dockerUserMismatch ?? null)
                        : remote.dockerUserMismatch,
                    stats: 'stats' in state ? (state.stats ?? null) : remote.stats,
                    cliVersions:
                      'cliVersions' in state ? (state.cliVersions ?? null) : remote.cliVersions,
                    providerClis:
                      'providerClis' in state ? (state.providerClis ?? null) : remote.providerClis,
                    lastSeenAt: state.lastSeenAt ?? remote.lastSeenAt,
                    powerState: state.powerState ?? remote.powerState,
                    // null is a real value here: the VM stopped reporting a home folder.
                    homePath: 'homePath' in state ? (state.homePath ?? null) : remote.homePath,
                    homePathMatches:
                      'homePathMatches' in state
                        ? (state.homePathMatches ?? null)
                        : remote.homePathMatches,
                  }
                : remote,
            ),
          );
          return;
        }

        void queryClient.invalidateQueries({ queryKey: REMOTES_LIST_QUERY_KEY });
        void queryClient.invalidateQueries({ queryKey: REMOTE_BINDINGS_QUERY_KEY });
      },
    },
    [queryClient],
  );

  // Explicit annotation: `useCrudMutation`'s context generic is an unexported internal
  // type, which TS cannot print into this exported hook's inferred return type.
  const createRemoteMutation: UseMutationResult<RemoteListItemDto, unknown, CreateRemoteInput> =
    useCrudMutation<RemoteListItemDto, CreateRemoteInput>({
      mutationFn: async (input) => {
        const apiKey = keyCandidates.get(input);
        keyCandidates.delete(input);
        const res = await apiFetch(
          '/api/remotes',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...input, ...(apiKey ? { apiKey } : {}) }),
          },
          { backend: HOME_BACKEND },
        );
        if (!res.ok) throw new Error(await readErrorMessage(res, 'Failed to add the VM'));
        return res.json();
      },
      // The create response is an un-enriched Remote (no health fields yet), so the list
      // is refetched from GET /api/remotes rather than optimistically merged.
      invalidateKeys: [REMOTES_LIST_QUERY_KEY],
      // The Add your own VM dialog shows a refusal inline; an error toast here would repeat it.
      toast: {
        success: (data) => ({ title: 'VM added', description: `${data.name} was added.` }),
      },
    });

  // React Query retains mutation variables; candidate secrets must stay out of that cache.
  const prepareCreate = (input: CreateRemoteInput): CreateRemoteInput => {
    const { apiKey, ...registration } = input;
    if (apiKey) keyCandidates.set(registration, apiKey);
    return registration;
  };
  const createRemote: typeof createRemoteMutation = {
    ...createRemoteMutation,
    mutate: (input, options) => createRemoteMutation.mutate(prepareCreate(input), options),
    mutateAsync: (input, options) =>
      createRemoteMutation.mutateAsync(prepareCreate(input), options),
  };

  const deleteRemote: UseMutationResult<void, unknown, { id: string; name: string }> =
    useCrudMutation<void, { id: string; name: string }>({
      mutationFn: async ({ id }) => {
        const res = await apiFetch(
          `/api/remotes/${id}`,
          { method: 'DELETE' },
          { backend: HOME_BACKEND },
        );
        if (!res.ok) throw new Error(await readErrorMessage(res, 'Failed to delete remote'));
      },
      optimistic: {
        queryKey: REMOTES_LIST_QUERY_KEY,
        project: (previous, vars) =>
          Array.isArray(previous)
            ? (previous as RemoteListItemDto[]).filter((remote) => remote.id !== vars.id)
            : previous,
      },
      toast: {
        success: (_data, vars) => ({
          title: 'Remote deleted',
          description: `${vars.name} was removed.`,
        }),
        error: (error, vars) => ({
          title: `Couldn't delete ${vars.name}`,
          description: getErrorMessage(error, 'Failed to delete remote'),
        }),
      },
    });

  const renameRemote: UseMutationResult<RemoteListItemDto, unknown, { id: string; name: string }> =
    useCrudMutation<RemoteListItemDto, { id: string; name: string }>({
      mutationFn: async ({ id, name }) => {
        const res = await apiFetch(
          `/api/remotes/${id}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
          },
          { backend: HOME_BACKEND },
        );
        if (!res.ok) throw new Error(await readErrorMessage(res, 'Failed to rename the VM'));
        return res.json();
      },
      invalidateKeys: [REMOTES_LIST_QUERY_KEY],
      // The Rename dialog and the drawer show a refusal inline; an error toast here would repeat it.
      toast: {
        success: (_data, vars) => ({ title: 'VM renamed', description: `It is now ${vars.name}.` }),
      },
    });

  const bindingByProjectId = useMemo(() => {
    const map = new Map<string, RemoteProjectBindingRow>();
    for (const row of bindingsQuery.data ?? []) map.set(row.projectId, row);
    return map;
  }, [bindingsQuery.data]);

  return {
    remotes: remotesQuery.data ?? [],
    remotesLoading: remotesQuery.isLoading,
    bindings: bindingsQuery.data ?? [],
    bindingsLoading: bindingsQuery.isLoading,
    bindingByProjectId,
    createRemote,
    deleteRemote,
    renameRemote,
  };
}
