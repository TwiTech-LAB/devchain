import { useCallback } from 'react';
import { Cloud, LogOut, RefreshCw } from 'lucide-react';
import { Button } from '@/ui/components/ui/button';
import { CloudAuthForm } from '@/ui/components/cloud/CloudAuthForm';
import { SignInMobileDeviceDialog } from '@/ui/components/cloud/SignInMobileDeviceDialog';
import { useCloudConnection } from '@/ui/hooks/useCloudConnection';

export function AccountSection() {
  const { status, isLoading, disconnect } = useCloudConnection();

  const handleSwitch = useCallback(() => {
    disconnect();
    const redirectUri = window.location.origin + '/auth/cloud/callback';
    const url = `${status.identityServiceUrl}/auth/github?response_mode=fragment_full&redirect_uri=${encodeURIComponent(redirectUri)}`;
    setTimeout(() => {
      window.open(url, 'devchain-cloud-auth', 'width=600,height=700');
    }, 100);
  }, [status.identityServiceUrl, disconnect]);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Cloud className="h-4 w-4 animate-pulse" />
        Checking connection...
      </div>
    );
  }

  if (!status.connected) {
    return (
      <div className="max-w-sm">
        <CloudAuthForm identityServiceUrl={status.identityServiceUrl} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="rounded-lg border p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Cloud className="h-4 w-4 text-green-500" />
          <span className="text-sm font-medium">Connected</span>
        </div>
        <dl className="grid gap-2 text-sm">
          {status.email && (
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Email</dt>
              <dd>{status.email}</dd>
            </div>
          )}
          {status.userId && (
            <div className="flex justify-between">
              <dt className="text-muted-foreground">User ID</dt>
              <dd className="font-mono text-xs">{status.userId.slice(0, 8)}...</dd>
            </div>
          )}
          {status.identityServiceUrl && (
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Service</dt>
              <dd className="text-xs truncate max-w-[200px]">{status.identityServiceUrl}</dd>
            </div>
          )}
        </dl>
      </div>

      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={handleSwitch}>
          <RefreshCw className="mr-2 h-3.5 w-3.5" />
          Switch account
        </Button>
        <Button variant="outline" size="sm" onClick={disconnect}>
          <LogOut className="mr-2 h-3.5 w-3.5" />
          Disconnect
        </Button>
      </div>

      <SignInMobileDeviceDialog identityServiceUrl={status.identityServiceUrl} />
    </div>
  );
}
