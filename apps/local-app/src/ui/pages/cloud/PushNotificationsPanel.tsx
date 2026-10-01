import { DevicesPanel } from '@/ui/components/cloud/DevicesPanel';
import { NotificationPreferencesPanel } from '@/ui/components/cloud/NotificationPreferencesPanel';
import { ProjectForwardingList } from '@/ui/components/cloud/ProjectForwardingList';
import { QuietHoursConfig } from '@/ui/components/cloud/QuietHoursConfig';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/ui/components/ui/card';
import type { BackendId } from '@/ui/lib/api-transport';

/**
 * `backend` scopes devices to the selected instance. Preferences, quiet hours
 * and forwarding belong to This PC; the caller says whether it is signed in.
 */
export function PushNotificationsPanel({
  backend,
  homeSignedIn,
}: {
  backend?: BackendId;
  homeSignedIn: boolean;
}) {
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
            <DevicesPanel backend={backend} />
          </CardContent>
        </Card>
        {homeSignedIn && <NotificationPreferencesPanel />}
      </div>
      <div className="min-w-0 space-y-6">
        {homeSignedIn ? (
          <>
            <QuietHoursConfig />
            <ProjectForwardingList />
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            Preferences, quiet hours and forwarding belong to This PC. Sign This PC in to DevChain
            Cloud to change them.
          </p>
        )}
      </div>
    </div>
  );
}
