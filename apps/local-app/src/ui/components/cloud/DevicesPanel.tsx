import { Smartphone } from 'lucide-react';
import { AlertCircle } from 'lucide-react';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { useDevicesQuery } from '@/ui/hooks/useDevicesQuery';
import { TestPushButton } from './TestPushButton';

function formatRelativeTime(dateString: string | null | undefined): string {
  if (!dateString) return 'never';
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return 'just now';
  if (diffMin < 60) return `active ${diffMin}m ago`;
  if (diffHour < 24) return `active ${diffHour}h ago`;
  if (diffDay < 7) return `active ${diffDay}d ago`;
  return date.toLocaleDateString();
}

function DeviceRow({
  id,
  platform,
  appVersion,
  lastActiveAt,
}: {
  id: string;
  platform: string;
  appVersion?: string | null;
  lastActiveAt?: string | null;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/50 p-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Smartphone className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="font-medium text-foreground">{platform}</span>
          {appVersion && (
            <Badge variant="secondary" className="text-xs">
              {appVersion}
            </Badge>
          )}
          <Badge variant="secondary" className="bg-primary/10 text-primary">
            Push active
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">{formatRelativeTime(lastActiveAt)}</p>
      </div>
      <div className="shrink-0">
        <TestPushButton deviceId={id} deviceLabel={platform} />
      </div>
    </div>
  );
}

export function DevicesPanel() {
  const state = useDevicesQuery();

  if (state.status === 'loading') {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Smartphone className="h-4 w-4 animate-pulse" />
        Loading devices...
      </div>
    );
  }

  if (state.status === 'endpoint-missing') return null;

  if (state.status === 'error') {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <AlertCircle className="h-4 w-4 text-destructive" />
        <span>Couldn't load device list</span>
        <Button variant="outline" size="sm" onClick={state.refetch}>
          Retry
        </Button>
      </div>
    );
  }

  if (state.devices.length === 0) {
    return (
      <div role="status" className="rounded-lg border border-dashed p-4 text-center">
        <Smartphone className="mx-auto h-6 w-6 text-muted-foreground mb-2" />
        <p className="text-sm text-muted-foreground">
          No mobile devices yet. Install the DevChain mobile app to register one.
        </p>
      </div>
    );
  }

  if (state.devices.length === 1) {
    const device = state.devices[0];
    return <DeviceRow {...device} />;
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-foreground">Devices</span>
        <Badge variant="secondary" className="text-xs">
          {state.devices.length}
        </Badge>
      </div>
      <div className="space-y-1">
        {state.devices.map((device) => (
          <DeviceRow key={device.id} {...device} />
        ))}
      </div>
    </div>
  );
}
