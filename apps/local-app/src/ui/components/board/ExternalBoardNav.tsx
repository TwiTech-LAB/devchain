import { useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { cn } from '@/ui/lib/utils';
import { AddBoardButton } from '@/ui/components/board/AddBoardButton';
import {
  EXTERNAL_BOARD_PROVIDERS,
  externalBoardMyWorkPath,
  externalBoardProviderLabel,
  isExternalLinkedTaskPath,
  type ExternalBoardProvider,
} from '@/ui/lib/external-board';
import { useIntegrationConnections } from '@/ui/hooks/useIntegrationConnections';
import { useIntegrationAvailability } from '@/ui/hooks/useIntegrationAvailability';

export interface ExternalBoardNavProps {
  className?: string;
}

type BoardSource = 'devchain' | ExternalBoardProvider;

const LAST_BOARD_ROUTE_KEY_PREFIX = 'devchain:board:lastRoute:';

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

function readLastBoardRoute(source: BoardSource, fallback: string): string {
  try {
    const route = window.sessionStorage.getItem(`${LAST_BOARD_ROUTE_KEY_PREFIX}${source}`);
    return route && isRouteForSource(route, source) ? route : fallback;
  } catch {
    return fallback;
  }
}

function rememberBoardRoute(source: BoardSource, route: string): void {
  try {
    window.sessionStorage.setItem(`${LAST_BOARD_ROUTE_KEY_PREFIX}${source}`, route);
  } catch {
    // Navigation still works when session storage is unavailable.
  }
}

export function ExternalBoardNav({ className }: ExternalBoardNavProps) {
  const { canUseIntegrations } = useIntegrationAvailability();
  const { connections, isLoading, replaceConnection, replacingProvider } =
    useIntegrationConnections({ enabled: canUseIntegrations });
  const { pathname, search } = useLocation();
  const currentSource = boardSourceForPath(pathname);

  useEffect(() => {
    if (currentSource) rememberBoardRoute(currentSource, `${pathname}${search}`);
  }, [currentSource, pathname, search]);

  const connectionFor = (provider: ExternalBoardProvider) =>
    connections.find((connection) => connection.provider === provider);
  const connectedProviders = canUseIntegrations
    ? EXTERNAL_BOARD_PROVIDERS.filter((provider) => connectionFor(provider)?.connected)
    : [];

  return (
    <nav
      aria-label="Board source"
      className={cn('flex items-center gap-1 border-b border-border px-4 py-2', className)}
    >
      <Link
        to={readLastBoardRoute('devchain', '/board')}
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
        const path = readLastBoardRoute(provider, defaultPath);
        const active = isPathActive(pathname, defaultPath);

        return (
          <Link
            key={provider}
            to={path}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
              active
                ? 'bg-secondary text-secondary-foreground'
                : 'text-muted-foreground hover:bg-muted',
            )}
          >
            {externalBoardProviderLabel(provider)}
            {!isLoading ? (
              <span className="ml-2 inline-flex items-center rounded-full border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-normal text-emerald-600">
                Connected
              </span>
            ) : null}
          </Link>
        );
      })}
      {canUseIntegrations ? (
        <AddBoardButton
          connections={connections}
          isLoading={isLoading}
          onConnect={replaceConnection}
          replacingProvider={replacingProvider}
        />
      ) : null}
    </nav>
  );
}
