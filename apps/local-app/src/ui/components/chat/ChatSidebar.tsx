import { useCallback, useEffect, useMemo, useState } from 'react';
import { HelpButton } from '@/ui/components/shared';
import { Button } from '@/ui/components/ui/button';
import { Badge } from '@/ui/components/ui/badge';
import { ScrollArea } from '@/ui/components/ui/scroll-area';
import { Separator } from '@/ui/components/ui/separator';
import { Skeleton } from '@/ui/components/ui/skeleton';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/ui/components/ui/tooltip';
import { useQueries, useQuery } from '@tanstack/react-query';
import { PresetPopover } from './PresetPopover';
import { WorktreePresetButton } from './WorktreePresetButton';
import { restartKeyForMain, restartKeyForWorktree } from '@/ui/lib/restart-keys';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuCheckboxItem,
  ContextMenuLabel,
} from '@/ui/components/ui/context-menu';
import { cn } from '@/ui/lib/utils';
import {
  Plus,
  Circle,
  ChevronDown,
  ChevronRight,
  GitBranch,
  Users,
  User,
  MessageSquare,
  Loader2,
  RotateCcw,
  Play,
  Square,
  Power,
  AlertTriangle,
  Terminal,
  Box,
} from 'lucide-react';
import type { AgentPresenceMap } from '@/ui/lib/sessions';
import {
  useAgentSessionMetrics,
  getMetricsKey,
  type AgentSessionEntry,
} from '@/ui/hooks/useAgentSessionMetrics';
import { AgentContextBar } from './AgentContextBar';
import type { Thread } from '@/ui/lib/chat';
import type { AgentOrGuest } from '@/ui/hooks/useChatQueries';
import type { WorktreeAgentGroup } from '@/ui/hooks/useWorktreeAgents';
import type { PresetAvailability } from '@/ui/lib/preset-validation';
import { getProviderIconDataUri } from '@/ui/lib/providers';
import { providerModelQueryKeys } from '@/ui/lib/provider-model-query-keys';
import { shortModelName } from '@/ui/lib/model-utils';

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
  worktreeAgentGroups: WorktreeAgentGroup[];
  worktreeAgentGroupsLoading: boolean;
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
  selectedWorktreeAgent: { worktreeName: string; agentId: string } | null;
  hasSelectedProject: boolean;

  // Handlers
  onSelectThread: (threadId: string) => void;
  onLaunchChat: (agentIds: string[]) => void;
  onLaunchWorktreeAgentChat: (group: WorktreeAgentGroup, agentId: string) => void;
  onLaunchWorktreeSession: (group: WorktreeAgentGroup, agentId: string) => Promise<void>;
  onRestartWorktreeSession: (group: WorktreeAgentGroup, agentId: string) => Promise<void>;
  onTerminateWorktreeSession: (
    group: WorktreeAgentGroup,
    agentId: string,
    sessionId: string,
  ) => Promise<void>;
  onCreateGroup: () => void;
  onStartAllAgents: () => void;
  onTerminateAllConfirm: () => void;
  onLaunchSession: (agentId: string, options?: { attach?: boolean }) => Promise<unknown>;
  onRestartSession: (agentId: string) => Promise<void>;
  onTerminateConfirm: (agentId: string, sessionId: string) => void;

  // Provider lookup
  getProviderForAgent: (agentId: string | null | undefined) => string | null;

  // Pending restart state
  pendingRestartAgentIds: Set<string>;
  onMarkForRestart: (agentIds: string[]) => void;
  worktreeSessionActionsByAgentKey: Record<
    string,
    'launching' | 'restarting' | 'terminating' | undefined
  >;

  // Presets (validated with availability info)
  validatedPresets: PresetAvailability[];
  activePreset: string | null;
  onApplyPreset: (presetName: string) => void;
  applyingPreset: boolean;

  // Provider config switching
  onSwitchConfig: (
    agentId: string,
    providerConfigId: string,
    modelOverride?: string | null,
  ) => void;
  fetchProviderConfigsForProfile: (
    profileId: string,
  ) => Promise<Array<{ id: string; name: string; providerId: string }>>;
  updatingConfigAgentIds: Record<string, boolean>;

  // Worktree provider config switching
  onSwitchWorktreeConfig: (
    group: WorktreeAgentGroup,
    agentId: string,
    providerConfigId: string,
    modelOverride?: string | null,
  ) => void;
  updatingWorktreeConfigKey: string | null;

  // Mutation states
  createGroupPending: boolean;
}

// ============================================
// Component
// ============================================

// Provider config submenu component
interface ProviderConfigSubmenuProps {
  agent: AgentOrGuest;
  hasSelectedProject: boolean;
  isBusy: boolean;
  onRequestCloseMenu?: () => void;
  onSwitchConfig: (
    agentId: string,
    providerConfigId: string,
    modelOverride?: string | null,
  ) => void;
  fetchProviderConfigsForProfile: (
    profileId: string,
  ) => Promise<Array<{ id: string; name: string; providerId: string }>>;
  updatingConfigAgentIds: Record<string, boolean>;
  apiBase?: string;
}

interface ProviderModelOption {
  id: string;
  name: string;
}

interface ModelOverrideSubmenuProps {
  config: { id: string; name: string };
  providerModels: ProviderModelOption[];
  currentConfigId: string;
  currentModelOverride: string | null;
  isUpdating: boolean;
  onRequestCloseMenu?: () => void;
  onSelectModelOverride: (configId: string, nextModelOverride: string | null) => void;
}

const MODEL_OVERRIDE_DEFAULT = '__default_no_override__';
const MODEL_OVERRIDE_NONE_SELECTED = '__none_selected__';

export function normalizeModelOverrideSelection(value: string): string | null | undefined {
  if (value === MODEL_OVERRIDE_NONE_SELECTED) {
    return undefined;
  }
  if (value === MODEL_OVERRIDE_DEFAULT) {
    return null;
  }
  return value;
}

function getAgentConfigDisplayName(agent: AgentOrGuest): string | null {
  if (!agent.providerConfig?.name) {
    return null;
  }
  return agent.modelOverride ? shortModelName(agent.modelOverride) : agent.providerConfig.name;
}

function parseProviderModels(payload: unknown, providerId: string): ProviderModelOption[] {
  if (!Array.isArray(payload)) {
    return [];
  }

  return payload
    .map((rawModel, index) => {
      if (
        !rawModel ||
        typeof rawModel !== 'object' ||
        Array.isArray(rawModel) ||
        typeof (rawModel as { name?: unknown }).name !== 'string'
      ) {
        return null;
      }

      const model = rawModel as { id?: unknown; name: string };
      const name = model.name.trim();
      if (!name) {
        return null;
      }

      const id =
        typeof model.id === 'string' && model.id.trim().length > 0
          ? model.id
          : `${providerId}:${name}:${index}`;
      return { id, name };
    })
    .filter((model): model is ProviderModelOption => Boolean(model));
}

function ModelOverrideSubmenu({
  config,
  providerModels,
  currentConfigId,
  currentModelOverride,
  isUpdating,
  onRequestCloseMenu,
  onSelectModelOverride,
}: ModelOverrideSubmenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const requestCloseMenu = useCallback(() => {
    onRequestCloseMenu?.();
  }, [onRequestCloseMenu]);

  const activeModelValue =
    currentConfigId === config.id
      ? (currentModelOverride ?? MODEL_OVERRIDE_DEFAULT)
      : MODEL_OVERRIDE_NONE_SELECTED;

  return (
    <ContextMenuSub open={isOpen} onOpenChange={setIsOpen}>
      <ContextMenuSubTrigger
        disabled={isUpdating}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onSelectModelOverride(config.id, null);
          setIsOpen(false);
          requestCloseMenu();
        }}
      >
        {config.name}
      </ContextMenuSubTrigger>
      <ContextMenuSubContent className="w-[min(30rem,80vw)] p-0">
        <div className="border-b bg-popover px-2 py-2">
          <ContextMenuLabel className="px-0 py-0 text-xs font-medium text-muted-foreground">
            Override model:
          </ContextMenuLabel>
        </div>

        <div
          className="max-h-[min(400px,60vh)] overflow-y-auto p-1"
          data-testid={`model-override-options-${config.id}`}
        >
          <ContextMenuRadioGroup
            value={activeModelValue}
            onValueChange={(value) => {
              const nextModelOverride = normalizeModelOverrideSelection(value);
              if (nextModelOverride === undefined) return;
              onSelectModelOverride(config.id, nextModelOverride);
              requestCloseMenu();
            }}
          >
            <ContextMenuRadioItem value={MODEL_OVERRIDE_DEFAULT} disabled={isUpdating}>
              Default (no override)
            </ContextMenuRadioItem>
            {providerModels.map((model) => (
              <ContextMenuRadioItem
                key={model.id}
                value={model.name}
                title={model.name}
                disabled={isUpdating}
              >
                {shortModelName(model.name)}
              </ContextMenuRadioItem>
            ))}
          </ContextMenuRadioGroup>
        </div>
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}

function ProviderConfigSubmenu({
  agent,
  hasSelectedProject,
  isBusy,
  onRequestCloseMenu,
  onSwitchConfig,
  fetchProviderConfigsForProfile,
  updatingConfigAgentIds,
  apiBase,
}: ProviderConfigSubmenuProps) {
  // Skip guests - they don't have profiles
  if (!agent.profileId || agent.type === 'guest') {
    return null;
  }

  // Lazy fetch provider configs for this agent's profile
  //
  // PERF: No `enabled` gating needed here. Radix UI's ContextMenuSubContent uses
  // lazy mounting via the Presence component - this component only mounts when the
  // user opens the context menu (context.open === true), not during initial page render.
  // Therefore the useQuery only executes when the menu is opened, avoiding N API calls
  // on page load (one per agent row).
  //
  // Cached results are retained for 5 minutes via staleTime, so repeated menu opens
  // will use cached data instead of fetching again.
  const {
    data: rawConfigs = [],
    isLoading,
    isError,
  } = useQuery({
    queryKey: ['profile-provider-configs', apiBase ?? 'main', agent.profileId],
    queryFn: () => fetchProviderConfigsForProfile(agent.profileId!),
    staleTime: 5 * 60 * 1000, // Cache for 5 minutes
  });

  // Defensive guard: ensure configs is always an array (API returns array, but tests may mock incorrectly)
  const configs = Array.isArray(rawConfigs) ? rawConfigs : [];
  const uniqueProviderIds = useMemo(
    () =>
      Array.from(
        new Set(
          configs
            .map((config) => config.providerId)
            .filter((providerId): providerId is string => Boolean(providerId)),
        ),
      ).sort(),
    [configs],
  );

  const providerModelQueries = useQueries({
    queries: uniqueProviderIds.map((providerId) => ({
      queryKey: providerModelQueryKeys.byContext(apiBase ?? 'main', providerId),
      queryFn: async () => {
        const base = apiBase ?? '';
        const res = await fetch(`${base}/api/providers/${providerId}/models`);
        if (!res.ok) {
          return [] as ProviderModelOption[];
        }
        const payload = (await res.json().catch(() => [])) as unknown;
        return parseProviderModels(payload, providerId);
      },
      staleTime: 5 * 60 * 1000, // Cache for 5 minutes
    })),
  });

  const providerModelsStateByProviderId = useMemo(() => {
    const state: Record<string, { models: ProviderModelOption[]; isLoading: boolean }> = {};
    uniqueProviderIds.forEach((providerId, index) => {
      const query = providerModelQueries[index];
      state[providerId] = {
        models: Array.isArray(query?.data) ? query.data : [],
        isLoading: Boolean(query?.isLoading),
      };
    });
    return state;
  }, [providerModelQueries, uniqueProviderIds]);

  const currentConfigId = agent.providerConfigId ?? '';
  const currentModelOverride = agent.modelOverride ?? null;
  const isUpdating = updatingConfigAgentIds[agent.id];

  const handleConfigSwitch = (configId: string) => {
    if (configId !== currentConfigId) {
      onSwitchConfig(agent.id, configId);
    }
  };
  const requestCloseMenu = useCallback(() => {
    onRequestCloseMenu?.();
  }, [onRequestCloseMenu]);

  const handleModelOverrideSwitch = (configId: string, nextModelOverride: string | null) => {
    if (configId === currentConfigId && currentModelOverride === nextModelOverride) {
      return;
    }
    onSwitchConfig(agent.id, configId, nextModelOverride);
  };

  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger disabled={!hasSelectedProject || isBusy}>
        Provider Config
      </ContextMenuSubTrigger>
      <ContextMenuSubContent>
        {isLoading ? (
          <div className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            Loading configs...
          </div>
        ) : isError ? (
          <div className="px-2 py-1.5 text-sm text-destructive">Failed to load configs</div>
        ) : configs.length === 0 ? (
          <div className="px-2 py-1.5 text-sm text-muted-foreground">No configs available</div>
        ) : (
          <>
            {configs.map((config) => {
              const providerModelState = providerModelsStateByProviderId[config.providerId] ?? {
                models: [],
                isLoading: false,
              };
              const providerModels = providerModelState.models;
              const isProviderModelsLoading = providerModelState.isLoading;
              const hasModels = providerModels.length > 0;
              if (!hasModels || isProviderModelsLoading) {
                return (
                  <ContextMenuItem
                    key={config.id}
                    disabled={isUpdating}
                    onSelect={(event) => {
                      event.preventDefault();
                      handleConfigSwitch(config.id);
                      requestCloseMenu();
                    }}
                  >
                    {config.name}
                    {isProviderModelsLoading && <Loader2 className="ml-2 h-3 w-3 animate-spin" />}
                  </ContextMenuItem>
                );
              }

              return (
                <ModelOverrideSubmenu
                  key={config.id}
                  config={config}
                  providerModels={providerModels}
                  currentConfigId={currentConfigId}
                  currentModelOverride={currentModelOverride}
                  isUpdating={Boolean(isUpdating)}
                  onSelectModelOverride={handleModelOverrideSwitch}
                  onRequestCloseMenu={onRequestCloseMenu}
                />
              );
            })}
          </>
        )}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}

// ============================================
// Main ChatSidebar Component
// ============================================

export function ChatSidebar({
  agents,
  guests,
  worktreeAgentGroups,
  worktreeAgentGroupsLoading,
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
  selectedWorktreeAgent,
  hasSelectedProject,
  onSelectThread,
  onLaunchChat,
  onLaunchWorktreeAgentChat,
  onLaunchWorktreeSession,
  onRestartWorktreeSession,
  onTerminateWorktreeSession,
  onCreateGroup,
  onStartAllAgents,
  onTerminateAllConfirm,
  onLaunchSession,
  onRestartSession,
  onTerminateConfirm,
  getProviderForAgent,
  pendingRestartAgentIds,
  onMarkForRestart,
  worktreeSessionActionsByAgentKey,
  validatedPresets,
  activePreset,
  onApplyPreset,
  applyingPreset,
  onSwitchConfig,
  fetchProviderConfigsForProfile,
  updatingConfigAgentIds,
  onSwitchWorktreeConfig,
  updatingWorktreeConfigKey,
  createGroupPending,
}: ChatSidebarProps) {
  const groups = userThreads
    .filter((t) => t.isGroup)
    .map((g) => ({
      ...g,
      memberCount: g.members?.length ?? 0,
      name: g.title ?? 'Untitled Group',
    }));
  const [mainExpanded, setMainExpanded] = useState(() => {
    if (typeof window === 'undefined') return true;
    const stored = window.localStorage.getItem('devchain:chatSidebar:mainExpanded');
    return stored !== 'false';
  });
  const [collapsedWorktreeGroups, setCollapsedWorktreeGroups] = useState<Record<string, boolean>>(
    () => {
      if (typeof window === 'undefined') return {};
      try {
        const stored = window.localStorage.getItem('devchain:chatSidebar:worktreeGroups');
        return stored ? (JSON.parse(stored) as Record<string, boolean>) : {};
      } catch {
        return {};
      }
    },
  );

  useEffect(() => {
    setCollapsedWorktreeGroups((previous) => {
      const next = { ...previous };
      let changed = false;
      for (const group of worktreeAgentGroups) {
        const key = `worktree:${group.id}`;
        if (!(key in next)) {
          next[key] = false;
          changed = true;
        }
      }
      return changed ? next : previous;
    });
  }, [worktreeAgentGroups]);

  // Persist collapsed states to localStorage
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(
      'devchain:chatSidebar:mainExpanded',
      mainExpanded ? 'true' : 'false',
    );
  }, [mainExpanded]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(
      'devchain:chatSidebar:worktreeGroups',
      JSON.stringify(collapsedWorktreeGroups),
    );
  }, [collapsedWorktreeGroups]);

  // Per-agent context bar hidden set (persisted to localStorage)
  const [contextBarHidden, setContextBarHidden] = useState<Set<string>>(() => {
    if (typeof window === 'undefined') return new Set();
    try {
      const stored = window.localStorage.getItem('devchain:chatSidebar:contextBarHidden');
      return stored ? new Set(JSON.parse(stored) as string[]) : new Set();
    } catch {
      return new Set();
    }
  });
  const [mainContextMenuVersionByAgentId, setMainContextMenuVersionByAgentId] = useState<
    Record<string, number>
  >({});
  const [worktreeContextMenuVersionByKey, setWorktreeContextMenuVersionByKey] = useState<
    Record<string, number>
  >({});

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(
      'devchain:chatSidebar:contextBarHidden',
      JSON.stringify([...contextBarHidden]),
    );
  }, [contextBarHidden]);

  const handleToggleContextBar = useCallback((key: string) => {
    setContextBarHidden((previous) => {
      const next = new Set(previous);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const toggleWorktreeGroup = useCallback((groupId: string) => {
    const key = `worktree:${groupId}`;
    setCollapsedWorktreeGroups((previous) => ({
      ...previous,
      [key]: !previous[key],
    }));
  }, []);

  const formatWorktreeStatus = useCallback((status: string): string => {
    if (!status) {
      return 'Unknown';
    }
    return status.charAt(0).toUpperCase() + status.slice(1);
  }, []);

  const formatWorktreeRuntimeType = useCallback((runtimeType: string): string => {
    const normalized = runtimeType.trim().toLowerCase();
    if (normalized === 'process') {
      return 'Process';
    }
    if (normalized === 'container') {
      return 'Container';
    }
    if (!runtimeType) {
      return 'Container';
    }
    return runtimeType.charAt(0).toUpperCase() + runtimeType.slice(1);
  }, []);

  const renderActivityBadgeForPresence = useCallback((presence?: AgentPresenceMap[string]) => {
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
        <Badge className="shrink-0" aria-label={aria}>
          Busy {label}
        </Badge>
      );
    }

    if (activityState === 'idle') {
      return (
        <Badge variant="outline" className="shrink-0" aria-label="Idle">
          Idle
        </Badge>
      );
    }

    return null;
  }, []);

  const renderActivityBadge = (agentId: string) => {
    return renderActivityBadgeForPresence(agentPresence[agentId]);
  };

  const agentSessionEntries = useMemo(() => {
    const entries: AgentSessionEntry[] = [];
    for (const agent of agents) {
      const presence = agentPresence[agent.id];
      if (presence?.online && presence.sessionId) {
        entries.push({ agentId: agent.id, sessionId: presence.sessionId });
      }
    }
    for (const group of worktreeAgentGroups) {
      for (const agent of group.agents) {
        const presence = group.agentPresence[agent.id];
        if (presence?.online && presence.sessionId) {
          entries.push({
            agentId: agent.id,
            sessionId: presence.sessionId,
            apiBase: group.apiBase,
          });
        }
      }
    }
    return entries;
  }, [agents, agentPresence, worktreeAgentGroups]);

  const contextMetrics = useAgentSessionMetrics(agentSessionEntries);

  return (
    <div className="flex w-80 flex-col border-r bg-card">
      <div className="flex items-center justify-between gap-2 p-4 pb-2">
        <div className="flex items-center gap-1">
          <h2 className="text-xl font-bold">Chat</h2>
          <HelpButton featureId="chat" />
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            className="text-green-600 border-green-300 hover:bg-green-50 hover:text-green-700 hover:border-green-400 dark:text-green-500 dark:border-green-800 dark:hover:bg-green-950 dark:hover:text-green-400 dark:hover:border-green-600"
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
            variant="outline"
            size="sm"
            className="text-muted-foreground hover:bg-red-50 hover:text-red-600 hover:border-red-300 dark:hover:bg-red-950 dark:hover:text-red-400 dark:hover:border-red-700"
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
          <div className="mb-2 flex w-full items-center gap-1 rounded-md px-1 py-1">
            <button
              type="button"
              className="flex flex-1 items-center justify-between text-left hover:bg-muted/40 rounded-md px-0 py-0"
              onClick={() => setMainExpanded((previous) => !previous)}
              aria-expanded={mainExpanded}
              aria-controls="chat-main-agents"
            >
              <span className="text-sm font-semibold text-muted-foreground">MAIN AGENTS</span>
              {mainExpanded ? (
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              )}
            </button>
            <PresetPopover
              presets={validatedPresets}
              activePreset={activePreset}
              applying={applyingPreset}
              onApply={onApplyPreset}
              disabled={!hasSelectedProject}
            />
          </div>
          {mainExpanded && (
            <div
              id="chat-main-agents"
              className="space-y-1"
              role="list"
              aria-label="Direct messages"
            >
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
                  const isSelected = existingThread
                    ? selectedThreadId === existingThread.id
                    : false;

                  const agentProviderName = getProviderForAgent(agent.id);
                  const agentProviderIcon = agentProviderName
                    ? getProviderIconDataUri(agentProviderName)
                    : null;

                  const hasSession = Boolean(isOnline && agentPresence[agent.id]?.sessionId);
                  const sessionId = agentPresence[agent.id]?.sessionId ?? null;
                  const isLaunching = Boolean(launchingAgentIds[agent.id]);
                  const isRestarting = restartingAgentId === agent.id;
                  const anyBusy = isLaunching || isRestarting;
                  const mainContextMenuVersion = mainContextMenuVersionByAgentId[agent.id] ?? 0;

                  return (
                    <ContextMenu key={`${agent.id}:${mainContextMenuVersion}`}>
                      <ContextMenuTrigger asChild>
                        <button
                          onClick={() => onLaunchChat([agent.id])}
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
                          {agentProviderIcon && (
                            <img
                              src={agentProviderIcon}
                              className="h-4 w-4 flex-shrink-0"
                              aria-hidden="true"
                              title={`Provider: ${agentProviderName}`}
                              alt=""
                            />
                          )}
                          <div className="min-w-0 flex-1 overflow-hidden text-left">
                            <div className="truncate">
                              {agent.name}
                              {getAgentConfigDisplayName(agent) && (
                                <span className="text-muted-foreground">
                                  {' '}
                                  ({getAgentConfigDisplayName(agent)})
                                </span>
                              )}
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
                          {renderActivityBadge(agent.id)}
                          {pendingRestartAgentIds.has(restartKeyForMain(agent.id)) && isOnline && (
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
                      {contextMetrics.has(getMetricsKey(agent.id)) &&
                        !contextBarHidden.has(getMetricsKey(agent.id)) && (
                          <div className="px-3 -mt-0.5 pb-1">
                            <AgentContextBar {...contextMetrics.get(getMetricsKey(agent.id))!} />
                          </div>
                        )}
                      <ContextMenuContent className="w-56">
                        <ProviderConfigSubmenu
                          agent={agent}
                          hasSelectedProject={hasSelectedProject}
                          isBusy={anyBusy}
                          onSwitchConfig={onSwitchConfig}
                          onRequestCloseMenu={() => {
                            setMainContextMenuVersionByAgentId((previous) => ({
                              ...previous,
                              [agent.id]: (previous[agent.id] ?? 0) + 1,
                            }));
                          }}
                          fetchProviderConfigsForProfile={fetchProviderConfigsForProfile}
                          updatingConfigAgentIds={updatingConfigAgentIds}
                        />
                        <ContextMenuSeparator />
                        <ContextMenuCheckboxItem
                          checked={!contextBarHidden.has(getMetricsKey(agent.id))}
                          onCheckedChange={() => handleToggleContextBar(getMetricsKey(agent.id))}
                        >
                          Context tracking
                        </ContextMenuCheckboxItem>
                        <ContextMenuSeparator />
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
          )}
        </div>

        {/* Worktree Agent Groups */}
        {worktreeAgentGroupsLoading && (
          <>
            <Separator />
            <div className="space-y-3 px-4 py-4" aria-hidden>
              <Skeleton className="h-6 w-full" />
              <Skeleton className="h-6 w-full" />
            </div>
          </>
        )}
        {!worktreeAgentGroupsLoading && worktreeAgentGroups.length > 0 && (
          <>
            <Separator />
            <div className="space-y-2 px-4 py-4">
              <h3 className="text-sm font-semibold text-muted-foreground">WORKTREES</h3>
              {worktreeAgentGroups.map((group) => {
                const groupKey = `worktree:${group.id}`;
                const isExpanded = !collapsedWorktreeGroups[groupKey];
                const statusLabel = formatWorktreeStatus(group.status);
                const hasAgents = group.agents.length > 0;
                const isUnavailable = group.disabled || Boolean(group.error);
                const runtimeTypeLabel = formatWorktreeRuntimeType(group.runtimeType);

                return (
                  <div
                    key={group.id}
                    className="overflow-hidden rounded-md border border-border/80 bg-background/60"
                  >
                    <div className="flex w-full items-center gap-1 rounded-md px-3 py-2">
                      <button
                        type="button"
                        onClick={() => toggleWorktreeGroup(group.id)}
                        className="flex min-w-0 flex-1 items-center justify-between gap-2 text-left hover:bg-muted/40 rounded-md px-0 py-0"
                        aria-expanded={isExpanded}
                        aria-controls={`worktree-group-${group.id}`}
                      >
                        <span className="inline-flex min-w-0 items-center gap-2">
                          <GitBranch className="h-4 w-4 text-muted-foreground" />
                          <span className="truncate text-sm font-medium">{group.name}</span>
                        </span>
                        <TooltipProvider>
                          <span className="inline-flex shrink-0 items-center gap-1.5">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span
                                  className={cn(
                                    'inline-block h-2 w-2 shrink-0 rounded-full',
                                    isUnavailable ? 'bg-red-500' : 'bg-emerald-500',
                                  )}
                                  aria-label={statusLabel}
                                />
                              </TooltipTrigger>
                              <TooltipContent side="top">{statusLabel}</TooltipContent>
                            </Tooltip>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span
                                  className="inline-flex shrink-0 text-muted-foreground"
                                  aria-label={runtimeTypeLabel}
                                >
                                  {runtimeTypeLabel === 'Process' ? (
                                    <Terminal className="h-3.5 w-3.5" />
                                  ) : (
                                    <Box className="h-3.5 w-3.5" />
                                  )}
                                </span>
                              </TooltipTrigger>
                              <TooltipContent side="top">{runtimeTypeLabel}</TooltipContent>
                            </Tooltip>
                            {isExpanded ? (
                              <ChevronDown className="h-4 w-4 text-muted-foreground" />
                            ) : (
                              <ChevronRight className="h-4 w-4 text-muted-foreground" />
                            )}
                          </span>
                        </TooltipProvider>
                      </button>
                      <WorktreePresetButton group={group} onMarkForRestart={onMarkForRestart} />
                    </div>
                    {isExpanded && (
                      <div id={`worktree-group-${group.id}`} className="space-y-1 px-2 pb-2">
                        {group.error ? (
                          <p className="px-2 py-1 text-xs text-destructive">{group.error}</p>
                        ) : !hasAgents ? (
                          <p className="px-2 py-1 text-xs text-muted-foreground">
                            {isUnavailable ? 'Worktree unavailable.' : 'No agents found.'}
                          </p>
                        ) : (
                          group.agents.map((agent) => {
                            const isOnline = group.agentPresence[agent.id]?.online ?? false;
                            const sessionId = group.agentPresence[agent.id]?.sessionId ?? null;
                            const hasSession = Boolean(isOnline && sessionId);
                            const worktreeAgentKey = `${group.name}:${agent.id}`;
                            const worktreeBusyAction =
                              worktreeSessionActionsByAgentKey[worktreeAgentKey] ?? null;
                            const isLaunching = worktreeBusyAction === 'launching';
                            const isRestarting = worktreeBusyAction === 'restarting';
                            const isTerminating = worktreeBusyAction === 'terminating';
                            const anyWorktreeBusy = Boolean(worktreeBusyAction);
                            const isDisabled = isLaunchingChat || anyWorktreeBusy;
                            const isSelected =
                              selectedWorktreeAgent?.worktreeName === group.name &&
                              selectedWorktreeAgent?.agentId === agent.id;
                            const providerName =
                              getProviderForAgent(agent.id) ??
                              agent.providerConfig?.providerName ??
                              agent.providerConfig?.providerId ??
                              null;
                            const providerIcon = providerName
                              ? getProviderIconDataUri(providerName)
                              : null;
                            const worktreeContextMenuKey = `${group.apiBase}:${agent.id}`;
                            const worktreeContextMenuVersion =
                              worktreeContextMenuVersionByKey[worktreeContextMenuKey] ?? 0;
                            return (
                              <ContextMenu
                                key={`${group.id}:${agent.id}:${worktreeContextMenuVersion}`}
                              >
                                <ContextMenuTrigger asChild>
                                  <button
                                    onClick={() => onLaunchWorktreeAgentChat(group, agent.id)}
                                    disabled={isDisabled}
                                    className={cn(
                                      'flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-muted',
                                      isSelected && 'bg-secondary',
                                      isDisabled &&
                                        'cursor-not-allowed opacity-50 hover:bg-transparent',
                                    )}
                                    role="listitem"
                                    aria-label={`Open terminal for ${agent.name} in ${group.name}${isOnline ? ' (online)' : ' (offline)'}`}
                                    aria-current={isSelected ? 'true' : undefined}
                                  >
                                    <Circle
                                      className={cn(
                                        'h-2 w-2 fill-current',
                                        isOnline ? 'text-green-500' : 'text-muted-foreground',
                                      )}
                                      aria-hidden="true"
                                    />
                                    {providerIcon && (
                                      <img
                                        src={providerIcon}
                                        className="h-4 w-4 flex-shrink-0"
                                        aria-hidden="true"
                                        title={`Provider: ${providerName}`}
                                        alt=""
                                      />
                                    )}
                                    <span className="min-w-0 flex-1 truncate text-left">
                                      {agent.name}
                                      {getAgentConfigDisplayName(agent) && (
                                        <span className="text-muted-foreground">
                                          {' '}
                                          ({getAgentConfigDisplayName(agent)})
                                        </span>
                                      )}
                                    </span>
                                    {renderActivityBadgeForPresence(group.agentPresence[agent.id])}
                                    {pendingRestartAgentIds.has(
                                      restartKeyForWorktree(group.apiBase, agent.id),
                                    ) &&
                                      isOnline && (
                                        <TooltipProvider>
                                          <Tooltip>
                                            <TooltipTrigger asChild>
                                              <AlertTriangle className="ml-1 h-4 w-4 flex-shrink-0 text-yellow-500" />
                                            </TooltipTrigger>
                                            <TooltipContent>
                                              Restart to apply config changes
                                            </TooltipContent>
                                          </Tooltip>
                                        </TooltipProvider>
                                      )}
                                  </button>
                                </ContextMenuTrigger>
                                {contextMetrics.has(getMetricsKey(agent.id, group.apiBase)) &&
                                  !contextBarHidden.has(getMetricsKey(agent.id, group.apiBase)) && (
                                    <div className="px-3 -mt-0.5 pb-1">
                                      <AgentContextBar
                                        {...contextMetrics.get(
                                          getMetricsKey(agent.id, group.apiBase),
                                        )!}
                                      />
                                    </div>
                                  )}
                                <ContextMenuContent className="w-56">
                                  <ProviderConfigSubmenu
                                    agent={agent}
                                    hasSelectedProject={Boolean(group.devchainProjectId)}
                                    isBusy={anyWorktreeBusy}
                                    onSwitchConfig={(agentId, providerConfigId, modelOverride) =>
                                      onSwitchWorktreeConfig(
                                        group,
                                        agentId,
                                        providerConfigId,
                                        modelOverride,
                                      )
                                    }
                                    onRequestCloseMenu={() => {
                                      setWorktreeContextMenuVersionByKey((previous) => ({
                                        ...previous,
                                        [worktreeContextMenuKey]:
                                          (previous[worktreeContextMenuKey] ?? 0) + 1,
                                      }));
                                    }}
                                    fetchProviderConfigsForProfile={async (profileId) => {
                                      const res = await fetch(
                                        `${group.apiBase}/api/profiles/${profileId}/provider-configs`,
                                      );
                                      if (!res.ok)
                                        throw new Error('Failed to fetch provider configs');
                                      return res.json();
                                    }}
                                    updatingConfigAgentIds={
                                      updatingWorktreeConfigKey === `${group.apiBase}:${agent.id}`
                                        ? { [agent.id]: true }
                                        : {}
                                    }
                                    apiBase={group.apiBase}
                                  />
                                  <ContextMenuSeparator />
                                  <ContextMenuCheckboxItem
                                    checked={
                                      !contextBarHidden.has(getMetricsKey(agent.id, group.apiBase))
                                    }
                                    onCheckedChange={() =>
                                      handleToggleContextBar(getMetricsKey(agent.id, group.apiBase))
                                    }
                                  >
                                    Context tracking
                                  </ContextMenuCheckboxItem>
                                  <ContextMenuSeparator />
                                  <ContextMenuItem
                                    onSelect={async (event) => {
                                      event.preventDefault();
                                      await onRestartWorktreeSession(group, agent.id);
                                    }}
                                    disabled={isRestarting || !group.devchainProjectId}
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
                                        await onLaunchWorktreeSession(group, agent.id);
                                      }}
                                      disabled={isLaunching || !group.devchainProjectId}
                                    >
                                      {isLaunching ? (
                                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                      ) : (
                                        <Play className="mr-2 h-4 w-4" />
                                      )}
                                      Launch session
                                    </ContextMenuItem>
                                  )}
                                  {hasSession && sessionId && (
                                    <>
                                      <ContextMenuSeparator />
                                      <ContextMenuItem
                                        onSelect={async (event) => {
                                          event.preventDefault();
                                          await onTerminateWorktreeSession(
                                            group,
                                            agent.id,
                                            sessionId,
                                          );
                                        }}
                                        disabled={isTerminating || !group.devchainProjectId}
                                      >
                                        {isTerminating ? (
                                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                        ) : (
                                          <Power className="mr-2 h-4 w-4" />
                                        )}
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
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}

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
