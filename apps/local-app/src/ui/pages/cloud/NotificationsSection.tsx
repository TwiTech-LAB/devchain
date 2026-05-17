import { Bell } from 'lucide-react';
import { useCloudConnection } from '@/ui/hooks/useCloudConnection';
import { DisconnectedHint } from './DisconnectedHint';
import { PushNotificationsPanel } from './PushNotificationsPanel';

interface NotificationsSectionProps {
  onNavigateToAccount: () => void;
}

export function NotificationsSection({ onNavigateToAccount }: NotificationsSectionProps) {
  const { status, isLoading } = useCloudConnection();

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

  return <PushNotificationsPanel />;
}
