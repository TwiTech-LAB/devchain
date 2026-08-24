import { IntegrationConnectionForm } from '@/ui/components/integrations/IntegrationConnectionForm';
import { ManagedSubtaskSyncPanel } from '@/ui/components/integrations/ManagedSubtaskSyncPanel';
import type {
  IntegrationConnectionState,
  IntegrationProvider,
} from '@/ui/lib/integration-connections';
import { useManagedSubtaskSyncHealth } from '@/ui/hooks/useManagedSubtaskSyncHealth';
import type { useIntegrationConnections } from '@/ui/hooks/useIntegrationConnections';

export interface ProviderIntegrationSettingsProps {
  provider: IntegrationProvider;
  connection: IntegrationConnectionState;
  onReplace: ReturnType<typeof useIntegrationConnections>['replaceConnection'];
  onDisconnect: ReturnType<typeof useIntegrationConnections>['disconnectConnection'];
  onUpdateSync: ReturnType<typeof useIntegrationConnections>['updateSubtaskSync'];
  isReplacing: boolean;
  isDisconnecting: boolean;
  isUpdatingSync: boolean;
}

export function ProviderIntegrationSettings({
  provider,
  connection,
  onReplace,
  onDisconnect,
  onUpdateSync,
  isReplacing,
  isDisconnecting,
  isUpdatingSync,
}: ProviderIntegrationSettingsProps) {
  const sync = useManagedSubtaskSyncHealth(provider, { enabled: connection.connected });
  const requiresOrphanRiskAcknowledgement =
    (sync.health?.counts.outcomeUnknown ?? 0) > 0 ||
    (sync.health?.counts.orphanRisk ?? 0) > 0 ||
    (sync.health?.items.some((item) => item.phase === 'dispatch_admitted') ?? false);

  const handleToggle = (enabled: boolean) => onUpdateSync(provider, enabled);

  return (
    <IntegrationConnectionForm
      provider={provider}
      connection={connection}
      onReplace={onReplace}
      onDisconnect={onDisconnect}
      isReplacing={isReplacing}
      isDisconnecting={isDisconnecting}
      requiresOrphanRiskAcknowledgement={requiresOrphanRiskAcknowledgement}
      connectionControls={
        connection.connected ? (
          <ManagedSubtaskSyncPanel
            provider={provider}
            enabled={connection.subtaskSyncEnabled}
            health={sync.health}
            isLoading={sync.isLoading}
            error={sync.error}
            isUpdating={isUpdatingSync}
            pendingAction={sync.pendingAction}
            onToggle={handleToggle}
            onVerify={sync.verify}
            onRetry={sync.retry}
          />
        ) : null
      }
    />
  );
}
