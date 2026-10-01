import { Bell } from 'lucide-react';
import { HOME_BACKEND, type BackendId } from '@/ui/lib/api-transport';
import { useCloudConnection } from '@/ui/hooks/useCloudConnection';
import { useCloudTarget } from '@/ui/hooks/useCloudTarget';
import { DisconnectedHint } from './DisconnectedHint';
import { PushNotificationsPanel } from './PushNotificationsPanel';

interface NotificationsSectionProps {
  onNavigateToAccount: () => void;
}

export function NotificationsSection({ onNavigateToAccount }: NotificationsSectionProps) {
  const { backend } = useCloudTarget();
  const { status, isLoading } = useCloudConnection(backend);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Bell className="h-4 w-4 animate-pulse" />
        Checking connection...
      </div>
    );
  }

  if (!status.connected) {
    return <DisconnectedHint onNavigateToAccount={onNavigateToAccount} />;
  }

  if (backend === HOME_BACKEND) {
    return <PushNotificationsPanel backend={backend} homeSignedIn />;
  }

  return <RemotePushNotificationsPanel backend={backend} />;
}

function RemotePushNotificationsPanel({ backend }: { backend: BackendId }) {
  const { status } = useCloudConnection(HOME_BACKEND);
  return <PushNotificationsPanel backend={backend} homeSignedIn={status.connected} />;
}
