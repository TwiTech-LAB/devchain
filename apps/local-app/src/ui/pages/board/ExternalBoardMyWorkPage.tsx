import { Link, useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, ExternalLink, RefreshCw } from 'lucide-react';
import { ExternalBoardNav } from '@/ui/components/board/ExternalBoardNav';
import {
  ExternalWorkAreaCardGrid,
  ExternalWorkAreaCardGridSkeleton,
} from '@/ui/components/board/ExternalWorkAreaCardGrid';
import { EmptyState } from '@/ui/components/shared/EmptyState';
import { Alert, AlertDescription, AlertTitle } from '@/ui/components/ui/alert';
import { Button } from '@/ui/components/ui/button';
import { Checkbox } from '@/ui/components/ui/checkbox';
import { Input } from '@/ui/components/ui/input';
import { Label } from '@/ui/components/ui/label';
import {
  useExternalMyWorkLanding,
  type ExternalWorkAreaCardModel,
} from '@/ui/hooks/board/useExternalMyWorkLanding';
import {
  externalBoardProviderLabel,
  buildExternalWorkAreaPath,
  isExternalBoardProvider,
  type ExternalBoardProvider,
} from '@/ui/lib/external-board';
import { useIntegrationAvailability } from '@/ui/hooks/useIntegrationAvailability';
import { getErrorMessage } from '@/ui/lib/toast-helpers';
import { UnknownExternalBoardProviderPage } from '@/ui/pages/board/UnknownExternalBoardProviderPage';

export interface ExternalBoardMyWorkPageProps {
  provider: ExternalBoardProvider;
}

/** Route element for `/board/:provider` — validates the provider segment once. */
export function ExternalBoardMyWorkRoute() {
  const { provider } = useParams<{ provider: string }>();
  if (!provider || !isExternalBoardProvider(provider)) {
    return <UnknownExternalBoardProviderPage />;
  }
  return <ExternalBoardMyWorkPage provider={provider} />;
}

export function ExternalBoardMyWorkPage({ provider }: ExternalBoardMyWorkPageProps) {
  const label = externalBoardProviderLabel(provider);
  const navigate = useNavigate();
  const availability = useIntegrationAvailability();
  const landing = useExternalMyWorkLanding(provider, {
    enabled: availability.canUseIntegrations,
  });

  const openWorkArea = (card: ExternalWorkAreaCardModel) => {
    navigate(buildExternalWorkAreaPath(provider, card.remoteId, landing.includeCompleted));
  };

  return (
    <div className="flex h-full flex-col">
      <ExternalBoardNav />
      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className="flex items-center gap-1">
          <h1 className="text-2xl font-semibold">{label}</h1>
          {landing.sourceUrl ? (
            <Button asChild variant="ghost" size="icon">
              <a
                href={landing.sourceUrl}
                target="_blank"
                rel="noreferrer"
                title={`Open ${label}`}
                aria-label={`Open ${label}`}
              >
                <ExternalLink className="h-4 w-4" aria-hidden="true" />
              </a>
            </Button>
          ) : null}
        </div>

        {landing.status === 'unavailable' ? (
          <p className="mt-2 text-sm text-muted-foreground">
            {availability.reason === 'resolving'
              ? 'Resolving runtime access…'
              : 'External boards are available only from the main local runtime.'}
          </p>
        ) : landing.status === 'disconnected' ? (
          <p className="mt-2 text-sm text-muted-foreground">
            Connect {label} in{' '}
            <Link to="/settings?section=integrations" className="underline underline-offset-2">
              Settings &rarr; Integrations
            </Link>{' '}
            to see your assigned work.
          </p>
        ) : landing.status === 'connections-loading' || landing.status === 'loading' ? (
          <div className="mt-4">
            <ExternalWorkAreaCardGridSkeleton />
          </div>
        ) : landing.status === 'error' ? (
          <div className="mt-4 space-y-4">
            <Alert variant="destructive">
              <AlertTitle>Assigned work unavailable</AlertTitle>
              <AlertDescription>
                {getErrorMessage(landing.error, 'Assigned work could not be loaded.')}
              </AlertDescription>
            </Alert>
            <Button type="button" variant="outline" onClick={landing.refresh}>
              <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
              Retry
            </Button>
          </div>
        ) : landing.status === 'unsupported' ? (
          <p className="mt-2 text-sm text-muted-foreground">
            {label} does not support My Work yet.
          </p>
        ) : (
          <div className="mt-4 space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <Input
                type="search"
                value={landing.search}
                onChange={(event) => landing.setSearch(event.target.value)}
                placeholder="Search work areas"
                aria-label="Search work areas"
                className="max-w-xs"
                data-shortcut="primary-search"
              />
              <div className="flex items-center gap-2">
                <Checkbox
                  id="include-completed"
                  checked={landing.includeCompleted}
                  onCheckedChange={() => landing.toggleIncludeCompleted()}
                  disabled={landing.isRefreshing}
                />
                <Label
                  htmlFor="include-completed"
                  className="text-sm font-normal text-muted-foreground"
                >
                  Include completed
                </Label>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={landing.refresh}
                disabled={landing.isRefreshing}
              >
                <RefreshCw
                  className={landing.isRefreshing ? 'mr-2 h-4 w-4 animate-spin' : 'mr-2 h-4 w-4'}
                  aria-hidden="true"
                />
                Refresh
              </Button>
              {landing.refreshedAt ? (
                <span className="text-xs text-muted-foreground">
                  Updated {new Date(landing.refreshedAt).toLocaleTimeString()}
                </span>
              ) : null}
            </div>

            {landing.isStale ? (
              <Alert
                variant="default"
                className="border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
              >
                <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                <AlertTitle>Showing previous data</AlertTitle>
                <AlertDescription>
                  The latest refresh failed. {getErrorMessage(landing.error, '')} Retry to load
                  current work.
                </AlertDescription>
              </Alert>
            ) : null}

            {landing.status === 'empty' ? (
              <EmptyState
                title="No assigned work"
                description={
                  landing.includeCompleted
                    ? 'Nothing is assigned to you right now.'
                    : 'Nothing is assigned to you right now. Include completed work to see more.'
                }
              />
            ) : (
              <ExternalWorkAreaCardGrid cards={landing.cards} onSelect={openWorkArea} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
