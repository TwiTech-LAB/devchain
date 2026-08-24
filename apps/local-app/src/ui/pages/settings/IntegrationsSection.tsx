import { Alert, AlertDescription, AlertTitle } from '@/ui/components/ui/alert';
import { ProviderIntegrationSettings } from '@/ui/components/integrations/ProviderIntegrationSettings';
import { useIntegrationConnections } from '@/ui/hooks/useIntegrationConnections';
import { useIntegrationAvailability } from '@/ui/hooks/useIntegrationAvailability';
import {
  INTEGRATION_PROVIDER_IDS,
  disconnectedConnectionState,
} from '@/ui/lib/integration-connections';
import { getErrorMessage } from '@/ui/lib/toast-helpers';

export function IntegrationsSection() {
  const availability = useIntegrationAvailability();
  const {
    connections,
    isLoading,
    error,
    replaceConnection,
    disconnectConnection,
    updateSubtaskSync,
    replacingProvider,
    disconnectingProvider,
    updatingSyncProvider,
  } = useIntegrationConnections({ enabled: availability.canUseIntegrations });

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
    return <p className="text-sm text-muted-foreground">Loading integrations…</p>;
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

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">External integrations</h2>
        <p className="text-sm text-muted-foreground">
          Credentials are validated before they replace any saved connection. Saved tokens are never
          returned to the browser.
        </p>
      </div>
      <div className="grid gap-6 xl:grid-cols-2">
        {INTEGRATION_PROVIDER_IDS.map((provider) => {
          const connection =
            connections.find((item) => item.provider === provider) ??
            disconnectedConnectionState(provider);
          return (
            <ProviderIntegrationSettings
              key={provider}
              provider={provider}
              connection={connection}
              onReplace={replaceConnection}
              onDisconnect={disconnectConnection}
              onUpdateSync={updateSubtaskSync}
              isReplacing={replacingProvider === provider}
              isDisconnecting={disconnectingProvider === provider}
              isUpdatingSync={updatingSyncProvider === provider}
            />
          );
        })}
      </div>
    </div>
  );
}
