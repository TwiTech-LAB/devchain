import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useHomeSocket } from '@/ui/hooks/useHomeSocket';
import { useSelectedProject } from '@/ui/hooks/useProjectSelection';
import type { WsEnvelope } from '@/ui/lib/socket';
import type {
  FileSyncFailedCounts,
  FileSyncProblem,
} from '@/modules/remotes/sync/remote-file-sync.dto';
import {
  HOME_BACKEND,
  apiFetch as explicitApiFetch,
  buildApiUrl,
  createApiFetch,
  type BackendResolutionContext,
} from '@/ui/lib/api-transport';
import {
  BackendContext,
  useOptionalBackend,
  type ActiveRemote,
  type BackendContextValue,
} from '@/ui/lib/backend-context';

export { useOptionalBackend, type BackendContextValue };

export const REMOTES_QUERY_PREFIX = [HOME_BACKEND, 'remotes'] as const;
export const REMOTE_BINDINGS_QUERY_KEY = [...REMOTES_QUERY_PREFIX, 'bindings'] as const;
export const REMOTES_LIST_QUERY_KEY = [...REMOTES_QUERY_PREFIX, 'list'] as const;
export const remoteStatsHistoryQueryKey = (remoteId: string) =>
  [...REMOTES_QUERY_PREFIX, 'stats-history', remoteId] as const;

/** Envelope type a `project/<id>` broadcast uses to announce a binding row change. */
export const REMOTE_BINDING_EVENT_TYPE = 'remote_binding';

// A project's requests go to its remote only while the remote owns it; during
// `attaching` and after `failed` home is still the writer.
const ROUTED_BINDING_STATES: ReadonlySet<string> = new Set(['remote', 'detaching']);

// Fallback when a socket event is missed; changes normally arrive over the home socket.
const REMOTES_POLL_MS = 30_000;
// Health polls run concurrently; wait for 250 ms of quiet to combine their
// completion burst without noticeably delaying the shared VM status display.
const REMOTES_INVALIDATION_WINDOW_MS = 250;

export interface RemoteProjectBindingRow {
  projectId: string;
  remoteId: string;
  state: string;
  hostCursor?: string | null;
  /** Last live-sync apply error; the project stays routed to the remote. */
  syncError?: string | null;
  fileSyncWarning?: string;
  fileSyncProblem?: FileSyncProblem | null;
  fileSyncFailed?: FileSyncFailedCounts;
}

export function toBindingMap(rows: readonly RemoteProjectBindingRow[] | undefined) {
  const map = new Map<string, string>();
  for (const row of rows ?? []) {
    if (ROUTED_BINDING_STATES.has(row.state)) {
      map.set(row.projectId, row.remoteId);
    }
  }
  return map;
}

export function isBindingChangeEnvelope(envelope: unknown): boolean {
  const { topic, type } = (envelope ?? {}) as Partial<WsEnvelope>;
  if (topic === 'remotes') {
    return true;
  }
  return (
    typeof topic === 'string' && topic.startsWith('project/') && type === REMOTE_BINDING_EVENT_TYPE
  );
}

// The queries keep only the fields that routing and the context read. VM status fields
// (stats, lastSeenAt, the sync cursor) change on almost every poll. Without this, each
// poll would give the context a new value and re-render every page that uses it.
function selectRoutingFields(rows: RemoteProjectBindingRow[]): RemoteProjectBindingRow[] {
  return rows.map(({ projectId, remoteId, state }) => ({ projectId, remoteId, state }));
}

function selectContextFields(items: ActiveRemote[]): ActiveRemote[] {
  return items.map(({ id, name, online, apiKeyRejected, version, versionMatches }) => ({
    id,
    name,
    online,
    apiKeyRejected,
    version,
    versionMatches,
  }));
}

async function fetchHomeJson<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await explicitApiFetch(path, { signal }, { backend: HOME_BACKEND });
  if (!response.ok) {
    throw new Error(`GET ${path} failed (${response.status})`);
  }
  return (await response.json()) as T;
}

export function BackendProvider({ children }: { children: ReactNode }) {
  const { selectedProjectId } = useSelectedProject();
  const queryClient = useQueryClient();
  const invalidationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearInvalidationTimer = useCallback(() => {
    if (invalidationTimer.current !== null) {
      clearTimeout(invalidationTimer.current);
      invalidationTimer.current = null;
    }
  }, []);
  useEffect(() => clearInvalidationTimer, [queryClient, clearInvalidationTimer]);

  const bindingsQuery = useQuery({
    queryKey: REMOTE_BINDINGS_QUERY_KEY,
    queryFn: async ({ signal }) =>
      (await fetchHomeJson<{ items?: RemoteProjectBindingRow[] }>('/api/remotes/bindings', signal))
        .items ?? [],
    select: selectRoutingFields,
    refetchInterval: REMOTES_POLL_MS,
  });

  const bindings = useMemo(() => toBindingMap(bindingsQuery.data), [bindingsQuery.data]);
  const activeRemoteId = (selectedProjectId && bindings.get(selectedProjectId)) || null;

  const remotesQuery = useQuery({
    queryKey: REMOTES_LIST_QUERY_KEY,
    queryFn: async ({ signal }) =>
      (await fetchHomeJson<{ items?: ActiveRemote[] }>('/api/remotes', signal)).items ?? [],
    select: selectContextFields,
    refetchInterval: REMOTES_POLL_MS,
    enabled: bindings.size > 0,
  });

  const activeRemote = useMemo<ActiveRemote | null>(() => {
    if (!activeRemoteId) return null;
    const remote = remotesQuery.data?.find((item) => item.id === activeRemoteId);
    return {
      id: activeRemoteId,
      name: remote?.name ?? activeRemoteId,
      online: remote?.online ?? false,
      apiKeyRejected: remote?.apiKeyRejected ?? false,
      version: remote?.version ?? null,
      versionMatches: remote?.versionMatches ?? false,
    };
  }, [activeRemoteId, remotesQuery.data]);

  // This provider sits outside the backend boundary: `queryClient` is the home client.
  useHomeSocket(
    {
      message: (envelope: unknown) => {
        if (!isBindingChangeEnvelope(envelope)) return;
        const { topic, type, payload } = envelope as Partial<WsEnvelope>;
        if (topic !== 'remotes') {
          void queryClient.invalidateQueries({ queryKey: REMOTE_BINDINGS_QUERY_KEY });
          return;
        }
        // A binding change re-routes the project's requests, so it must not wait
        // for the health batch window; the list and stats history never read
        // binding rows.
        if (type === 'binding') {
          void queryClient.invalidateQueries({ queryKey: REMOTE_BINDINGS_QUERY_KEY, exact: true });
          return;
        }
        clearInvalidationTimer();
        const remoteId = (payload as { remoteId?: unknown } | null)?.remoteId;
        if (typeof remoteId !== 'string' || remoteId.length === 0) {
          void queryClient.invalidateQueries({ queryKey: REMOTES_QUERY_PREFIX });
          return;
        }
        void queryClient.invalidateQueries({
          queryKey: remoteStatsHistoryQueryKey(remoteId),
          exact: true,
        });
        invalidationTimer.current = setTimeout(() => {
          invalidationTimer.current = null;
          void queryClient.invalidateQueries({ queryKey: REMOTES_LIST_QUERY_KEY, exact: true });
          void queryClient.invalidateQueries({ queryKey: REMOTE_BINDINGS_QUERY_KEY, exact: true });
        }, REMOTES_INVALIDATION_WINDOW_MS);
      },
    },
    [queryClient, clearInvalidationTimer],
  );

  // A successful load at least once, not merely settled: an initial error must not
  // let an unknown binding map read as empty and route a bound project home.
  const ready =
    bindingsQuery.data !== undefined &&
    (activeRemoteId === null || remotesQuery.data !== undefined);

  const resolutionContext = useMemo<BackendResolutionContext>(
    () => ({
      bindings,
      activeProjectId: selectedProjectId ?? null,
      authority: ready ? 'known' : 'unknown',
    }),
    [bindings, selectedProjectId, ready],
  );

  // A new instance per context: callbacks created under the previous context keep
  // the previous instance, so their requests stay on the backend they started on.
  const apiFetch = useMemo(() => createApiFetch(() => resolutionContext), [resolutionContext]);
  const bindingsError = bindingsQuery.error ?? remotesQuery.error ?? null;

  // Depend on the stable `refetch` functions, not the result objects, or every render
  // would produce a new `retry` and a new context value.
  const refetchBindings = bindingsQuery.refetch;
  const refetchRemotes = remotesQuery.refetch;
  const retry = useCallback(() => {
    void refetchBindings();
    void refetchRemotes();
  }, [refetchBindings, refetchRemotes]);

  const value = useMemo<BackendContextValue>(
    () => ({
      activeBackend: activeRemoteId ?? HOME_BACKEND,
      activeRemote,
      bindings,
      ready,
      bindingsError,
      retry,
      apiFetch,
      buildApiUrl,
    }),
    [activeRemoteId, activeRemote, bindings, ready, bindingsError, retry, apiFetch],
  );

  return <BackendContext.Provider value={value}>{children}</BackendContext.Provider>;
}
