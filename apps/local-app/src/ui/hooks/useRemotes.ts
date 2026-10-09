import { useMemo, useRef } from 'react';
import { useQuery, type UseMutationResult } from '@tanstack/react-query';
import type { RemoteListItemDto } from '@/modules/remotes/dtos/remote.dto';
import type {
  CreateRemoteInput,
  RemoteProjectBindingRow,
} from '@/ui/pages/cloud/lib/remote-vm-contracts';
import { useRemoteVmApi } from '@/ui/pages/cloud/lib/remote-vm-api-context';
import type { WsEnvelope } from '@/ui/lib/socket';
import {
  REMOTES_LIST_QUERY_KEY,
  REMOTE_BINDINGS_QUERY_KEY,
} from '@/ui/pages/cloud/lib/remote-vm-query-keys';
import { useHomeQueryClient } from '@/ui/components/BackendBoundary';
import { useHomeSocket } from './useHomeSocket';
import { useCrudMutation } from './useCrudMutations';
import { getErrorMessage } from '@/ui/lib/toast-helpers';

// Fallback when a socket event is missed; the same interval BackendProvider polls at.
const REMOTES_POLL_MS = 30_000;

/** Home client for the Cloud page's Remote VM section: remotes, bindings, and their mutations. */
export function useRemotes() {
  const api = useRemoteVmApi();
  const queryClient = useHomeQueryClient();
  const keyCandidates = useRef(new WeakMap<CreateRemoteInput, string>()).current;

  const remotesQuery = useQuery(
    {
      queryKey: REMOTES_LIST_QUERY_KEY,
      queryFn: ({ signal }) => api.listRemotes(signal),
      refetchInterval: REMOTES_POLL_MS,
    },
    queryClient,
  );

  const bindingsQuery = useQuery(
    {
      queryKey: REMOTE_BINDINGS_QUERY_KEY,
      queryFn: ({ signal }) => api.listBindings(signal),
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
        return api.createRemote({ ...input, ...(apiKey ? { apiKey } : {}) });
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
      mutationFn: ({ id }) => api.deleteRemote(id),
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
      mutationFn: ({ id, name }) => api.renameRemote(id, name),
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
