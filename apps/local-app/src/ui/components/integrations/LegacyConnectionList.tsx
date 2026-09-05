import { useState } from 'react';
import { Alert, AlertDescription } from '@/ui/components/ui/alert';
import { Badge } from '@/ui/components/ui/badge';
import { Button } from '@/ui/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import { Label } from '@/ui/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/components/ui/select';
import { ConfirmDialog } from '@/ui/components/shared/ConfirmDialog';
import { ManagedSubtaskHealthItemRow } from '@/ui/components/integrations/ManagedSubtaskSyncPanel';
import { useLegacyManagedSubtaskSyncHealth } from '@/ui/hooks/useIntegrationConnectionDirectory';
import { IntegrationConnectionApiError } from '@/ui/hooks/useIntegrationConnections';
import type { IntegrationConnectionState } from '@/ui/lib/integration-connections';
import { externalBoardProviderLabel } from '@/ui/lib/external-board';
import { getErrorMessage } from '@/ui/lib/toast-helpers';

export interface LegacyAssignmentTarget {
  projectId: string;
  projectName: string;
  workspaceName: string;
}

interface LegacySyncHealthDetailsProps {
  connectionId: string;
}

function LegacySyncHealthDetails({ connectionId }: LegacySyncHealthDetailsProps) {
  const sync = useLegacyManagedSubtaskSyncHealth(connectionId);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const handleActionError = (error: unknown) => {
    setActionMessage(null);
    setActionError(getErrorMessage(error, 'Managed subtask action could not be completed.'));
  };

  const handleActionSuccess = (message: string) => {
    setActionError(null);
    setActionMessage(message);
  };

  if (sync.isLoading) {
    return (
      <p role="status" className="text-xs text-muted-foreground">
        Loading sync health…
      </p>
    );
  }
  if (sync.error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          {getErrorMessage(sync.error, 'Sync health could not be loaded.')}
        </AlertDescription>
      </Alert>
    );
  }
  const health = sync.health;
  if (!health) return null;
  const actionable = health.items.filter(
    (item) => item.phase !== 'confirmed' || item.tombstoneState === 'orphan_risk',
  );
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        {health.counts.outcomeUnknown} unconfirmed · {health.counts.needsAttention} needing
        attention · {health.counts.orphanRisk} possible orphans
      </p>
      {actionError ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      ) : null}
      {actionMessage ? (
        <p role="status" className="text-sm text-muted-foreground">
          {actionMessage}
        </p>
      ) : null}
      {actionable.length > 0 ? (
        <ul className="space-y-2" aria-label="Legacy managed subtask recovery actions">
          {actionable.map((item) => (
            <ManagedSubtaskHealthItemRow
              key={item.id}
              provider={health.provider}
              item={item}
              pendingAction={sync.pendingAction}
              onVerify={sync.verify}
              onRetry={sync.retry}
              onError={handleActionError}
              onSuccess={handleActionSuccess}
            />
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">No managed subtasks need recovery.</p>
      )}
    </div>
  );
}

interface LegacyConnectionRowProps {
  connection: IntegrationConnectionState;
  targets: LegacyAssignmentTarget[];
  onAssign: (connectionId: string, projectId: string) => Promise<unknown>;
  onDisconnect: (connectionId: string, acknowledgeOrphanRisk: boolean) => Promise<unknown>;
  isAssigning: boolean;
  isDisconnecting: boolean;
}

function LegacyConnectionRow({
  connection,
  targets,
  onAssign,
  onDisconnect,
  isAssigning,
  isDisconnecting,
}: LegacyConnectionRowProps) {
  const label = externalBoardProviderLabel(connection.provider);
  const [assignOpen, setAssignOpen] = useState(false);
  const [targetProjectId, setTargetProjectId] = useState<string | null>(null);
  const [assignError, setAssignError] = useState<string | null>(null);
  const [healthOpen, setHealthOpen] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [serverRequiresOrphanAcknowledgement, setServerRequiresOrphanAcknowledgement] =
    useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);

  const openAssign = () => {
    setTargetProjectId(targets.length === 1 ? (targets[0]?.projectId ?? null) : null);
    setAssignError(null);
    setAssignOpen(true);
  };

  const handleAssign = async () => {
    if (targetProjectId === null) return;
    setAssignError(null);
    try {
      await onAssign(connection.connectionId ?? '', targetProjectId);
      setAssignOpen(false);
    } catch (error) {
      setAssignError(
        getErrorMessage(error, `${label} connection could not be assigned to that project.`),
      );
    }
  };

  const handleDisconnect = () => {
    const acknowledgeOrphanRisk = serverRequiresOrphanAcknowledgement;
    setDisconnectError(null);
    void onDisconnect(connection.connectionId ?? '', acknowledgeOrphanRisk)
      .then(() => {
        setConfirmDisconnect(false);
        setServerRequiresOrphanAcknowledgement(false);
      })
      .catch((error: unknown) => {
        if (
          error instanceof IntegrationConnectionApiError &&
          error.providerReason === 'orphan_risk_ack_required'
        ) {
          setServerRequiresOrphanAcknowledgement(true);
          setConfirmDisconnect(true);
          return;
        }
        setDisconnectError(
          getErrorMessage(error, `${label} connection could not be disconnected.`),
        );
        setConfirmDisconnect(false);
      });
  };

  return (
    <li className="space-y-2 rounded-md border bg-background p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium">
            {label}
            <Badge variant="secondary">Unassigned</Badge>
          </div>
          {connection.updatedAt ? (
            <p className="text-xs text-muted-foreground">
              Updated {new Date(connection.updatedAt).toLocaleString()}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={openAssign}
            disabled={isAssigning}
          >
            Assign to project
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-expanded={healthOpen}
            aria-controls={`legacy-health-${connection.connectionId ?? 'unknown'}`}
            onClick={() => setHealthOpen((open) => !open)}
          >
            Health
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setServerRequiresOrphanAcknowledgement(false);
              setConfirmDisconnect(true);
            }}
            disabled={isDisconnecting}
          >
            Disconnect
          </Button>
        </div>
      </div>
      {disconnectError ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{disconnectError}</AlertDescription>
        </Alert>
      ) : null}
      <Dialog open={assignOpen} onOpenChange={setAssignOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Assign legacy {label} connection</DialogTitle>
            <DialogDescription>
              Choose the project that owns this recovered connection. The project must not already
              have a {label} connection.
            </DialogDescription>
          </DialogHeader>
          {targets.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No project has a vacant {label} slot. Disconnect one of the existing connections
              first.
            </p>
          ) : (
            <div className="space-y-2">
              <Label htmlFor={`legacy-assign-${connection.connectionId ?? 'unknown'}`}>
                Target project
              </Label>
              <Select
                value={targetProjectId ?? undefined}
                onValueChange={(value) => setTargetProjectId(value)}
              >
                <SelectTrigger
                  id={`legacy-assign-${connection.connectionId ?? 'unknown'}`}
                  aria-label={`Target project for the legacy ${label} connection`}
                >
                  <SelectValue placeholder="Select a project" />
                </SelectTrigger>
                <SelectContent>
                  {targets.map((target) => (
                    <SelectItem key={target.projectId} value={target.projectId}>
                      {target.projectName} — {target.workspaceName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {assignError ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{assignError}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setAssignOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => void handleAssign()}
              disabled={targetProjectId === null || isAssigning || targets.length === 0}
            >
              {isAssigning ? 'Assigning…' : 'Assign connection'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {healthOpen ? (
        <div
          id={`legacy-health-${connection.connectionId ?? 'unknown'}`}
          className="border-t pt-2"
          role="region"
          aria-label={`Legacy ${label} sync health`}
        >
          <LegacySyncHealthDetails connectionId={connection.connectionId ?? ''} />
        </div>
      ) : null}
      <ConfirmDialog
        open={confirmDisconnect}
        onOpenChange={(open) => {
          if (!open) setServerRequiresOrphanAcknowledgement(false);
          setConfirmDisconnect(open);
        }}
        onConfirm={handleDisconnect}
        title={`Disconnect legacy ${label} connection?`}
        description={
          serverRequiresOrphanAcknowledgement
            ? 'This connection may have managed subtasks with unproven remote outcomes. Disconnecting can leave remote orphans that DevChain can no longer track.'
            : 'The stored credentials for this recovered connection will be removed. This cannot be undone.'
        }
        confirmText={
          serverRequiresOrphanAcknowledgement ? 'Acknowledge and disconnect' : 'Disconnect'
        }
        variant="destructive"
        loading={isDisconnecting}
      />
    </li>
  );
}

export interface LegacyConnectionListProps {
  connections: IntegrationConnectionState[];
  targetsByProvider: Record<string, LegacyAssignmentTarget[]>;
  onAssign: (connectionId: string, projectId: string) => Promise<unknown>;
  onDisconnect: (connectionId: string, acknowledgeOrphanRisk: boolean) => Promise<unknown>;
  assigningConnectionId: string | null;
  disconnectingConnectionId: string | null;
}

export function LegacyConnectionList({
  connections,
  targetsByProvider,
  onAssign,
  onDisconnect,
  assigningConnectionId,
  disconnectingConnectionId,
}: LegacyConnectionListProps) {
  return (
    <ul className="space-y-2" aria-label="Legacy unassigned connections">
      {connections.map((connection) => (
        <LegacyConnectionRow
          key={connection.connectionId ?? connection.provider}
          connection={connection}
          targets={targetsByProvider[connection.provider] ?? []}
          onAssign={onAssign}
          onDisconnect={onDisconnect}
          isAssigning={assigningConnectionId === (connection.connectionId ?? '')}
          isDisconnecting={disconnectingConnectionId === (connection.connectionId ?? '')}
        />
      ))}
    </ul>
  );
}
