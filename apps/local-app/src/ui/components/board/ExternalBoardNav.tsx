import { useEffect, useState } from 'react';
import { Settings2 } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { cn } from '@/ui/lib/utils';
import { AddBoardButton } from '@/ui/components/board/AddBoardButton';
import { ProviderIntegrationSettings } from '@/ui/components/integrations/ProviderIntegrationSettings';
import { Button } from '@/ui/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import {
  EXTERNAL_BOARD_PROVIDERS,
  externalBoardMyWorkPath,
  externalBoardProviderLabel,
  isExternalLinkedTaskPath,
  type ExternalBoardProvider,
} from '@/ui/lib/external-board';
import { useIntegrationConnections } from '@/ui/hooks/useIntegrationConnections';
import { useSelectedProject } from '@/ui/hooks/useProjectSelection';
import { useIntegrationAvailability } from '@/ui/hooks/useIntegrationAvailability';

export interface ExternalBoardNavProps {
  className?: string;
}

type BoardSource = 'devchain' | ExternalBoardProvider;

const LAST_BOARD_ROUTE_KEY_PREFIX = 'devchain:board:lastRoute:';

function lastBoardRouteKey(projectId: string, source: BoardSource): string {
  return `${LAST_BOARD_ROUTE_KEY_PREFIX}${projectId}:${source}`;
}

function isPathActive(pathname: string, path: string): boolean {
  return pathname === path || pathname.startsWith(`${path}/`);
}

function boardSourceForPath(pathname: string): BoardSource | null {
  if (pathname === '/board') return 'devchain';
  // A linked workspace is a pass-through view under the provider tab, not a
  // Board destination: remembering it would make the tab reopen the linked
  // dialog instead of the user's landing or work-area route.
  if (isExternalLinkedTaskPath(pathname)) return null;
  return (
    EXTERNAL_BOARD_PROVIDERS.find((provider) =>
      isPathActive(pathname, externalBoardMyWorkPath(provider)),
    ) ?? null
  );
}

function isRouteForSource(route: string, source: BoardSource): boolean {
  const pathname = route.split('?')[0];
  // Read-side twin of the write guard: a stored linked route (stale session
  // storage from before the guard existed, or manual tampering) must never be
  // restored as the tab's destination.
  if (isExternalLinkedTaskPath(pathname)) return false;
  if (source === 'devchain') return pathname === '/board';
  return isPathActive(pathname, externalBoardMyWorkPath(source));
}

function readLastBoardRoute(projectId: string, source: BoardSource, fallback: string): string {
  try {
    const route = window.sessionStorage.getItem(lastBoardRouteKey(projectId, source));
    return route && isRouteForSource(route, source) ? route : fallback;
  } catch {
    return fallback;
  }
}

function rememberBoardRoute(projectId: string, source: BoardSource, route: string): void {
  try {
    window.sessionStorage.setItem(lastBoardRouteKey(projectId, source), route);
    // Keys without a project segment predate per-project boards; they can
    // never be read again, so drop this source's stale copy.
    window.sessionStorage.removeItem(`${LAST_BOARD_ROUTE_KEY_PREFIX}${source}`);
  } catch {
    // Navigation still works when session storage is unavailable.
  }
}

export function ExternalBoardNav({ className }: ExternalBoardNavProps) {
  const { canUseIntegrations } = useIntegrationAvailability();
  const { selectedProject, selectedProjectId: selectedProjectIdValue } = useSelectedProject();
  const selectedProjectId = selectedProjectIdValue ?? null;
  const {
    connections,
    isLoading,
    replaceConnection,
    disconnectConnection,
    updateSubtaskSync,
    replacingProvider,
    disconnectingProvider,
    updatingSyncProvider,
  } = useIntegrationConnections({ projectId: selectedProjectId, enabled: canUseIntegrations });
  const { pathname, search } = useLocation();
  const currentSource = boardSourceForPath(pathname);
  const [settingsProvider, setSettingsProvider] = useState<ExternalBoardProvider | null>(null);

  useEffect(() => {
    // Route memory is project-qualified: a remembered work-area URL belongs to
    // the project whose connection produced it, so it is never written or
    // restored while no project is selected.
    if (currentSource && selectedProjectId !== null) {
      rememberBoardRoute(selectedProjectId, currentSource, `${pathname}${search}`);
    }
  }, [currentSource, pathname, search, selectedProjectId]);

  const connectionFor = (provider: ExternalBoardProvider) =>
    connections.find((connection) => connection.provider === provider);
  const connectedProviders = canUseIntegrations
    ? EXTERNAL_BOARD_PROVIDERS.filter((provider) => connectionFor(provider)?.connected)
    : [];
  const settingsConnection = settingsProvider ? connectionFor(settingsProvider) : undefined;

  useEffect(() => {
    if (settingsProvider && (!canUseIntegrations || !settingsConnection?.connected)) {
      setSettingsProvider(null);
    }
  }, [canUseIntegrations, settingsConnection?.connected, settingsProvider]);

  const handleDisconnect = async (
    provider: ExternalBoardProvider,
    acknowledgeOrphanRisk = false,
  ) => {
    const connection = await disconnectConnection(provider, acknowledgeOrphanRisk);
    setSettingsProvider(null);
    return connection;
  };

  return (
    <>
      <nav
        aria-label="Board source"
        className={cn('flex items-center gap-1 border-b border-border px-4 py-2', className)}
      >
        <Link
          to={
            selectedProjectId !== null
              ? readLastBoardRoute(selectedProjectId, 'devchain', '/board')
              : '/board'
          }
          aria-current={pathname === '/board' ? 'page' : undefined}
          className={cn(
            'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
            pathname === '/board'
              ? 'bg-secondary text-secondary-foreground'
              : 'text-muted-foreground hover:bg-muted',
          )}
        >
          DevChain
        </Link>
        {connectedProviders.map((provider) => {
          const defaultPath = externalBoardMyWorkPath(provider);
          const path =
            selectedProjectId !== null
              ? readLastBoardRoute(selectedProjectId, provider, defaultPath)
              : defaultPath;
          const active = isPathActive(pathname, defaultPath);
          const label = externalBoardProviderLabel(provider);

          return (
            <div
              key={provider}
              className={cn(
                'inline-flex items-center rounded-md transition-colors',
                active
                  ? 'bg-secondary text-secondary-foreground'
                  : 'text-muted-foreground hover:bg-muted',
              )}
            >
              <Link
                to={path}
                aria-current={active ? 'page' : undefined}
                className="px-3 py-1.5 text-sm font-medium"
              >
                {label}
              </Link>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="mr-1 h-6 w-6 shrink-0"
                onClick={() => setSettingsProvider(provider)}
                aria-label={`Open ${label} board settings`}
                aria-haspopup="dialog"
              >
                <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            </div>
          );
        })}
        {canUseIntegrations ? (
          <AddBoardButton
            connections={connections}
            isLoading={isLoading}
            onConnect={replaceConnection}
            replacingProvider={replacingProvider}
            projectName={selectedProject?.name ?? null}
          />
        ) : null}
      </nav>

      <Dialog
        open={settingsProvider !== null && settingsConnection?.connected === true}
        onOpenChange={(open) => {
          if (!open) setSettingsProvider(null);
        }}
      >
        <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-2xl">
          {settingsProvider && settingsConnection ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  {externalBoardProviderLabel(settingsProvider)} board settings
                </DialogTitle>
                <DialogDescription>
                  Update this board connection without leaving the Board.
                </DialogDescription>
              </DialogHeader>
              <ProviderIntegrationSettings
                projectId={selectedProjectId}
                provider={settingsProvider}
                connection={settingsConnection}
                onReplace={replaceConnection}
                onDisconnect={handleDisconnect}
                onUpdateSync={updateSubtaskSync}
                isReplacing={replacingProvider === settingsProvider}
                isDisconnecting={disconnectingProvider === settingsProvider}
                isUpdatingSync={updatingSyncProvider === settingsProvider}
              />
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
