import { DevicesPanel } from '@/ui/components/cloud/DevicesPanel';
import { NotificationPreferencesPanel } from '@/ui/components/cloud/NotificationPreferencesPanel';
import { ProjectForwardingList } from '@/ui/components/cloud/ProjectForwardingList';
import { QuietHoursConfig } from '@/ui/components/cloud/QuietHoursConfig';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/ui/components/ui/card';

export function PushNotificationsPanel() {
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="min-w-0 space-y-6">
        <Card>
          <CardHeader className="pb-4">
            <CardTitle className="text-base">Push Notifications</CardTitle>
            <CardDescription>
              Devices that can receive DevChain alerts. Send a test push to verify delivery.
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-0">
            <DevicesPanel />
          </CardContent>
        </Card>
        <NotificationPreferencesPanel />
      </div>
      <div className="min-w-0 space-y-6">
        <QuietHoursConfig />
        <ProjectForwardingList />
      </div>
    </div>
  );
}
