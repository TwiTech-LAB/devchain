import { useState } from 'react';
import { ExternalLink, RefreshCw, ShieldCheck } from 'lucide-react';
import { Alert, AlertDescription } from '@/ui/components/ui/alert';
import { Badge } from '@/ui/components/ui/badge';
import { Button } from '@/ui/components/ui/button';
import { Label } from '@/ui/components/ui/label';
import { Switch } from '@/ui/components/ui/switch';
import type { IntegrationProvider } from '@/ui/lib/integration-connections';
import type {
  ManagedSubtaskSyncHealth,
  ManagedSubtaskSyncHealthItem,
} from '@/ui/lib/managed-subtask-sync';
import { externalBoardProviderLabel, safeExternalTaskUrl } from '@/ui/lib/external-board';
import { getErrorMessage } from '@/ui/lib/toast-helpers';

interface ManagedSubtaskSyncPanelProps {
  provider: IntegrationProvider;
  enabled: boolean;
  health?: ManagedSubtaskSyncHealth | undefined;
  isLoading?: boolean;
  error?: unknown;
  isUpdating?: boolean;
  pendingAction?: string | undefined;
  onToggle: (enabled: boolean) => Promise<unknown>;
  onVerify: (id: string) => Promise<unknown>;
  onRetry: (id: string) => Promise<unknown>;
}

interface HealthItemRowProps {
  provider: IntegrationProvider;
  item: ManagedSubtaskSyncHealthItem;
  pendingAction?: string | undefined;
  onVerify: (id: string) => Promise<unknown>;
  onRetry: (id: string) => Promise<unknown>;
  onError: (error: unknown) => void;
  onSuccess: (message: string) => void;
}

function healthStatusLabel(health: ManagedSubtaskSyncHealth): string {
  switch (health.status) {
    case 'disabled':
      return 'Paused';
    case 'idle':
      return 'Up to date';
    case 'syncing':
      return 'Pending work';
    case 'needs_attention':
      return 'Needs attention';
    case 'orphan_risk':
      return 'Possible remote orphan';
  }
}

function healthStatusVariant(
  status: ManagedSubtaskSyncHealth['status'],
): 'default' | 'destructive' | 'secondary' {
  if (status === 'needs_attention' || status === 'orphan_risk') {
    return 'destructive';
  }
  if (status === 'idle') {
    return 'default';
  }
  return 'secondary';
}

function healthItemMessage(item: ManagedSubtaskSyncHealthItem): string {
  if (item.tombstoneState === 'orphan_risk') {
    return 'The credential context changed before the remote outcome could be proven.';
  }
  if (item.safeErrorCode === 'remote_verification_mismatch') {
    return 'The provider returned different title or description content after the write.';
  }
  if (item.safeErrorCode === 'connection_changed_during_verification') {
    return 'The connection changed during verification. Verify again with the current connection.';
  }
  if (item.safeErrorCode === 'verification_unavailable') {
    return 'Verification is temporarily unavailable. Try again when the provider is reachable.';
  }
  if (item.phase === 'outcome_unknown' || item.phase === 'dispatch_admitted') {
    return 'The remote outcome must be verified before retrying.';
  }
  if (item.phase === 'needs_attention') {
    return 'Ownership or remote state needs attention before another write.';
  }
  return 'This projection is waiting to synchronize.';
}

function ManagedSubtaskHealthItemRow({
  provider,
  item,
  pendingAction,
  onVerify,
  onRetry,
  onError,
  onSuccess,
}: HealthItemRowProps) {
  const label = externalBoardProviderLabel(provider);
  const safeUrl = safeExternalTaskUrl(provider, item.openInSourceUrl);
  const verifying = pendingAction === `verification:${item.id}`;
  const retrying = pendingAction === `retry:${item.id}`;
  const disabled = pendingAction !== undefined;

  const handleVerify = () => {
    void onVerify(item.id)
      .then(() => onSuccess(`${label} managed subtask verification completed.`))
      .catch(onError);
  };

  const handleRetry = () => {
    void onRetry(item.id)
      .then(() => onSuccess(`${label} managed subtask retry completed.`))
      .catch(onError);
  };

  return (
    <li className="space-y-2 rounded-md border bg-background p-3">
      <div>
        <p className="text-sm font-medium">Epic {item.epicId}</p>
        <p className="text-xs text-muted-foreground">{healthItemMessage(item)}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {item.canVerify && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={handleVerify}
            disabled={disabled}
            aria-label={`Verify ${label} managed subtask for Epic ${item.epicId}`}
          >
            <ShieldCheck className="mr-2 h-4 w-4" aria-hidden="true" />
            {verifying ? 'Verifying…' : 'Verify'}
          </Button>
        )}
        {item.canRetry && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={handleRetry}
            disabled={disabled}
            aria-label={`Retry ${label} managed subtask for Epic ${item.epicId}`}
          >
            <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
            {retrying ? 'Retrying…' : 'Retry'}
          </Button>
        )}
        {safeUrl && (
          <Button asChild size="sm" variant="ghost">
            <a
              href={safeUrl}
              target="_blank"
              rel="noreferrer"
              aria-label={`Open ${label} managed subtask for Epic ${item.epicId} in source`}
            >
              <ExternalLink className="mr-2 h-4 w-4" aria-hidden="true" />
              Open in source
            </a>
          </Button>
        )}
      </div>
    </li>
  );
}

export function ManagedSubtaskSyncPanel({
  provider,
  enabled,
  health,
  isLoading = false,
  error,
  isUpdating = false,
  pendingAction,
  onToggle,
  onVerify,
  onRetry,
}: ManagedSubtaskSyncPanelProps) {
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const label = externalBoardProviderLabel(provider);
  const switchDescriptionId = `${provider}-managed-subtask-sync-description`;
  const actionableItems =
    health?.items.filter(
      (item) => item.phase !== 'confirmed' || item.tombstoneState === 'orphan_risk',
    ) ?? [];

  const handleActionError = (actionError: unknown) => {
    setActionMessage(null);
    setActionError(
      getErrorMessage(actionError, `${label} managed subtask action could not be completed.`),
    );
  };

  const handleActionSuccess = (message: string) => {
    setActionError(null);
    setActionMessage(message);
  };

  const handleToggle = (checked: boolean) => {
    setActionError(null);
    setActionMessage(null);
    void onToggle(checked)
      .then(() => {
        setActionMessage(
          checked
            ? `${label} managed subtask sync resumed.`
            : `${label} managed subtask sync paused.`,
        );
      })
      .catch(handleActionError);
  };

  return (
    <section className="space-y-3 border-t pt-4" aria-labelledby={`${provider}-sync-heading`}>
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 id={`${provider}-sync-heading`} className="text-sm font-semibold">
              Managed subtask sync
            </h3>
            {health && (
              <Badge variant={healthStatusVariant(health.status)}>
                {healthStatusLabel(health)}
              </Badge>
            )}
          </div>
          <Label htmlFor={`${provider}-managed-subtask-sync-live`}>
            Sync DevChain sub-epics as managed subtasks
          </Label>
          <p id={switchDescriptionId} className="text-xs text-muted-foreground">
            Pause or resume without entering credentials. DevChain remains authoritative.
          </p>
        </div>
        <Switch
          id={`${provider}-managed-subtask-sync-live`}
          checked={enabled}
          onCheckedChange={handleToggle}
          disabled={isUpdating}
          aria-describedby={switchDescriptionId}
        />
      </div>

      {isUpdating && (
        <p role="status" className="text-xs text-muted-foreground">
          Updating {label} sync setting…
        </p>
      )}
      {isLoading && (
        <p role="status" className="text-xs text-muted-foreground">
          Loading {label} sync health…
        </p>
      )}
      {error !== null && error !== undefined && (
        <Alert variant="destructive">
          <AlertDescription>
            {getErrorMessage(error, `${label} sync health could not be loaded.`)}
          </AlertDescription>
        </Alert>
      )}
      {actionError && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      )}
      {actionMessage && (
        <p role="status" className="text-sm text-muted-foreground">
          {actionMessage}
        </p>
      )}

      {health && (
        <div className="space-y-3">
          <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            <div className="rounded-md bg-muted/40 p-2">
              <dt className="text-xs text-muted-foreground">Pending</dt>
              <dd className="font-medium">{health.counts.pending}</dd>
            </div>
            <div className="rounded-md bg-muted/40 p-2">
              <dt className="text-xs text-muted-foreground">Unconfirmed</dt>
              <dd className="font-medium">{health.counts.outcomeUnknown}</dd>
            </div>
            <div className="rounded-md bg-muted/40 p-2">
              <dt className="text-xs text-muted-foreground">Needs attention</dt>
              <dd className="font-medium">{health.counts.needsAttention}</dd>
            </div>
            <div className="rounded-md bg-muted/40 p-2">
              <dt className="text-xs text-muted-foreground">Possible orphans</dt>
              <dd className="font-medium">{health.counts.orphanRisk}</dd>
            </div>
          </dl>

          {actionableItems.length > 0 && (
            <ul className="space-y-2" aria-label={`${label} managed subtask recovery actions`}>
              {actionableItems.map((item) => (
                <ManagedSubtaskHealthItemRow
                  key={item.id}
                  provider={provider}
                  item={item}
                  pendingAction={pendingAction}
                  onVerify={onVerify}
                  onRetry={onRetry}
                  onError={handleActionError}
                  onSuccess={handleActionSuccess}
                />
              ))}
            </ul>
          )}
          {health.truncated && (
            <p className="text-xs text-muted-foreground">
              Only the first 100 managed projections are shown.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
