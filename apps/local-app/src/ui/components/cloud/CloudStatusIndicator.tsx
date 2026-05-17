import { Link } from 'react-router-dom';
import { Cloud } from 'lucide-react';
import { useCloudConnection } from '../../hooks/useCloudConnection';
import { Button } from '../ui/button';
import { CloudAccountMenu } from './CloudAccountMenu';

export function CloudStatusIndicator() {
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
      />
    );
  }

  return (
    <Button variant="outline" size="sm" className="gap-1.5" asChild>
      <Link to="/cloud?section=account">
        <Cloud className="h-3.5 w-3.5" />
        Connect to cloud
      </Link>
    </Button>
  );
}
