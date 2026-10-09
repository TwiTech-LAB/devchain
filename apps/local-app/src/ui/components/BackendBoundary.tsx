import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation } from 'react-router-dom';
import { AlertTriangle, Server } from 'lucide-react';
import { Button } from '@/ui/components/ui/button';
import { HOME_BACKEND } from '@/ui/lib/api-transport';
import { useOptionalBackend, type ActiveRemote } from '@/ui/lib/backend-context';
import { isHomeRoute } from '@/ui/lib/home-routes';

const HomeQueryClientContext = createContext<QueryClient | undefined>(undefined);

/**
 * The home client `BackendBoundary` captured, available regardless of the active backend.
 * Falls back to the ambient client outside `BackendBoundary` (e.g. component tests that
 * render a page standalone), where there is only one client to begin with.
 */
export function useHomeQueryClient(): QueryClient {
  const captured = useContext(HomeQueryClientContext);
  const ambient = useQueryClient();
  return captured ?? ambient;
}

/** Re-scopes its subtree to the home client so instance-level pages ignore the active backend. */
export function HomeQueryScope({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={useHomeQueryClient()}>{children}</QueryClientProvider>;
}

// Query-client key while project routing is unknown; resolution always remounts away from it.
const PENDING_BACKEND_KEY = 'pending';

/**
 * Scopes its subtree to the active project's backend: a backend switch remounts
 * the subtree (`key`), so pages and socket subscribers start over, and each
 * backend gets its own query cache. Home keeps the app-wide client; a remote gets
 * a fresh client that is cleared when the tab leaves it.
 *
 * While routing is unknown the subtree still renders, on the home client under the
 * `pending` key: the transport refuses every project-routed request
 * (`ROUTING_UNKNOWN`), and `ProjectGate` holds back project pages and the dock.
 */
export function BackendBoundary({ children }: { children: ReactNode }) {
  const backend = useOptionalBackend();
  const homeClient = useQueryClient();
  const ready = backend?.ready ?? true;
  const backendKey = ready ? (backend?.activeBackend ?? HOME_BACKEND) : PENDING_BACKEND_KEY;

  const client = useMemo(
    () =>
      backendKey === HOME_BACKEND || backendKey === PENDING_BACKEND_KEY
        ? homeClient
        : new QueryClient({ defaultOptions: homeClient.getDefaultOptions() }),
    [backendKey, homeClient],
  );

  useEffect(
    () => () => {
      if (client !== homeClient) {
        client.clear();
      }
    },
    [client, homeClient],
  );

  return (
    <HomeQueryClientContext.Provider value={homeClient}>
      <QueryClientProvider key={backendKey} client={client}>
        {children}
      </QueryClientProvider>
    </HomeQueryClientContext.Provider>
  );
}

// The Remote VMs page on its VMs tab, where a version-mismatched VM shows its Update button.
const REMOTE_VMS_HREF = '/cloud?section=remote-vm&tab=vms';

interface UnusableRemote {
  reason: string;
  needsUpdate: boolean;
}

function unusableRemote(remote: ActiveRemote): UnusableRemote | null {
  if (!remote.online) {
    return {
      reason: `Remote "${remote.name}" is offline. Pages for this project load when it is reachable again.`,
      needsUpdate: false,
    };
  }
  if (remote.apiKeyRejected) {
    return {
      reason: `Remote "${remote.name}" rejected this PC's API key. Use Enter API key in Remote VMs to open this project.`,
      needsUpdate: false,
    };
  }
  if (!remote.versionMatches) {
    return {
      reason: `Remote "${remote.name}" needs update: it runs ${remote.version ?? 'an unknown version'}, this DevChain runs a different version. Update the remote to open this project.`,
      needsUpdate: true,
    };
  }
  return null;
}

/**
 * Holds back project-backed content while it cannot be served, in two stages:
 *
 * 1. Project routing unknown (`!ready`): a project page shows the retryable
 *    `backend-bindings-error` panel once a lookup has failed, otherwise nothing.
 * 2. Routing known but the active remote is offline, rejects this PC's API key, or is
 *    version-mismatched: the
 *    `remote-unavailable-banner` replaces the content, or `fallback(reason)` when
 *    the caller supplies one.
 *
 * `scope="page"` skips both stages on a home route (`isHomeRoute`): that content runs
 * on the home client regardless of the active backend. `scope="terminal"` never skips —
 * the dock's session list and its 7 s poll belong to the active *project*.
 */
export function ProjectGate({
  children,
  scope,
  fallback,
}: {
  children: ReactNode;
  scope: 'page' | 'terminal';
  /** Custom replacement for the amber banner while the active remote is unusable. */
  fallback?: (reason: string) => ReactNode;
}) {
  const backend = useOptionalBackend();
  const { pathname } = useLocation();

  if (!backend || (scope === 'page' && isHomeRoute(pathname))) {
    return <>{children}</>;
  }

  if (!backend.ready) {
    if (scope === 'terminal' || !backend.bindingsError) {
      return null;
    }
    return (
      <div
        role="alert"
        data-testid="backend-bindings-error"
        className="m-4 flex flex-col items-start gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm"
      >
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
          <p>{backend.bindingsError.message}</p>
        </div>
        <Button size="sm" variant="outline" onClick={backend.retry}>
          Retry
        </Button>
      </div>
    );
  }

  const unusable = backend.activeRemote ? unusableRemote(backend.activeRemote) : null;
  if (!unusable) {
    return <>{children}</>;
  }
  if (fallback) {
    return <>{fallback(unusable.reason)}</>;
  }
  return (
    <div
      role="alert"
      data-testid="remote-unavailable-banner"
      className="m-4 flex items-start gap-3 rounded-md border border-status-warn/40 bg-status-warn/10 p-4 text-sm"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-status-warn" aria-hidden="true" />
      <div className="flex flex-col items-start gap-3">
        <p>{unusable.reason}</p>
        {unusable.needsUpdate && (
          <Button asChild size="sm" variant="outline">
            <Link to={REMOTE_VMS_HREF}>Open Remote VMs</Link>
          </Button>
        )}
      </div>
    </div>
  );
}

export function RemoteBadge() {
  const activeRemote = useOptionalBackend()?.activeRemote ?? null;
  if (!activeRemote) {
    return null;
  }

  return (
    <span
      data-testid="remote-backend-badge"
      title={`This project runs on the remote "${activeRemote.name}"`}
      className="inline-flex max-w-[200px] items-center gap-1 truncate rounded-md border border-border bg-muted px-2 py-1 text-xs font-medium"
    >
      <Server className="h-3 w-3 shrink-0" aria-hidden="true" />
      Remote: {activeRemote.name}
    </span>
  );
}
