import type { ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import type { ExternalTaskSourceSummary } from '@/modules/external-integrations/models/external-provider.models';
import { ExternalBoardNav } from '@/ui/components/board/ExternalBoardNav';
import { ExternalTaskDetailDialog } from '@/ui/components/board/ExternalTaskDetailDialog';
import { Alert, AlertDescription, AlertTitle } from '@/ui/components/ui/alert';
import { Button } from '@/ui/components/ui/button';
import { useEpicExternalSources } from '@/ui/hooks/useEpicExternalSources';
import { useIntegrationAvailability } from '@/ui/hooks/useIntegrationAvailability';
import { useIntegrationConnections } from '@/ui/hooks/useIntegrationConnections';
import {
  externalBoardProviderLabel,
  isExternalBoardProvider,
  parseBoardReturnUrl,
  type ExternalBoardProvider,
} from '@/ui/lib/external-board';
import { getIntegrationConnectionEpoch } from '@/ui/lib/integration-connections';
import { getErrorMessage } from '@/ui/lib/toast-helpers';
import { UnknownExternalBoardProviderPage } from '@/ui/pages/board/UnknownExternalBoardProviderPage';

/**
 * Earliest-created source wins: when a later import linked the same Epic to a
 * second task in the same provider, the workspace must open the original
 * link, not the newest one. ISO timestamps compare chronologically as strings;
 * the remote-task ID tie-break keeps selection deterministic.
 */
function earliestSourceForProvider(
  items: readonly ExternalTaskSourceSummary[],
  provider: ExternalBoardProvider,
): ExternalTaskSourceSummary | null {
  const matches = items.filter((item) => item.provider === provider);
  if (matches.length === 0) return null;
  return matches.reduce((earliest, candidate) =>
    candidate.linkedAt < earliest.linkedAt ||
    (candidate.linkedAt === earliest.linkedAt && candidate.remoteTaskId < earliest.remoteTaskId)
      ? candidate
      : earliest,
  );
}

interface ValidExternalLinkedTaskPageProps {
  provider: ExternalBoardProvider;
  epicId: string;
}

function ValidExternalLinkedTaskPage({ provider, epicId }: ValidExternalLinkedTaskPageProps) {
  const label = externalBoardProviderLabel(provider);
  const navigate = useNavigate();
  // History state is attacker-controllable in spirit: only the exact native
  // /board entry (optional query) is ever honored as a return target.
  const returnUrl = parseBoardReturnUrl(useLocation().state);
  const availability = useIntegrationAvailability();
  const { connections, isLoading: connectionsLoading } = useIntegrationConnections({
    enabled: availability.canUseIntegrations,
  });
  const connectionEpoch = getIntegrationConnectionEpoch(
    connections.find((connection) => connection.provider === provider),
  );
  const sources = useEpicExternalSources(epicId, {
    enabled: availability.canUseIntegrations,
  });
  const source = sources.data ? earliestSourceForProvider(sources.data.items, provider) : null;
  const epicHref = `/epics/${encodeURIComponent(epicId)}`;
  const workspaceReady =
    availability.canUseIntegrations && connectionEpoch !== null && source !== null;

  const closeWorkspace = () => navigate(returnUrl, { replace: true });

  let pageContent: ReactNode = null;
  if (!availability.canUseIntegrations) {
    pageContent = (
      <div className="mt-4 space-y-4">
        <Alert>
          <AlertTitle>External boards unavailable</AlertTitle>
          <AlertDescription>
            {availability.reason === 'resolving'
              ? 'Runtime access is still being resolved.'
              : 'External boards are available only from the main local runtime.'}
          </AlertDescription>
        </Alert>
        <Link to={epicHref} className="text-sm font-medium underline underline-offset-4">
          Open DevChain task
        </Link>
      </div>
    );
  } else if (connectionsLoading) {
    pageContent = (
      <p className="mt-2 text-sm text-muted-foreground" role="status">
        Resolving the {label} connection…
      </p>
    );
  } else if (connectionEpoch === null) {
    pageContent = (
      <p className="mt-2 text-sm text-muted-foreground">
        Connect {label} in{' '}
        <Link to="/settings?section=integrations" className="underline underline-offset-2">
          Settings &rarr; Integrations
        </Link>{' '}
        to open this linked task.
      </p>
    );
  } else if (sources.isLoading) {
    pageContent = (
      <p className="mt-2 text-sm text-muted-foreground" role="status">
        Resolving the linked task…
      </p>
    );
  } else if (sources.isError) {
    pageContent = (
      <div className="mt-4 space-y-4">
        <Alert variant="destructive">
          <AlertTitle>Linked task unavailable</AlertTitle>
          <AlertDescription>
            {getErrorMessage(sources.error, 'The linked task source could not be loaded.')}
          </AlertDescription>
        </Alert>
        <Button type="button" variant="outline" onClick={() => void sources.refetch()}>
          <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
          Retry
        </Button>
      </div>
    );
  } else if (!source) {
    pageContent = (
      <div className="mt-4 space-y-4">
        <Alert>
          <AlertTitle>Linked task unavailable</AlertTitle>
          <AlertDescription>
            This DevChain task is not linked to a {label} task in the current project.
          </AlertDescription>
        </Alert>
        <Link to={epicHref} className="text-sm font-medium underline underline-offset-4">
          Open DevChain task
        </Link>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <ExternalBoardNav />
      <div className="flex-1 overflow-y-auto px-4 py-6">
        <h1 className="text-2xl font-semibold">Linked {label} task</h1>
        {pageContent}
      </div>

      {/* The workspace opens only after runtime admission, a resolved
          connection, and a durable provider source all hold; the dialog's own
          expected-Epic gate then verifies the live link before exposing
          anything. The vendor webUrl is never used for internal navigation. */}
      {workspaceReady ? (
        <ExternalTaskDetailDialog
          provider={provider}
          taskId={source.remoteTaskId}
          open
          onOpenChange={(open) => {
            if (!open) closeWorkspace();
          }}
          enabled
          connectionEpoch={connectionEpoch}
          expectedLinkedEpicId={epicId}
        />
      ) : null}
    </div>
  );
}

/** Route element for `/board/:provider/linked/:epicId` — validates both segments once. */
export function ExternalLinkedTaskRoute() {
  const { provider, epicId } = useParams<{ provider: string; epicId: string }>();
  if (!provider || !isExternalBoardProvider(provider) || !epicId) {
    return <UnknownExternalBoardProviderPage />;
  }
  return <ValidExternalLinkedTaskPage provider={provider} epicId={epicId} />;
}
