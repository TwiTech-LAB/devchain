import { useRef, type ReactNode } from 'react';
import {
  AlertTriangle,
  Circle,
  Copy,
  Loader2,
  Pencil,
  Power,
  RotateCcw,
  SlidersHorizontal,
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
  contextMetricsKey?: string;
  pendingRestart: boolean;
  providerIconUri: string | null;
  providerName: string | null;
  configDisplayName: string | null;
  configDisplayTitle?: string | null;
  contextTrackingEnabled: boolean;
  hasSelectedProject: boolean;
  hasSession: boolean;
  sessionId: string | null;
  isLaunching: boolean;
  isRestarting: boolean;
  isLaunchingChat: boolean;
  activityBadge?: ReactNode;
  /** Whether to show the "Overrides…" context-menu entry (hidden for guests). */
  canOverride?: boolean;
  /** Opens the shared Overrides dialog; receives the row trigger for focus restoration. */
  onOpenOverrides?: (trigger: HTMLElement | null) => void;
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

interface AgentIdentityProps {
  agentName: string;
  configDisplayName: string | null;
  /** Full-detail tooltip for the config label (e.g. "model: X · effort: Y"). */
  configDisplayTitle?: string | null;
  currentActivityTitle?: string | null;
  isTeamLead?: boolean;
}

export function AgentIdentity({
  agentName,
  configDisplayName,
  configDisplayTitle,
  currentActivityTitle,
  isTeamLead = false,
}: AgentIdentityProps) {
  return (
    <div className="min-w-0 flex-1 overflow-hidden text-left">
      <div className="flex min-w-0 items-baseline gap-1.5 leading-5">
        <span
          className={cn(
            'min-w-0 truncate font-medium text-foreground',
            isTeamLead && 'text-[#8f4f39] dark:text-[#d08a67]',
          )}
          title={agentName}
        >
          {agentName}
        </span>
        {configDisplayName && (
          <span
            className="max-w-[45%] shrink truncate text-[11px] font-normal text-muted-foreground"
            title={configDisplayTitle ?? configDisplayName}
          >
            {configDisplayName}
          </span>
        )}
      </div>
      {currentActivityTitle && (
        <div className="truncate text-xs text-muted-foreground" title={currentActivityTitle}>
          {currentActivityTitle}
        </div>
      )}
    </div>
  );
}

export function AgentRow({
  agent,
  isSelected,
  isOnline,
  activityState,
  currentActivityTitle,
  sessionMetrics,
  contextMetricsKey,
  pendingRestart,
  providerIconUri,
  providerName,
  configDisplayName,
  configDisplayTitle,
  contextTrackingEnabled,
  hasSelectedProject,
  hasSession,
  sessionId,
  isLaunching,
  isRestarting,
  isLaunchingChat,
  activityBadge,
  canOverride = false,
  onOpenOverrides,
  isTeamLead = false,
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
  const triggerRef = useRef<HTMLButtonElement>(null);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          ref={triggerRef}
          onClick={onClick}
          disabled={isLaunchingChat}
          className={cn(
            'flex w-full items-center gap-2 rounded-md border border-r-2 border-transparent border-r-transparent bg-card/40 px-3 py-2 text-sm transition-colors hover:border-border hover:bg-muted/50',
            isTeamLead && 'bg-primary/5 hover:bg-primary/10',
            isSelected && 'border-border border-r-primary bg-muted hover:border-r-primary',
            isLaunchingChat && 'cursor-not-allowed opacity-50',
          )}
          role="listitem"
          aria-label={`Chat with ${agent.name}${isOnline ? ' (online)' : ' (offline)'}`}
          aria-current={isSelected ? 'true' : undefined}
          data-context-metrics-key={contextTrackingEnabled ? contextMetricsKey : undefined}
        >
          {providerIconUri ? (
            <span
              className={cn(
                'flex h-6 w-6 shrink-0 items-center justify-center rounded-md border transition-[border-color,background-color,box-shadow] duration-300',
                isOnline ? 'border-border bg-muted/40' : 'border-border/60 bg-muted/20',
                isOnline &&
                  activityState === 'busy' &&
                  'border-primary/60 bg-primary/10 shadow-[0_0_8px_hsl(var(--primary)/0.35)] animate-busy-halo',
              )}
              title={
                providerName
                  ? `Provider: ${providerName} (${isOnline ? 'online' : 'offline'})`
                  : undefined
              }
            >
              <img
                src={providerIconUri}
                className={cn(
                  'h-4 w-4 transition-[filter,opacity]',
                  !isOnline && 'grayscale opacity-50',
                )}
                aria-hidden="true"
                alt=""
              />
            </span>
          ) : (
            <Circle
              className={cn(
                'h-2 w-2 shrink-0 fill-current',
                isOnline ? 'text-green-500' : 'text-muted-foreground',
              )}
              aria-hidden="true"
            />
          )}
          <AgentIdentity
            agentName={agent.name}
            configDisplayName={configDisplayName}
            configDisplayTitle={configDisplayTitle}
            isTeamLead={isTeamLead}
            currentActivityTitle={
              isOnline && activityState === 'busy' ? currentActivityTitle : null
            }
          />
          {activityBadge && <span className="ml-1 shrink-0">{activityBadge}</span>}
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
        {canOverride && onOpenOverrides && (
          <ContextMenuItem
            onSelect={(event) => {
              event.preventDefault();
              onOpenOverrides(triggerRef.current);
            }}
            disabled={!hasSelectedProject || anyBusy}
          >
            <SlidersHorizontal className="mr-2 h-4 w-4" />
            Overrides…
          </ContextMenuItem>
        )}
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
