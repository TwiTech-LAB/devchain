import type { ReactNode } from 'react';
import {
  AlertTriangle,
  Circle,
  Copy,
  Loader2,
  Pencil,
  Power,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { AgentContextBar } from './AgentContextBar';
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/ui/components/ui/context-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/ui/components/ui/tooltip';
import { cn } from '@/ui/lib/utils';
import type { AgentOrGuest } from '@/ui/hooks/useChatQueries';
import type { AgentContextMetrics } from '@/ui/hooks/useAgentSessionMetrics';

interface AgentRowProps {
  agent: AgentOrGuest;
  isSelected: boolean;
  isOnline: boolean;
  activityState: string | null;
  currentActivityTitle: string | null;
  sessionMetrics?: AgentContextMetrics;
  pendingRestart: boolean;
  providerIconUri: string | null;
  providerName: string | null;
  configDisplayName: string | null;
  contextTrackingEnabled: boolean;
  hasSelectedProject: boolean;
  hasSession: boolean;
  sessionId: string | null;
  isLaunching: boolean;
  isRestarting: boolean;
  isLaunchingChat: boolean;
  activityBadge?: ReactNode;
  providerConfigSubmenu: ReactNode;
  isTeamLead?: boolean;
  canClone?: boolean;
  onClone?: () => void;
  canDelete?: boolean;
  onDelete?: () => void;
  pendingDelete?: boolean;
  canEditTeam?: boolean;
  onEditTeam?: () => void;
  onClick: () => void;
  onRestart: () => Promise<void> | void;
  onLaunch: () => Promise<unknown> | void;
  onTerminate: () => void;
  onToggleContextTracking: () => void;
}

export function AgentRow({
  agent,
  isSelected,
  isOnline,
  activityState,
  currentActivityTitle,
  sessionMetrics,
  pendingRestart,
  providerIconUri,
  providerName,
  configDisplayName,
  contextTrackingEnabled,
  hasSelectedProject,
  hasSession,
  sessionId,
  isLaunching,
  isRestarting,
  isLaunchingChat,
  activityBadge,
  providerConfigSubmenu,
  canClone = false,
  onClone,
  canDelete = false,
  onDelete,
  pendingDelete = false,
  canEditTeam = false,
  onEditTeam,
  onClick,
  onRestart,
  onLaunch,
  onTerminate,
  onToggleContextTracking,
}: AgentRowProps) {
  const anyBusy = isLaunching || isRestarting;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          onClick={onClick}
          disabled={isLaunchingChat}
          className={cn(
            'flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-muted',
            isSelected && 'bg-secondary',
            isLaunchingChat && 'cursor-not-allowed opacity-50',
          )}
          role="listitem"
          aria-label={`Chat with ${agent.name}${isOnline ? ' (online)' : ' (offline)'}`}
          aria-current={isSelected ? 'true' : undefined}
        >
          <Circle
            className={cn(
              'h-2 w-2 fill-current',
              isOnline ? 'text-green-500' : 'text-muted-foreground',
            )}
            aria-hidden="true"
          />
          {providerIconUri && (
            <img
              src={providerIconUri}
              className="h-4 w-4 flex-shrink-0"
              aria-hidden="true"
              title={providerName ? `Provider: ${providerName}` : undefined}
              alt=""
            />
          )}
          <div className="min-w-0 flex-1 overflow-hidden text-left">
            <div className="truncate">
              {agent.name}
              {configDisplayName && (
                <span className="text-muted-foreground"> ({configDisplayName})</span>
              )}
            </div>
            {isOnline && activityState === 'busy' && currentActivityTitle && (
              <div className="truncate text-xs text-muted-foreground" title={currentActivityTitle}>
                {currentActivityTitle}
              </div>
            )}
          </div>
          {activityBadge}
          {pendingRestart && isOnline && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <AlertTriangle className="ml-1 h-4 w-4 flex-shrink-0 text-yellow-500" />
                </TooltipTrigger>
                <TooltipContent>Restart to apply config changes</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </button>
      </ContextMenuTrigger>
      {sessionMetrics && contextTrackingEnabled && (
        <div className="px-3 -mt-0.5 pb-1">
          <AgentContextBar {...sessionMetrics} />
        </div>
      )}
      <ContextMenuContent className="w-56">
        {providerConfigSubmenu}
        <ContextMenuSeparator />
        <ContextMenuCheckboxItem
          checked={contextTrackingEnabled}
          onCheckedChange={onToggleContextTracking}
        >
          Context tracking
        </ContextMenuCheckboxItem>
        {canClone && onClone && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => onClone()}>
              <Copy className="mr-2 h-4 w-4" />
              Clone
            </ContextMenuItem>
          </>
        )}
        {canEditTeam && onEditTeam && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => onEditTeam()}>
              <Pencil className="mr-2 h-4 w-4" />
              Edit team
            </ContextMenuItem>
          </>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={async (event) => {
            event.preventDefault();
            await onRestart();
          }}
          disabled={anyBusy || !hasSelectedProject}
        >
          {isRestarting ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <RotateCcw className="mr-2 h-4 w-4" />
          )}
          Restart session
        </ContextMenuItem>
        {!hasSession && (
          <ContextMenuItem
            onSelect={async (event) => {
              event.preventDefault();
              await onLaunch();
            }}
            disabled={isLaunching || !hasSelectedProject}
          >
            {isLaunching && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Launch session
          </ContextMenuItem>
        )}
        {hasSession && sessionId && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              onSelect={(event) => {
                event.preventDefault();
                onTerminate();
              }}
              disabled={anyBusy || !hasSelectedProject}
            >
              <Power className="mr-2 h-4 w-4" />
              Terminate session
            </ContextMenuItem>
          </>
        )}
        {canDelete && onDelete && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              onSelect={() => onDelete()}
              disabled={pendingDelete}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 className="mr-2 h-4 w-4" />
              {pendingDelete ? 'Deleting…' : 'Delete'}
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
