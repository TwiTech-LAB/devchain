import { Button } from '@/ui/components/ui/button';
import { Badge } from '@/ui/components/ui/badge';
import { ScrollArea } from '@/ui/components/ui/scroll-area';
import { Separator } from '@/ui/components/ui/separator';
import { Skeleton } from '@/ui/components/ui/skeleton';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/ui/components/ui/context-menu';
import { cn } from '@/ui/lib/utils';
import {
  Plus,
  Circle,
  Users,
  User,
  MessageSquare,
  Loader2,
  RotateCcw,
  Play,
  Square,
  Power,
} from 'lucide-react';
import type { AgentPresenceMap } from '@/ui/lib/sessions';
import type { Thread } from '@/ui/lib/chat';
import type { AgentOrGuest } from '@/ui/hooks/useChatQueries';
import { getProviderIconDataUri } from '@/ui/lib/providers';

// ============================================
// Feature Flags
// ============================================

const CHAT_THREADS_ENABLED = false;

// ============================================
// Types
// ============================================

export interface ChatSidebarProps {
  // Data
  agents: AgentOrGuest[];
  guests: AgentOrGuest[];
  agentPresence: AgentPresenceMap;
  userThreads: Thread[];
  agentThreads: Thread[];
  presenceReady: boolean;
  offlineAgents: AgentOrGuest[];
  agentsWithSessions: AgentOrGuest[];

  // Loading states
  agentsLoading: boolean;
  agentsError: boolean;
  userThreadsLoading: boolean;
  agentThreadsLoading: boolean;
  launchingAgentIds: Record<string, boolean>;
  restartingAgentId: string | null;
  startingAll: boolean;
  terminatingAll: boolean;
  isLaunchingChat: boolean;

  // Selection
  selectedThreadId: string | null;
  hasSelectedProject: boolean;

  // Handlers
  onSelectThread: (threadId: string) => void;
  onLaunchChat: (agentIds: string[]) => void;
  onCreateGroup: () => void;
  onStartAllAgents: () => void;
  onTerminateAllConfirm: () => void;
  onLaunchSession: (agentId: string, options?: { attach?: boolean }) => Promise<unknown>;
  onRestartSession: (agentId: string) => Promise<void>;
  onTerminateConfirm: (agentId: string, sessionId: string) => void;

  // Provider lookup
  getProviderForAgent: (agentId: string | null | undefined) => string | null;

  // Mutation states
  createGroupPending: boolean;
}

// ============================================
// Component
// ============================================

export function ChatSidebar({
  agents,
  guests,
  agentPresence,
  userThreads,
  agentThreads,
  presenceReady,
  offlineAgents,
  agentsWithSessions,
  agentsLoading,
  agentsError,
  userThreadsLoading,
  agentThreadsLoading,
  launchingAgentIds,
  restartingAgentId,
  startingAll,
  terminatingAll,
  isLaunchingChat,
  selectedThreadId,
  hasSelectedProject,
  onSelectThread,
  onLaunchChat,
  onCreateGroup,
  onStartAllAgents,
  onTerminateAllConfirm,
  onLaunchSession,
  onRestartSession,
  onTerminateConfirm,
  getProviderForAgent,
  createGroupPending,
}: ChatSidebarProps) {
  const groups = userThreads
    .filter((t) => t.isGroup)
    .map((g) => ({
      ...g,
      memberCount: g.members?.length ?? 0,
      name: g.title ?? 'Untitled Group',
    }));

  const renderActivityBadge = (agentId: string) => {
    const presence = agentPresence[agentId];
    if (!presence?.online) return null;

    const activityState = presence.activityState ?? null;
    const busySince = presence.busySince ?? null;

    if (activityState === 'busy') {
      const since = busySince ? new Date(busySince).getTime() : Date.now();
      const ms = Math.max(0, Date.now() - since);
      const mins = Math.floor(ms / 60000);
      const secs = Math.floor((ms % 60000) / 1000);
      const label = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
      const aria = `Busy for ${label}`;
      return (
        <Badge className="ml-2" aria-label={aria}>
          Busy {label}
        </Badge>
      );
    }

    if (activityState === 'idle') {
      return (
        <Badge variant="outline" className="ml-2" aria-label="Idle">
          Idle
        </Badge>
      );
    }

    return null;
  };

  return (
    <div className="flex w-80 flex-col border-r bg-card">
      <div className="flex items-center justify-between p-4">
        <h2 className="text-xl font-bold">Chat</h2>
        <div className="inline-flex rounded-md border">
          <Button
            variant="ghost"
            size="sm"
            className="rounded-r-none border-r text-green-600 hover:bg-green-50 hover:text-green-700 dark:text-green-500 dark:hover:bg-green-950 dark:hover:text-green-400"
            onClick={onStartAllAgents}
            disabled={!presenceReady || offlineAgents.length === 0 || startingAll}
            title="Launch sessions for all offline agents"
          >
            {startingAll ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : (
              <Play className="mr-1 h-3 w-3" />
            )}
            Start{offlineAgents.length > 0 ? ` (${offlineAgents.length})` : ''}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="rounded-l-none text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={onTerminateAllConfirm}
            disabled={!presenceReady || agentsWithSessions.length === 0 || terminatingAll}
            title="Terminate all running sessions"
          >
            {terminatingAll ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : (
              <Square className="mr-1 h-3 w-3" />
            )}
            Stop{agentsWithSessions.length > 0 ? ` (${agentsWithSessions.length})` : ''}
          </Button>
        </div>
      </div>

      <ScrollArea className="flex-1">
        {/* Agents Section */}
        <div className="px-4 py-4">
          <div className="space-y-1" role="list" aria-label="Direct messages">
            {agentsLoading ? (
              <div className="space-y-2" aria-hidden>
                {Array.from({ length: 3 }).map((_, index) => (
                  <Skeleton key={index} className="h-8 w-full" />
                ))}
              </div>
            ) : agentsError ? (
              <p className="text-xs text-destructive">Failed to load agents. Please try again.</p>
            ) : agents.length === 0 ? (
              <p className="text-xs text-muted-foreground">No agents yet.</p>
            ) : (
              agents.map((agent) => {
                const isOnline = agentPresence[agent.id]?.online ?? false;
                const activityState = agentPresence[agent.id]?.activityState ?? null;
                const existingThread = userThreads.find(
                  (t) => !t.isGroup && t.members?.length === 1 && t.members[0] === agent.id,
                );
                const isSelected = existingThread ? selectedThreadId === existingThread.id : false;

                const agentProviderName = getProviderForAgent(agent.id);
                const agentProviderIcon = agentProviderName
                  ? getProviderIconDataUri(agentProviderName)
                  : null;

                const hasSession = Boolean(isOnline && agentPresence[agent.id]?.sessionId);
                const sessionId = agentPresence[agent.id]?.sessionId ?? null;
                const isLaunching = Boolean(launchingAgentIds[agent.id]);
                const isRestarting = restartingAgentId === agent.id;
                const anyBusy = isLaunching || isRestarting;

                return (
                  <ContextMenu key={agent.id}>
                    <ContextMenuTrigger asChild>
                      <button
                        onClick={() => onLaunchChat([agent.id])}
                        disabled={isLaunchingChat}
                        className={cn(
                          'flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-muted',
                          isSelected && 'bg-secondary',
                          isLaunchingChat && 'opacity-50 cursor-not-allowed',
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
                        {agentProviderIcon && (
                          <img
                            src={agentProviderIcon}
                            className="h-4 w-4 flex-shrink-0"
                            aria-hidden="true"
                            title={`Provider: ${agentProviderName}`}
                            alt=""
                          />
                        )}
                        <div className="flex-1 overflow-hidden text-left">
                          <div className="flex items-center gap-2">
                            <span className="truncate">{agent.name}</span>
                            {renderActivityBadge(agent.id)}
                          </div>
                          {isOnline &&
                            activityState === 'busy' &&
                            agentPresence[agent.id]?.currentActivityTitle && (
                              <div
                                className="truncate text-xs text-muted-foreground"
                                title={agentPresence[agent.id]?.currentActivityTitle || undefined}
                              >
                                {agentPresence[agent.id]?.currentActivityTitle}
                              </div>
                            )}
                        </div>
                      </button>
                    </ContextMenuTrigger>
                    <ContextMenuContent className="w-56">
                      {!hasSession && (
                        <ContextMenuItem
                          onSelect={async (e) => {
                            e.preventDefault();
                            await onLaunchSession(agent.id, { attach: false });
                          }}
                          disabled={isLaunching || !hasSelectedProject}
                        >
                          {isLaunching && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                          Launch session
                        </ContextMenuItem>
                      )}
                      <ContextMenuItem
                        onSelect={async (e) => {
                          e.preventDefault();
                          await onRestartSession(agent.id);
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
                      {hasSession && sessionId && (
                        <>
                          <ContextMenuSeparator />
                          <ContextMenuItem
                            onSelect={(e) => {
                              e.preventDefault();
                              onTerminateConfirm(agent.id, sessionId);
                            }}
                            disabled={anyBusy || !hasSelectedProject}
                          >
                            <Power className="mr-2 h-4 w-4" />
                            Terminate session
                          </ContextMenuItem>
                        </>
                      )}
                    </ContextMenuContent>
                  </ContextMenu>
                );
              })
            )}
          </div>
        </div>

        {/* Guests Section */}
        {guests.length > 0 && (
          <>
            <Separator />
            <div className="px-4 py-4">
              <div className="mb-2">
                <h3 className="text-sm font-semibold text-muted-foreground">GUESTS</h3>
              </div>
              <div className="space-y-1" role="list" aria-label="Guest agents">
                {guests.map((guest) => {
                  const isOnline = true;

                  return (
                    <button
                      key={guest.id}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-muted cursor-default',
                      )}
                      role="listitem"
                      aria-label={`Guest: ${guest.name}${isOnline ? ' (online)' : ' (offline)'}`}
                    >
                      <Circle
                        className={cn(
                          'h-2 w-2 fill-current',
                          isOnline ? 'text-green-500' : 'text-muted-foreground',
                        )}
                        aria-hidden="true"
                      />
                      <User
                        className="h-4 w-4 flex-shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                      <div className="flex-1 overflow-hidden text-left">
                        <div className="flex items-center gap-2">
                          <span className="truncate">{guest.name}</span>
                          <Badge
                            variant="outline"
                            className="text-[10px] uppercase"
                            aria-label="Guest type"
                          >
                            Guest
                          </Badge>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </>
        )}

        <Separator />

        {CHAT_THREADS_ENABLED && (
          <>
            {/* Groups Section */}
            <div className="px-4 py-4">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-muted-foreground">GROUPS</h3>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onCreateGroup}
                  className="h-6 w-6 p-0"
                  aria-label="Create new group"
                  disabled={agents.length < 2 || createGroupPending}
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
              <div className="space-y-1" role="list" aria-label="Group chats">
                {userThreadsLoading ? (
                  <div className="space-y-2" aria-hidden>
                    {Array.from({ length: 2 }).map((_, index) => (
                      <Skeleton key={index} className="h-8 w-full" />
                    ))}
                  </div>
                ) : groups.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No group threads yet.</p>
                ) : (
                  groups.map((group) => (
                    <button
                      key={group.id}
                      onClick={() => onSelectThread(group.id)}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-muted',
                        selectedThreadId === group.id && 'bg-secondary',
                      )}
                      role="listitem"
                      aria-label={`${group.name} group with ${group.memberCount} members`}
                      aria-current={selectedThreadId === group.id ? 'true' : undefined}
                    >
                      <Users className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                      <span className="flex-1 truncate text-left">{group.name}</span>
                      <Badge
                        variant="secondary"
                        className="text-xs"
                        aria-label={`${group.memberCount} members`}
                      >
                        {group.memberCount}
                      </Badge>
                    </button>
                  ))
                )}
              </div>
            </div>

            <Separator />

            {/* Agent Threads Section */}
            <div className="px-4 py-4">
              <div className="mb-2">
                <h3 className="text-sm font-semibold text-muted-foreground">AGENT THREADS</h3>
                <p className="text-xs text-muted-foreground">Read-only agent conversations</p>
              </div>
              <div className="space-y-1" role="list" aria-label="Agent-initiated threads">
                {agentThreadsLoading ? (
                  <div className="space-y-2" aria-hidden>
                    {Array.from({ length: 2 }).map((_, index) => (
                      <Skeleton key={index} className="h-6 w-full" />
                    ))}
                  </div>
                ) : agentThreads.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No agent-initiated threads.</p>
                ) : (
                  agentThreads.map((thread) => (
                    <button
                      key={thread.id}
                      onClick={() => onSelectThread(thread.id)}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-muted',
                        selectedThreadId === thread.id && 'bg-secondary',
                      )}
                      role="listitem"
                      aria-label={`${thread.title || 'Agent Thread'} with ${thread.members?.length ?? 0} agents`}
                      aria-current={selectedThreadId === thread.id ? 'true' : undefined}
                    >
                      <MessageSquare className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                      <span className="flex-1 truncate text-left text-xs">
                        {thread.title || 'Agent Thread'}
                      </span>
                      <Badge
                        variant="outline"
                        className="text-xs"
                        aria-label={`${thread.members?.length ?? 0} agents`}
                      >
                        {thread.members?.length ?? 0}
                      </Badge>
                    </button>
                  ))
                )}
              </div>
            </div>
          </>
        )}
      </ScrollArea>
    </div>
  );
}
