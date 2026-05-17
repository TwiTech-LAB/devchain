import { useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { Cloud, LogOut, RefreshCw, UserCog } from 'lucide-react';

interface CloudAccountMenuProps {
  userId: string;
  email?: string;
  identityServiceUrl: string;
  onDisconnect: () => void;
}

export function CloudAccountMenu({
  userId,
  email,
  identityServiceUrl,
  onDisconnect,
}: CloudAccountMenuProps) {
  const handleSwitch = useCallback(() => {
    onDisconnect();
    const redirectUri = window.location.origin + '/auth/cloud/callback';
    const url = `${identityServiceUrl}/auth/github?response_mode=fragment_full&redirect_uri=${encodeURIComponent(redirectUri)}`;
    setTimeout(() => {
      window.open(url, 'devchain-cloud-auth', 'width=600,height=700');
    }, 100);
  }, [identityServiceUrl, onDisconnect]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-1.5 text-xs">
          <Cloud className="h-3.5 w-3.5 text-green-500" />
          <span className="max-w-[120px] truncate">{email || userId.slice(0, 8)}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <div className="px-2 py-1.5">
          <p className="text-sm font-medium">Cloud connected</p>
          {email && <p className="text-xs text-muted-foreground">{email}</p>}
          <p className="text-xs text-muted-foreground font-mono">{userId.slice(0, 8)}...</p>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/cloud?section=account">
            <UserCog className="mr-2 h-3.5 w-3.5" />
            Manage cloud account
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={handleSwitch}>
          <RefreshCw className="mr-2 h-3.5 w-3.5" />
          Switch account
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onDisconnect}>
          <LogOut className="mr-2 h-3.5 w-3.5" />
          Disconnect
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
