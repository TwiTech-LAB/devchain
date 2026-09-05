import { useEffect, type ReactNode } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import type { ExternalTaskSourceSummary } from '@/modules/external-integrations/models/external-provider.models';
import { ExternalBoardNav } from '@/ui/components/board/ExternalBoardNav';
import { ExternalTaskDetailDialog } from '@/ui/components/board/ExternalTaskDetailDialog';
import { EpicTaskViewNav } from '@/ui/components/epics/EpicTaskViewNav';
import { Alert, AlertDescription, AlertTitle } from '@/ui/components/ui/alert';
import { Button } from '@/ui/components/ui/button';
import { useEpicExternalSources } from '@/ui/hooks/useEpicExternalSources';
import { useIntegrationAvailability } from '@/ui/hooks/useIntegrationAvailability';
import { useIntegrationConnections } from '@/ui/hooks/useIntegrationConnections';
import { useSelectedProject } from '@/ui/hooks/useProjectSelection';
import { useLinkedTaskOwnership } from '@/ui/hooks/board/useLinkedTaskOwnership';
import {
  boardReturnUrlFromState,
  externalBoardProviderLabel,
  externalLinkedTaskState,
  hasInAppHistoryBack,
  isExternalBoardProvider,
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
  const boardReturnUrl = boardReturnUrlFromState(useLocation().state);
  const availability = useIntegrationAvailability();
  const selection = useSelectedProject();
  const ownership = useLinkedTaskOwnership(epicId);
  const owningProject = ownership.project;
  const ownershipKey = owningProject ? `${owningProject.workspaceId}:${owningProject.id}` : null;
  const currentActivation = selection.projectActivation;
  const activationTargetsOwner =
    owningProject !== undefined &&
    currentActivation?.workspaceId === owningProject.workspaceId &&
    currentActivation.projectId === owningProject.id;
  const selectionMatchesOwner =
    owningProject !== undefined &&
    selection.selectedWorkspaceId === owningProject.workspaceId &&
    selection.selectedProjectId === owningProject.id &&
    selection.selectedProject?.id === owningProject.id &&
    !selection.projectsLoading;
  const activationReady =
    ownershipKey !== null &&
    (!activationTargetsOwner || currentActivation?.status === 'confirmed') &&
    selectionMatchesOwner;

  useEffect(() => {
    if (!owningProject || ownershipKey === null) {
      return;
    }
    if (selectionMatchesOwner) return;
    if (selection.isWorkspaceSelectionLocked) return;
    if (
      activationTargetsOwner &&
      (currentActivation?.status === 'pending' || currentActivation?.status === 'failed')
    ) {
      return;
    }

    selection.activateProject(owningProject);
  }, [
    activationTargetsOwner,
    currentActivation?.status,
    ownershipKey,
    owningProject,
    selection,
    selectionMatchesOwner,
  ]);

  const selectedProjectId = activationReady ? owningProject.id : null;
  const { connections, isLoading: connectionsLoading } = useIntegrationConnections({
    projectId: selectedProjectId,
    enabled: availability.canUseIntegrations && activationReady,
  });
  const connectionEpoch = getIntegrationConnectionEpoch(
    connections.find((connection) => connection.provider === provider),
  );
  const sources = useEpicExternalSources(epicId, {
    enabled: availability.canUseIntegrations && owningProject !== undefined,
  });
  const source = sources.data ? earliestSourceForProvider(sources.data.items, provider) : null;
  const workspaceReady =
    availability.canUseIntegrations &&
    activationReady &&
    connectionEpoch !== null &&
    source !== null;

  // Close order: a validated /board return URL with replace, then in-app
  // history back, then the /board entry itself — a direct or reloaded deep
  // link has no in-app entry to return to, so replacing /board keeps the
  // route reachable by forward history.
  const closeWorkspace = () => {
    if (boardReturnUrl !== null) {
      navigate(boardReturnUrl, { replace: true });
      return;
    }
    if (hasInAppHistoryBack()) {
      navigate(-1);
      return;
    }
    navigate('/board', { replace: true });
  };
  // Only the reconstructed, validated Board return state crosses a view
  // switch; raw location state never does.
  const switchState = boardReturnUrl !== null ? externalLinkedTaskState(boardReturnUrl) : undefined;
  const taskViewNav = (
    <EpicTaskViewNav
      epicId={epicId}
      provider={provider}
      activeView="provider"
      boardReturnState={switchState}
    />
  );

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
      </div>
    );
  } else if (ownership.isLoading) {
    pageContent = (
      <p className="mt-2 text-sm text-muted-foreground" role="status">
        Resolving the owning DevChain project…
      </p>
    );
  } else if (ownership.isError || !owningProject) {
    pageContent = (
      <div className="mt-4 space-y-4">
        <Alert variant="destructive">
          <AlertTitle>Owning project unavailable</AlertTitle>
          <AlertDescription>
            {getErrorMessage(ownership.error, 'The owning DevChain project could not be loaded.')}
          </AlertDescription>
        </Alert>
        <Button type="button" variant="outline" onClick={() => void ownership.refetch()}>
          <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
          Retry
        </Button>
      </div>
    );
  } else if (selection.isWorkspaceSelectionLocked && !activationReady) {
    pageContent = (
      <div className="mt-4 space-y-4">
        <Alert>
          <AlertTitle>Open the owning project</AlertTitle>
          <AlertDescription>
            This linked task belongs to {owningProject.name}. Open it from that project's main
            workspace to use its {label} connection.
          </AlertDescription>
        </Alert>
      </div>
    );
  } else if (activationTargetsOwner && currentActivation?.status === 'failed') {
    pageContent = (
      <div className="mt-4 space-y-4">
        <Alert variant="destructive">
          <AlertTitle>Owning project could not be activated</AlertTitle>
          <AlertDescription>
            {owningProject.name} is not available in its expected workspace. Refresh the project
            list and try again.
          </AlertDescription>
        </Alert>
        <Button
          type="button"
          variant="outline"
          onClick={() => selection.activateProject(owningProject)}
        >
          Retry
        </Button>
      </div>
    );
  } else if (!activationReady) {
    pageContent = (
      <p className="mt-2 text-sm text-muted-foreground" role="status">
        Activating {owningProject.name}…
      </p>
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
        Use Add board in the Board navigation above to connect {label} for {owningProject.name},
        then reopen this linked task.
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
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {activationReady ? <ExternalBoardNav /> : null}
      <main className="flex-1 overflow-y-auto px-4 py-6">
        <h1 className="text-2xl font-semibold">Linked {label} task</h1>
        {/* The route window covers the page once ready; before that the
            switcher lives here so every fallback state can still reach the
            DevChain view. */}
        {workspaceReady ? null : <div className="mt-3">{taskViewNav}</div>}
        {pageContent}
      </main>

      {/* The workspace opens only after runtime admission, a resolved
          connection, and a durable provider source all hold; the dialog's own
          expected-Epic gate then verifies the live link before exposing
          anything. The vendor webUrl is never used for internal navigation. */}
      {workspaceReady ? (
        <ExternalTaskDetailDialog
          provider={provider}
          projectId={selectedProjectId}
          taskId={source.remoteTaskId}
          open
          onOpenChange={(open) => {
            if (!open) closeWorkspace();
          }}
          enabled
          connectionEpoch={connectionEpoch}
          expectedLinkedEpicId={epicId}
          routeWindowNav={taskViewNav}
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
