import { useCallback, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../ui/button';
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '../ui/context-menu';
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
  /** Icon-only trigger for tight rows (dock header); the dropdown content is unchanged. */
  compact?: boolean;
  /** Items of a right-click menu on the trigger; rendered only while that menu is open. */
  contextMenu?: ReactNode;
}

export function CloudAccountMenu({
  userId,
  email,
  identityServiceUrl,
  onDisconnect,
  compact = false,
  contextMenu,
}: CloudAccountMenuProps) {
  const handleSwitch = useCallback(() => {
    onDisconnect();
    const redirectUri = window.location.origin + '/auth/cloud/callback';
    const url = `${identityServiceUrl}/auth/github?response_mode=fragment_full&redirect_uri=${encodeURIComponent(redirectUri)}`;
    setTimeout(() => {
      window.open(url, 'devchain-cloud-auth', 'width=600,height=700');
    }, 100);
  }, [identityServiceUrl, onDisconnect]);

  const displayName = email || userId.slice(0, 8);

  const button = (
    <Button
      variant="ghost"
      size="sm"
      className="gap-1.5 text-xs"
      aria-label={compact ? `Cloud connected: ${displayName}` : undefined}
    >
      <Cloud className="h-3.5 w-3.5 text-status-ok" />
      {!compact && <span className="max-w-[120px] truncate">{displayName}</span>}
    </Button>
  );
  // The dropdown trigger stays outermost so the button's data-state follows the left-click menu.
  const trigger = contextMenu ? (
    <ContextMenu>
      <DropdownMenuTrigger asChild>
        <ContextMenuTrigger asChild>{button}</ContextMenuTrigger>
      </DropdownMenuTrigger>
      <ContextMenuContent>{contextMenu}</ContextMenuContent>
    </ContextMenu>
  ) : (
    <DropdownMenuTrigger asChild>{button}</DropdownMenuTrigger>
  );

  return (
    <DropdownMenu>
      {trigger}
      <DropdownMenuContent align="end" side="top">
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
