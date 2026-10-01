import { Link } from 'react-router-dom';
import { CloudOff } from 'lucide-react';
import { useCloudConnection } from '../../hooks/useCloudConnection';
import { Button } from '../ui/button';
import { CloudAccountMenu } from './CloudAccountMenu';
import { ProjectVmContextMenu } from './ProjectVmContextMenu';

/**
 * Cloud account state for the dock header. `compact` shrinks both branches to an icon:
 * the connected dropdown keeps its full content, the signed-out link keeps its title.
 * Signed in, a right click opens the selected project's VM menu.
 */
export function CloudStatusIndicator({ compact = false }: { compact?: boolean }) {
  const { status, isLoading, disconnect } = useCloudConnection();

  if (isLoading || !status.identityServiceUrl) {
    return null;
  }

  if (status.connected && status.userId) {
    return (
      <CloudAccountMenu
        userId={status.userId}
        email={status.email}
        identityServiceUrl={status.identityServiceUrl}
        onDisconnect={disconnect}
        compact={compact}
        contextMenu={<ProjectVmContextMenu />}
      />
    );
  }

  if (compact) {
    return (
      <Button variant="ghost" size="icon" asChild>
        <Link to="/cloud?section=account" title="Connect to cloud" aria-label="Connect to cloud">
          <CloudOff className="h-3.5 w-3.5 text-destructive" aria-hidden="true" />
        </Link>
      </Button>
    );
  }

  return (
    <Button variant="outline" size="sm" className="gap-1.5" asChild>
      <Link to="/cloud?section=account">
        <CloudOff className="h-3.5 w-3.5 text-destructive" aria-hidden="true" />
        Connect to cloud
      </Link>
    </Button>
  );
}
