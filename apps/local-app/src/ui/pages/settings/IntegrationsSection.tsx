import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, AlertDescription, AlertTitle } from '@/ui/components/ui/alert';
import { IntegrationConnectionDirectoryList } from '@/ui/components/integrations/IntegrationConnectionDirectory';
import {
  LegacyConnectionList,
  type LegacyAssignmentTarget,
} from '@/ui/components/integrations/LegacyConnectionList';
import {
  useIntegrationConnectionDirectory,
  useLegacyIntegrationConnectionActions,
} from '@/ui/hooks/useIntegrationConnectionDirectory';
import { useIntegrationAvailability } from '@/ui/hooks/useIntegrationAvailability';
import { useSelectedProject } from '@/ui/hooks/useProjectSelection';
import type { IntegrationConnectionDirectoryEntry } from '@/ui/lib/integration-connections';
import { externalBoardMyWorkPath } from '@/ui/lib/external-board';
import { getErrorMessage } from '@/ui/lib/toast-helpers';

export function IntegrationsSection() {
  const availability = useIntegrationAvailability();
  const navigate = useNavigate();
  const { activateProject } = useSelectedProject();
  const { directory, isLoading, error } = useIntegrationConnectionDirectory({
    enabled: availability.canUseIntegrations,
  });
  const legacy = useLegacyIntegrationConnectionActions();

  const targetsByProvider = useMemo(() => {
    const byProvider = new Map<string, LegacyAssignmentTarget[]>();
    for (const entry of directory?.items ?? []) {
      if (entry.configured) continue;
      const targets = byProvider.get(entry.provider) ?? [];
      targets.push({
        projectId: entry.project.id,
        projectName: entry.project.name,
        workspaceName: entry.workspace.name,
      });
      byProvider.set(entry.provider, targets);
    }
    return Object.fromEntries(byProvider);
  }, [directory]);

  if (!availability.canUseIntegrations) {
    return (
      <Alert>
        <AlertTitle>Integrations unavailable</AlertTitle>
        <AlertDescription>
          {availability.reason === 'resolving'
            ? 'Runtime access is still being resolved.'
            : 'External integrations are available only from the main local runtime.'}
        </AlertDescription>
      </Alert>
    );
  }

  if (isLoading) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading integrations…
      </p>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Integrations unavailable</AlertTitle>
        <AlertDescription>
          {getErrorMessage(error, 'Connection states could not be loaded.')}
        </AlertDescription>
      </Alert>
    );
  }

  const entries = directory?.items ?? [];
  const unassignedConnections = directory?.unassignedConnections ?? [];

  const handleOpenBoard = (entry: IntegrationConnectionDirectoryEntry) => {
    activateProject({ id: entry.project.id, workspaceId: entry.workspace.id });
    navigate(externalBoardMyWorkPath(entry.provider));
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">External integrations</h2>
        <p className="text-sm text-muted-foreground">
          Every project keeps its own ClickUp and Jira connections. Connect, replace, and manage
          them from each project's Board — this directory lists who owns what.
        </p>
      </div>
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No projects yet. Connections appear here once projects exist.
        </p>
      ) : (
        <IntegrationConnectionDirectoryList
          entries={entries}
          truncated={directory?.truncated ?? false}
          onOpenBoard={handleOpenBoard}
        />
      )}
      {unassignedConnections.length > 0 ? (
        <section aria-labelledby="legacy-connections-heading" className="space-y-2">
          <h3 id="legacy-connections-heading" className="text-sm font-semibold">
            Legacy connections
          </h3>
          <p className="text-sm text-muted-foreground">
            Recovered credentials whose owning project could not be proved. Assign one to its
            project, inspect its managed-subtask health, or disconnect it.
          </p>
          <LegacyConnectionList
            connections={unassignedConnections}
            targetsByProvider={targetsByProvider}
            onAssign={legacy.assign}
            onDisconnect={legacy.disconnect}
            assigningConnectionId={legacy.assigningConnectionId}
            disconnectingConnectionId={legacy.disconnectingConnectionId}
          />
        </section>
      ) : null}
    </div>
  );
}
