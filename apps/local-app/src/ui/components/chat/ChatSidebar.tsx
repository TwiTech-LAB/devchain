import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react';
import { HelpButton } from '@/ui/components/shared';
import { Button } from '@/ui/components/ui/button';
import { Badge } from '@/ui/components/ui/badge';
import { ScrollArea } from '@/ui/components/ui/scroll-area';
import { Separator } from '@/ui/components/ui/separator';
import { Skeleton } from '@/ui/components/ui/skeleton';
import { useToast } from '@/ui/hooks/use-toast';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { PresetPopover } from './PresetPopover';
import { AgentRow } from './AgentRow';
import { restartKeyForMain } from '@/ui/lib/restart-keys';
import { AgentOverridesDialog, type AgentOverridesSavePayload } from './AgentOverridesDialog';
import { cn } from '@/ui/lib/utils';
import {
  Circle,
  ChevronDown,
  ChevronRight,
  UsersRound,
  Users,
  User,
  Loader2,
  Play,
  Square,
} from 'lucide-react';
import type { AgentPresenceMap } from '@/ui/lib/sessions';
import {
  useAgentSessionMetrics,
  getMetricsKey,
  type AgentSessionEntry,
} from '@/ui/hooks/useAgentSessionMetrics';
import { chatQueryKeys, type AgentOrGuest } from '@/ui/hooks/useChatQueries';
import { agentQueryKeys } from '@/ui/lib/agents';
import { compareCanonicalAgents } from '@/ui/lib/agent-ordering';
import type { PresetAvailability } from '@/ui/lib/preset-validation';
import { getProviderIconDataUri } from '@/ui/lib/providers';
import { shortModelName } from '@/ui/lib/model-utils';
import { fetchTeamDetail, fetchTeams, teamsQueryKeys, type TeamDetail } from '@/ui/lib/teams';
import { TeamQuickAddButton } from './TeamQuickAddButton';
import { TeamStatusDots } from './TeamStatusDots';
import { formatBusyDuration } from './team-status-dots';
import {
  AgentEventBus,
  useAgentEventBusAnchor,
  type AgentEventBusAnchorDescriptor,
} from './agent-event-bus';
import { useFetchFactory } from '@/ui/hooks/useFetchFactory';
import {
  getTeamMembers,
  hasActiveMember,
  isTeamCollapsed,
  loadTeamFoldOverrides,
  saveTeamFoldOverride,
  type TeamFoldOverride,
  type TeamFoldOverrides,
} from './team-fold';

function formatSectionCount(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

// ============================================
// Types
// ============================================

/**
 * Read-only view state the sidebar renders from. Grouping by change-cadence
 * (data vs. controllers vs. admin actions) lets ChatPage memoize each bundle
 * independently so a change to one does not force the others — and, with the
 * memoized `ChatSidebar`, keeps the AgentRow subtree from re-rendering when an
 * unrelated ChatPage state ticks. Referential stability of these bundles is a
 * behavior contract, not an optimization.
 */
export interface ChatSidebarData {
  projectId: string | null;
  agents: AgentOrGuest[];
  guests: AgentOrGuest[];
  agentPresence: AgentPresenceMap;
  presenceReady: boolean;
  /** See `UseChatQueriesResult.presenceSettled`; gates deletion of saved team folds. */
  presenceSettled: boolean;
  offlineAgents: AgentOrGuest[];
  agentsWithSessions: AgentOrGuest[];
  agentsLoading: boolean;
  agentsError: boolean;
  selectedAgentId: string | null;
  hasSelectedProject: boolean;
  getProviderForAgent: (agentId: string | null | undefined) => string | null;
  validatedPresets: PresetAvailability[];
  activePreset: string | null;
  projectProfiles?: Array<{ id: string; name: string }>;
  /**
   * Positive human-held message counts keyed by main-project agent id. An absent
   * agent has nothing held. Guest rows never read this map — the counts describe
   * the root project's pools only.
   */
  humanHeldMessageCounts?: Record<string, number>;
  /** Agents whose informational waiting badge may now release the held lane. */
  humanHeldReleaseEligibleAgentIds?: Record<string, true>;
  /** Agents whose deferred lane is eligible for force delivery. */
  forceEligibleAgentIds?: Record<string, true>;
  /** Hold-reason labels for non-draft deferred lanes before force threshold. */
  holdReasonLabels?: Record<string, string>;
  /**
   * Whole settled-but-unlogged minutes keyed by main-project agent id. Only
   * whole minutes appear; guests never read this map — the read describes the
   * root project's buffers only.
   */
  unloggedTimeMinutes?: Record<string, number>;
}

/**
 * Session lifecycle + preset/config controllers and their pending state. Sourced
 * from Task 7's lifecycle core/adapters and the preset/config domain hooks; the
 * handlers are stable useCallbacks, so this bundle only changes when a pending
 * flag flips.
 */
export interface ChatSidebarSessionController {
  launchingAgentIds: Record<string, boolean>;
  restartingAgentId: string | null;
  startingAll: boolean;
  terminatingAll: boolean;
  onSelectAgent: (agentId: string) => void;
  onStartAllAgents: () => void;
  onTerminateAllConfirm: () => void;
  onLaunchSession: (agentId: string, options?: { attach?: boolean }) => Promise<unknown>;
  onRestartSession: (agentId: string) => Promise<void>;
  onTerminateConfirm: (agentId: string, sessionId: string) => void;
  onReleaseHeldMessages: (agentId: string) => void;
  releasingHeldAgentId: string | null;
  onForceDelivery: (agentId: string) => void;
  forcingAgentId: string | null;
  pendingRestartAgentIds: Set<string>;
  onApplyPreset: (presetName: string) => void;
  applyingPreset: boolean;
  // Single call carries config + model + effort overrides
  onSwitchConfig: (
    agentId: string,
    providerConfigId: string,
    modelOverride?: string | null,
    effortOverride?: string | null,
  ) => Promise<unknown> | void;
  updatingConfigAgentIds: Record<string, boolean>;
}

/** Agent admin actions (clone / delete / quick-add / edit-team) and their pending state. */
export interface ChatSidebarAdminActions {
  onCloneAgent?: (
    agent: AgentOrGuest,
    context?: { teamId: string; teamName: string; isTeamLead: boolean },
  ) => void;
  onDeleteAgent?: (agent: AgentOrGuest) => void;
  /** Disable asks for confirmation itself when the agent has a running session. */
  onDisableAgent?: (agent: AgentOrGuest) => void;
  onEnableAgent?: (agent: AgentOrGuest) => void;
  pendingDeleteAgentId?: string | null;
  onAddTeamAgent?: (payload: import('./TeamQuickAddButton').QuickAddPayload) => void;
  onEditTeam?: (payload: {
    teamId: string;
    teamName: string;
    maxMembers: number;
    maxConcurrentTasks: number;
    allowTeamLeadCreateAgents: boolean;
  }) => void;
}

export interface ChatSidebarProps {
  data: ChatSidebarData;
  sessionController: ChatSidebarSessionController;
  adminActions: ChatSidebarAdminActions;
}

interface EventBusAgentRowProps extends ComponentProps<typeof AgentRow> {
  eventBusAnchor: AgentEventBusAnchorDescriptor;
}

/** Canonical order with disabled agents after enabled ones. */
function compareEnabledFirst(left: AgentOrGuest, right: AgentOrGuest): number {
  const disabledOrder = Number(left.disabled === true) - Number(right.disabled === true);
  return disabledOrder !== 0 ? disabledOrder : compareCanonicalAgents(left, right);
}

function EventBusAgentRow({ eventBusAnchor, ...props }: EventBusAgentRowProps) {
  const anchorRef = useAgentEventBusAnchor(eventBusAnchor);
  return <AgentRow {...props} eventBusAnchor={eventBusAnchor} anchorRef={anchorRef} />;
}

// ============================================
// Component
// ============================================

// ============================================
// Agent row config / override label
// ============================================

interface AgentConfigDisplay {
  /** Short label rendered in the row (e.g. "opus · high"). */
  label: string;
  /** Full-detail tooltip (e.g. "model: anthropic/opus · effort: high"). */
  title: string;
}

/**
 * Row secondary label. When the agent has a model and/or effort override, show
 * the short model name joined with the effort ("model · effort"); otherwise fall
 * back to the provider config name. Returns null when there is nothing to show.
 */
function getAgentConfigDisplay(agent: AgentOrGuest): AgentConfigDisplay | null {
  const modelOverride = agent.modelOverride ?? null;
  const effortOverride = agent.effortOverride ?? null;

  if (modelOverride || effortOverride) {
    const labelParts = [
      modelOverride ? shortModelName(modelOverride) : null,
      effortOverride,
    ].filter((part): part is string => Boolean(part));
    const titleParts: string[] = [];
    if (modelOverride) titleParts.push(`model: ${modelOverride}`);
    if (effortOverride) titleParts.push(`effort: ${effortOverride}`);
    return { label: labelParts.join(' · '), title: titleParts.join(' · ') };
  }

  if (!agent.providerConfig?.name) {
    return null;
  }
  return { label: agent.providerConfig.name, title: agent.providerConfig.name };
}

// ============================================
// Main ChatSidebar Component
// ============================================

function ChatSidebarInner({ data, sessionController, adminActions }: ChatSidebarProps) {
  const fetchFn = useFetchFactory();
  const queryClient = useQueryClient();
  const {
    projectId,
    agents,
    guests,
    agentPresence,
    presenceReady,
    presenceSettled,
    offlineAgents,
    agentsWithSessions,
    agentsLoading,
    agentsError,
    selectedAgentId,
    hasSelectedProject,
    getProviderForAgent,
    validatedPresets,
    activePreset,
    projectProfiles,
    humanHeldMessageCounts,
    humanHeldReleaseEligibleAgentIds,
    forceEligibleAgentIds,
    holdReasonLabels,
    unloggedTimeMinutes,
  } = data;
  const {
    launchingAgentIds,
    restartingAgentId,
    startingAll,
    terminatingAll,
    onSelectAgent,
    onStartAllAgents,
    onTerminateAllConfirm,
    onLaunchSession,
    onRestartSession,
    onTerminateConfirm,
    onReleaseHeldMessages,
    releasingHeldAgentId,
    onForceDelivery,
    forcingAgentId,
    pendingRestartAgentIds,
    onApplyPreset,
    applyingPreset,
    onSwitchConfig,
    updatingConfigAgentIds,
  } = sessionController;
  const {
    onCloneAgent,
    onDeleteAgent,
    onDisableAgent,
    onEnableAgent,
    pendingDeleteAgentId,
    onAddTeamAgent,
    onEditTeam,
  } = adminActions;

  const { toast } = useToast();

  // ── Overrides dialog (single themed dialog replacing the model-override submenu) ──
  const [overridesTarget, setOverridesTarget] = useState<{
    agent: AgentOrGuest;
    isOnline: boolean;
    triggerEl: HTMLElement | null;
  } | null>(null);

  const closeOverrides = useCallback(() => {
    setOverridesTarget(null);
  }, []);

  const [teamFoldOverrides, setTeamFoldOverrides] =
    useState<TeamFoldOverrides>(loadTeamFoldOverrides);

  const shouldFetchTeams = Boolean(projectId);
  const {
    data: teamsResponse,
    isLoading: teamsListLoading,
    isSuccess: teamsListSuccess,
    isFetching: teamsListFetching,
    isError: teamsListError,
    error: teamsListErrorValue,
  } = useQuery({
    queryKey: projectId ? teamsQueryKeys.teams(projectId) : ['teams', 'no-project'],
    queryFn: () => fetchTeams(projectId!, fetchFn),
    enabled: shouldFetchTeams,
    refetchOnWindowFocus: true,
  });
  const teams = useMemo(() => teamsResponse?.items ?? [], [teamsResponse]);

  const teamDetailQueries = useQueries({
    queries: shouldFetchTeams
      ? teams.map((team) => ({
          queryKey: teamsQueryKeys.detail(team.id),
          queryFn: () => fetchTeamDetail(team.id, fetchFn),
          refetchOnWindowFocus: true,
        }))
      : [],
  });

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
  const sidebarRef = useRef<HTMLDivElement>(null);
  const mainAgentsContainerRef = useRef<HTMLDivElement>(null);
  const [visibleContextKeys, setVisibleContextKeys] = useState<Set<string>>(() => new Set());
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

  const renderActivityBadgeForPresence = useCallback((presence?: AgentPresenceMap[string]) => {
    if (!presence?.online) return null;

    const activityState = presence.activityState ?? null;
    const busySince = presence.busySince ?? null;

    if (activityState === 'busy') {
      const label = formatBusyDuration(busySince, Date.now());
      const aria = `Busy for ${label}`;
      return (
        <span
          className="inline-flex h-4 shrink-0 items-center rounded-full border border-primary/40 bg-primary/10 px-1.5 text-[10px] font-medium leading-none text-primary"
          aria-label={aria}
        >
          {label}
        </span>
      );
    }

    return null;
  }, []);

  const renderActivityBadge = (agentId: string) => {
    return renderActivityBadgeForPresence(agentPresence[agentId]);
  };

  const teamsFirstLoad =
    shouldFetchTeams && (teamsListLoading || teamDetailQueries.some((query) => query.isLoading));
  const teamDetailError = teamDetailQueries.find((query) => query.isError)?.error;
  const teamsViewError = teamsListError || Boolean(teamDetailError);
  const showTeamsView = !teamsViewError && teams.length > 0;
  const teamsViewErrorHandledRef = useRef(false);

  useEffect(() => {
    if (!teamsViewError) {
      teamsViewErrorHandledRef.current = false;
      return;
    }
    if (teamsViewErrorHandledRef.current) {
      return;
    }
    teamsViewErrorHandledRef.current = true;
    const message =
      teamsListErrorValue instanceof Error
        ? teamsListErrorValue.message
        : teamDetailError instanceof Error
          ? teamDetailError.message
          : 'Teams could not be loaded.';
    toast({
      title: 'Unable to load teams view',
      description: `${message} Showing the agent list without teams.`,
      variant: 'destructive',
    });
  }, [teamDetailError, teamsListErrorValue, teamsViewError, toast]);

  const teamDetailsById = useMemo(() => {
    const map = new Map<string, TeamDetail>();
    teams.forEach((team, index) => {
      const detail = teamDetailQueries[index]?.data;
      if (detail) {
        map.set(team.id, detail);
      }
    });
    return map;
  }, [teamDetailQueries, teams]);

  const canonicalAgents = useMemo(() => [...agents].sort(compareCanonicalAgents), [agents]);
  const canonicalGuests = useMemo(() => [...guests].sort(compareCanonicalAgents), [guests]);

  const agentsById = useMemo(
    () => new Map(canonicalAgents.map((agent) => [agent.id, agent])),
    [canonicalAgents],
  );

  const teamSections = useMemo(() => {
    const teamMembership = new Set<string>();
    const items = teams
      .map((team) => {
        const detail = teamDetailsById.get(team.id);
        if (!detail || detail.members.length === 0) {
          return null;
        }
        const sectionAgents = detail.members
          .map((member) => agentsById.get(member.agentId))
          .filter((agent): agent is AgentOrGuest => Boolean(agent))
          .sort(compareEnabledFirst);
        if (sectionAgents.length === 0) {
          return null;
        }
        sectionAgents.forEach((agent) => {
          teamMembership.add(agent.id);
        });
        return {
          team,
          detail,
          agents: sectionAgents,
          lead: sectionAgents.find((agent) => agent.id === detail.teamLeadAgentId) ?? null,
          members: getTeamMembers(sectionAgents, detail.teamLeadAgentId),
        };
      })
      .filter(
        (
          section,
        ): section is {
          team: (typeof teams)[number];
          detail: TeamDetail;
          agents: AgentOrGuest[];
          lead: AgentOrGuest | null;
          members: AgentOrGuest[];
        } => Boolean(section),
      );

    return {
      items,
      noTeamAgents: canonicalAgents
        .filter((agent) => !teamMembership.has(agent.id))
        .sort(compareCanonicalAgents),
    };
  }, [agentsById, canonicalAgents, teamDetailsById, teams]);

  // The team view waits for presence so teams never render open and then fold.
  // The flat list never waits for it.
  const listReady =
    !agentsLoading && !agentsError && !teamsFirstLoad && (!showTeamsView || presenceReady);

  // An agent that leads any team cannot be disabled, also on its member rows in other teams.
  const teamLeadIds = useMemo(() => {
    const ids = new Set<string>();
    for (const team of teams) if (team.teamLeadAgentId) ids.add(team.teamLeadAgentId);
    for (const detail of teamDetailsById.values()) {
      if (detail.teamLeadAgentId) ids.add(detail.teamLeadAgentId);
    }
    return ids;
  }, [teams, teamDetailsById]);

  const teamFold = useMemo(() => {
    const byTeamId = new Map<string, { hasActive: boolean; isExpanded: boolean }>();
    for (const { team, members } of teamSections.items) {
      // The roster can mark an agent disabled before presence drops its last online record.
      const hasActive = hasActiveMember(
        members.filter((member) => !member.disabled),
        agentPresence,
      );
      byTeamId.set(team.id, {
        hasActive,
        isExpanded: !isTeamCollapsed(hasActive, teamFoldOverrides[team.id]),
      });
    }
    return byTeamId;
  }, [agentPresence, teamFoldOverrides, teamSections]);

  // Rows in render order. The string form changes only when the set of mounted
  // row elements changes, not on every presence poll. A team row's key carries
  // its place in the team (lead header, member list, or list of a team with no
  // lead): a lead change remounts the rows in a new place with the same ids.
  // Every key also marks a disabled row, whose element is not a metrics target;
  // Enable gives the row one.
  const renderedRows = useMemo(() => {
    const metricsMark = (agent: AgentOrGuest) => (agent.disabled ? ':disabled' : '');
    const rows: Array<{ key: string; agentId: string }> = [];
    if (!listReady) return rows;
    if (!showTeamsView) {
      canonicalAgents.forEach((agent) =>
        rows.push({ key: `all:${agent.id}${metricsMark(agent)}`, agentId: agent.id }),
      );
      return rows;
    }
    for (const { team, agents: teamAgents, lead } of teamSections.items) {
      const isExpanded = teamFold.get(team.id)?.isExpanded ?? false;
      for (const agent of teamAgents) {
        const isLead = agent.id === lead?.id;
        if (isExpanded || isLead) {
          const place = isLead ? 'lead' : lead ? 'member' : 'no-lead';
          rows.push({
            key: `${team.id}:${agent.id}:${place}${metricsMark(agent)}`,
            agentId: agent.id,
          });
        }
      }
    }
    teamSections.noTeamAgents.forEach((agent) =>
      rows.push({ key: `no-team:${agent.id}${metricsMark(agent)}`, agentId: agent.id }),
    );
    return rows;
  }, [canonicalAgents, listReady, showTeamsView, teamFold, teamSections]);
  const renderedRowsKey = renderedRows.map((row) => row.key).join('|');

  const teamDataSettled =
    teamsListSuccess &&
    !teamsListFetching &&
    teamDetailQueries.every((query) => query.isSuccess && !query.isFetching);

  // Update counts that an expiry must exceed for presence and for the roster:
  // each count when the team data last changed, plus one if a request was in
  // flight then. `rosterRefreshAt` is the presence count at the last roster
  // refresh that the expiry asked for: at most one per presence response.
  const expiryFreshnessRef = useRef<{
    teamData: string;
    presenceCount: number;
    rosterCount: number;
    rosterRefreshAt: number | null;
  } | null>(null);

  // An override ends once the team's activity differs from when it was set.
  // Judge that only on a successful, settled snapshot of presence, roster and
  // teams: a failed presence load reads as "everyone offline". Presence and
  // the roster arrive as props, so they can commit apart from the team queries
  // here; the cache checks reject props that are pending or differ from the
  // cache. Team data refetches on its own (on focus), so presence and roster
  // count only when requested after the latest team data arrived. Presence
  // polls; the roster does not, so an expiry that waits on it refreshes it.
  useEffect(() => {
    if (!projectId) return;
    const presenceKey = chatQueryKeys.agentPresence(projectId);
    const rosterKey = agentQueryKeys.withGuests(projectId);
    const presenceState = queryClient.getQueryState(presenceKey);
    const rosterState = queryClient.getQueryState(rosterKey);
    const countAfter = (state: { dataUpdateCount: number; fetchStatus: string } | undefined) =>
      (state?.dataUpdateCount ?? 0) + (state?.fetchStatus === 'fetching' ? 1 : 0);
    const teamData = [
      queryClient.getQueryState(teamsQueryKeys.teams(projectId))?.dataUpdateCount ?? 0,
      ...teams.map(
        (team) =>
          `${team.id}:${queryClient.getQueryState(teamsQueryKeys.detail(team.id))?.dataUpdateCount ?? 0}`,
      ),
    ].join('|');
    if (expiryFreshnessRef.current?.teamData !== teamData) {
      expiryFreshnessRef.current = {
        teamData,
        presenceCount: countAfter(presenceState),
        rosterCount: countAfter(rosterState),
        rosterRefreshAt: null,
      };
    }
    const freshness = expiryFreshnessRef.current;

    if (!listReady || !showTeamsView || !presenceSettled || !teamDataSettled) return;
    const presenceCount = presenceState?.dataUpdateCount ?? 0;
    if (
      presenceCount <= freshness.presenceCount ||
      queryClient.isFetching({ queryKey: presenceKey }) > 0 ||
      queryClient.isFetching({ queryKey: rosterKey }) > 0 ||
      queryClient.getQueryData(presenceKey) !== agentPresence
    ) {
      return;
    }
    const expired = new Map<string, TeamFoldOverride>();
    for (const [teamId, fold] of teamFold) {
      const override = teamFoldOverrides[teamId];
      if (override && override.whenActive !== fold.hasActive) expired.set(teamId, override);
    }
    if (expired.size === 0) return;

    // A roster whose latest request failed still shows its cached rows; it needs
    // a successful refresh before an expiry, whatever its earlier update count.
    if (
      rosterState?.status === 'error' ||
      (rosterState?.dataUpdateCount ?? 0) <= freshness.rosterCount
    ) {
      if (freshness.rosterRefreshAt !== presenceCount) {
        freshness.rosterRefreshAt = presenceCount;
        void queryClient.refetchQueries({ queryKey: rosterKey, exact: true, type: 'active' });
      }
      return;
    }
    const roster = queryClient.getQueryData<{ items?: AgentOrGuest[] }>(rosterKey)?.items ?? [];
    const rosterAgents = roster.filter((item) => item.type !== 'guest');
    if (
      rosterAgents.length !== agentsById.size ||
      rosterAgents.some((agent) => !agentsById.has(agent.id))
    ) {
      return;
    }

    expired.forEach((_, teamId) => saveTeamFoldOverride(teamId, null));
    setTeamFoldOverrides((previous) => {
      const next = { ...previous };
      expired.forEach((override, teamId) => {
        if (next[teamId] === override) delete next[teamId];
      });
      return next;
    });
  }, [
    agentPresence,
    agentsById,
    listReady,
    presenceSettled,
    projectId,
    queryClient,
    showTeamsView,
    teamDataSettled,
    teamFold,
    teamFoldOverrides,
    teams,
  ]);

  const toggleTeamFold = useCallback((teamId: string, override: TeamFoldOverride) => {
    saveTeamFoldOverride(teamId, override);
    setTeamFoldOverrides((previous) => ({ ...previous, [teamId]: override }));
  }, []);

  useEffect(() => {
    const root = sidebarRef.current;
    if (!root) return;
    const elements = Array.from(root.querySelectorAll<HTMLElement>('[data-context-metrics-key]'));
    const candidateKeys = new Set(
      elements
        .map((element) => element.dataset.contextMetricsKey)
        .filter((key): key is string => Boolean(key)),
    );

    if (typeof IntersectionObserver === 'undefined') {
      setVisibleContextKeys((previous) => {
        if (
          candidateKeys.size === previous.size &&
          [...candidateKeys].every((key) => previous.has(key))
        ) {
          return previous;
        }
        return candidateKeys;
      });
      return;
    }

    setVisibleContextKeys((previous) => {
      const next = new Set([...previous].filter((key) => candidateKeys.has(key)));
      if (next.size === previous.size && [...next].every((key) => previous.has(key))) {
        return previous;
      }
      return next;
    });

    const intersectingElements = new Set<Element>();
    const observer = new IntersectionObserver((observations) => {
      for (const observation of observations) {
        if (observation.isIntersecting) intersectingElements.add(observation.target);
        else intersectingElements.delete(observation.target);
      }
      setVisibleContextKeys((previous) => {
        const next = new Set<string>();
        for (const element of intersectingElements) {
          const key = (element as HTMLElement).dataset.contextMetricsKey;
          if (key) next.add(key);
        }
        if (next.size === previous.size && [...next].every((key) => previous.has(key))) {
          return previous;
        }
        return next;
      });
    });
    elements.forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [contextBarHidden, renderedRowsKey]);

  const agentSessionEntries = useMemo(() => {
    const visibleMainAgentIds = new Set(renderedRows.map((row) => row.agentId));

    const entries: AgentSessionEntry[] = [];
    for (const agent of agents) {
      const metricsKey = getMetricsKey(agent.id);
      const presence = agentPresence[agent.id];
      if (
        visibleMainAgentIds.has(agent.id) &&
        visibleContextKeys.has(metricsKey) &&
        !contextBarHidden.has(metricsKey) &&
        presence?.online &&
        presence.sessionId
      ) {
        entries.push({ agentId: agent.id, sessionId: presence.sessionId });
      }
    }
    return entries;
  }, [agentPresence, agents, contextBarHidden, renderedRows, visibleContextKeys]);

  const contextMetrics = useAgentSessionMetrics(agentSessionEntries);

  const profilesById = useMemo(() => {
    const map = new Map<string, { id: string; name: string }>();
    for (const p of projectProfiles ?? []) {
      map.set(p.id, { id: p.id, name: p.name });
    }
    return map;
  }, [projectProfiles]);

  function renderMainAgentRow(
    agent: AgentOrGuest,
    options?: {
      isTeamLead?: boolean;
      keyPrefix?: string;
      canDelete?: boolean;
      teamId?: string;
      teamName?: string;
      maxMembers?: number;
      maxConcurrentTasks?: number;
      allowTeamLeadCreateAgents?: boolean;
    },
  ) {
    const isOnline = agentPresence[agent.id]?.online ?? false;
    const activityState = agentPresence[agent.id]?.activityState ?? null;
    const isSelected = selectedAgentId === agent.id;
    const agentProviderName = getProviderForAgent(agent.id);
    const agentProviderIcon = agentProviderName ? getProviderIconDataUri(agentProviderName) : null;
    const hasSession = Boolean(isOnline && agentPresence[agent.id]?.sessionId);
    const sessionId = agentPresence[agent.id]?.sessionId ?? null;
    const isLaunching = Boolean(launchingAgentIds[agent.id]);
    const isRestarting = restartingAgentId === agent.id;
    const metricsKey = getMetricsKey(agent.id);
    const keyPrefix = options?.keyPrefix ?? 'all';
    const configDisplay = getAgentConfigDisplay(agent);

    return (
      <EventBusAgentRow
        key={`${keyPrefix}:${agent.id}`}
        agent={agent}
        isSelected={isSelected}
        isOnline={isOnline}
        activityState={activityState}
        currentActivityTitle={agentPresence[agent.id]?.currentActivityTitle ?? null}
        sessionMetrics={contextMetrics.get(metricsKey)}
        contextMetricsKey={metricsKey}
        pendingRestart={pendingRestartAgentIds.has(restartKeyForMain(agent.id))}
        providerIconUri={agentProviderIcon}
        providerName={agentProviderName}
        configDisplayName={configDisplay?.label ?? null}
        configDisplayTitle={configDisplay?.title ?? null}
        contextTrackingEnabled={!contextBarHidden.has(metricsKey)}
        hasSelectedProject={hasSelectedProject}
        hasSession={hasSession}
        sessionId={sessionId}
        isLaunching={isLaunching}
        isRestarting={isRestarting}
        isLaunchingChat={false}
        humanHeldMessageCount={humanHeldMessageCounts?.[agent.id] ?? 0}
        canReleaseHeldMessages={humanHeldReleaseEligibleAgentIds?.[agent.id] === true}
        onReleaseHeldMessages={() => onReleaseHeldMessages(agent.id)}
        releasingHeldMessages={releasingHeldAgentId === agent.id}
        canForceSend={forceEligibleAgentIds?.[agent.id] === true}
        onForceSend={() => onForceDelivery(agent.id)}
        forceSending={forcingAgentId === agent.id}
        holdReasonLabel={holdReasonLabels?.[agent.id]}
        activityBadge={renderActivityBadge(agent.id)}
        unloggedTimeMinutes={unloggedTimeMinutes?.[agent.id]}
        isTeamLead={options?.isTeamLead ?? false}
        canOverride={agent.type !== 'guest' && Boolean(agent.profileId)}
        onOpenOverrides={(triggerEl) => setOverridesTarget({ agent, isOnline, triggerEl })}
        canClone={agent.type !== 'guest' && Boolean(onCloneAgent)}
        onClone={
          onCloneAgent
            ? () =>
                onCloneAgent(
                  agent,
                  options?.teamId
                    ? {
                        teamId: options.teamId,
                        teamName: options.teamName ?? '',
                        isTeamLead: options.isTeamLead ?? false,
                      }
                    : undefined,
                )
            : undefined
        }
        canEditTeam={options?.isTeamLead === true && !!options?.teamId}
        onEditTeam={
          onEditTeam && options?.teamId
            ? () =>
                onEditTeam({
                  teamId: options.teamId!,
                  teamName: options.teamName ?? '',
                  maxMembers: options.maxMembers ?? 5,
                  maxConcurrentTasks: options.maxConcurrentTasks ?? 5,
                  allowTeamLeadCreateAgents: options.allowTeamLeadCreateAgents ?? false,
                })
            : undefined
        }
        isDisabled={agent.disabled === true}
        canDisable={
          agent.type !== 'guest' &&
          agent.disabled !== true &&
          !agent.isProjectOwner &&
          !teamLeadIds.has(agent.id) &&
          Boolean(options?.teamId) &&
          Boolean(onDisableAgent)
        }
        onDisable={onDisableAgent ? () => onDisableAgent(agent) : undefined}
        onEnable={onEnableAgent ? () => onEnableAgent(agent) : undefined}
        canDelete={options?.canDelete ?? false}
        onDelete={onDeleteAgent ? () => onDeleteAgent(agent) : undefined}
        pendingDelete={pendingDeleteAgentId === agent.id}
        onClick={() => onSelectAgent(agent.id)}
        onRestart={() => onRestartSession(agent.id)}
        onLaunch={() => onLaunchSession(agent.id, { attach: false })}
        onTerminate={() => {
          if (sessionId) {
            onTerminateConfirm(agent.id, sessionId);
          }
        }}
        onToggleContextTracking={() => handleToggleContextBar(metricsKey)}
        eventBusAnchor={{
          key: `${keyPrefix}:${agent.id}`,
          agentId: agent.id,
          ...(options?.teamId ? { teamId: options.teamId } : {}),
        }}
      />
    );
  }

  function renderVisualSectionHeader(label: string, countLabel: string, icon: ReactNode) {
    return (
      <div className="flex items-center justify-between gap-2 px-2 pb-2 pt-1">
        <div className="flex min-w-0 items-center gap-2">
          {icon}
          <span className="truncate text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {label}
          </span>
        </div>
        <Badge
          variant="outline"
          className="shrink-0 border-border bg-muted/40 px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
        >
          {countLabel}
        </Badge>
      </div>
    );
  }

  return (
    <div
      ref={sidebarRef}
      className="flex h-full min-h-0 w-80 shrink-0 flex-col border-r border-border bg-card text-foreground"
      data-testid="chat-sidebar"
    >
      <div className="border-b border-border/70 bg-muted/20 px-4 py-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            <h2 className="sr-only">Agents</h2>
            <HelpButton featureId="chat" />
            <PresetPopover
              presets={validatedPresets}
              activePreset={activePreset}
              applying={applyingPreset}
              onApply={onApplyPreset}
              disabled={!hasSelectedProject}
            />
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              className="h-7 border-status-ok/40 bg-status-ok/10 px-2 text-xs text-status-ok hover:border-status-ok hover:bg-accent hover:text-status-ok"
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
              className="h-7 border-border bg-muted/30 px-2 text-xs text-muted-foreground hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
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
      </div>

      {/*
        `-ml-4` widens the scroll viewport 16px to the LEFT, into the page gutter between
        the nav and this panel (the page wrapper's `px-4`). A scroll container cannot paint
        outside itself — `overflow-x: visible` is not possible alongside vertical scrolling
        — so this is what lets the event bus bloom spill into that gap instead of being cut
        at the panel edge. The agents region below re-adds the 16px as padding, so every row
        stays exactly where it was.
        Radix wraps the content in a `display: table` div that grows to its widest
        unbreakable label; `block` keeps it at the viewport width so labels truncate.
      */}
      <ScrollArea className="-ml-4 flex-1" hideScrollbar viewportClassName="[&>div]:!block">
        {/* Re-adds the 16px the ScrollArea borrowed, so all content stays put. */}
        <div className="pl-4">
          {/* Agents Section */}
          <div
            ref={mainAgentsContainerRef}
            className="relative px-4 py-4"
            data-testid="chat-main-agents-wrapper"
          >
            <AgentEventBus projectId={projectId} containerRef={mainAgentsContainerRef}>
              <div id="chat-main-agents" className="space-y-1">
                {/* The roster's own error wins over a team request that is still loading. */}
                {agentsError && !agentsLoading ? (
                  <p className="text-xs text-destructive">
                    Failed to load agents. Please try again.
                  </p>
                ) : !listReady ? (
                  <div className="space-y-2" aria-hidden>
                    {Array.from({ length: 3 }).map((_, index) => (
                      <Skeleton key={index} className="h-10 w-full" />
                    ))}
                  </div>
                ) : showTeamsView ? (
                  <>
                    {teamSections.items.map(
                      ({
                        team,
                        detail,
                        agents: teamAgents,
                        lead: leadAgent,
                        members: otherMembers,
                      }) => {
                        const fold = teamFold.get(team.id);
                        const isExpanded = fold?.isExpanded ?? false;
                        // A click stores the opposite of the state on screen.
                        const onToggleFold = () =>
                          toggleTeamFold(team.id, {
                            collapsed: isExpanded,
                            whenActive: fold?.hasActive ?? false,
                          });
                        const hasExpandable = otherMembers.length > 0;
                        // Same element in both header variants; with no lead the
                        // dots keep the row order. Only a folded team shows dots: an
                        // unfolded team shows its rows.
                        const statusDots = isExpanded ? null : (
                          <TeamStatusDots
                            teamName={team.name}
                            agents={teamAgents}
                            leadAgentId={leadAgent?.id ?? null}
                            agentPresence={agentPresence}
                            onSelectAgent={onSelectAgent}
                          />
                        );

                        if (!leadAgent) {
                          return (
                            <div
                              key={team.id}
                              className="overflow-hidden rounded-md border border-border bg-card/80 shadow-sm"
                            >
                              <div className="flex w-full items-center gap-2 border-b border-border/70 bg-muted/20 px-3 py-2 text-xs">
                                <button
                                  type="button"
                                  onClick={onToggleFold}
                                  className="flex min-w-[6rem] items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-muted/50"
                                  aria-expanded={isExpanded}
                                  aria-controls={`chat-team-group-${team.id}`}
                                  aria-label={`Toggle ${team.name} members`}
                                >
                                  {isExpanded ? (
                                    <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                                  ) : (
                                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                                  )}
                                  <UsersRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                  <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                                    {team.name}
                                  </span>
                                </button>
                                {statusDots}
                                {onAddTeamAgent && (
                                  // `ml-auto` keeps it at the right edge when no dots fill the row.
                                  <div
                                    className="ml-auto flex shrink-0 items-center"
                                    data-testid="team-header-controls"
                                  >
                                    <TeamQuickAddButton
                                      teamId={team.id}
                                      teamName={team.name}
                                      teamLeadAgentId={detail.teamLeadAgentId}
                                      profileIds={detail.profileIds ?? []}
                                      profilesById={profilesById}
                                      agents={agents}
                                      onAddAgent={onAddTeamAgent}
                                    />
                                  </div>
                                )}
                              </div>
                              {isExpanded && (
                                <div
                                  id={`chat-team-group-${team.id}`}
                                  className="space-y-1 bg-muted/10 px-2 py-2"
                                  role="list"
                                  aria-label={`${team.name} agents`}
                                >
                                  {teamAgents.map((agent) =>
                                    renderMainAgentRow(agent, {
                                      keyPrefix: team.id,
                                      canDelete: Boolean(onDeleteAgent),
                                      teamId: team.id,
                                      teamName: team.name,
                                    }),
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        }

                        return (
                          <div
                            key={team.id}
                            className="overflow-hidden rounded-md border border-border bg-card/80 shadow-sm"
                          >
                            <div className="bg-muted/10">
                              {renderMainAgentRow(leadAgent, {
                                isTeamLead: true,
                                keyPrefix: team.id,
                                teamId: team.id,
                                teamName: team.name,
                                maxMembers: detail.maxMembers,
                                maxConcurrentTasks: detail.maxConcurrentTasks,
                                allowTeamLeadCreateAgents: detail.allowTeamLeadCreateAgents,
                              })}
                              <div className="flex min-w-0 items-center gap-1 px-3 pb-1 text-[10px] text-muted-foreground">
                                <span className="min-w-[3rem] truncate">{team.name}</span>
                                {statusDots}
                                {/* `ml-auto` keeps the controls at the right edge when no dots fill the row. */}
                                {(onAddTeamAgent || hasExpandable) && (
                                  <div
                                    className="ml-auto flex shrink-0 items-center gap-1"
                                    data-testid="team-header-controls"
                                  >
                                    {onAddTeamAgent && (
                                      <TeamQuickAddButton
                                        teamId={team.id}
                                        teamName={team.name}
                                        teamLeadAgentId={detail.teamLeadAgentId}
                                        profileIds={detail.profileIds ?? []}
                                        profilesById={profilesById}
                                        agents={agents}
                                        onAddAgent={onAddTeamAgent}
                                      />
                                    )}
                                    {hasExpandable && (
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          onToggleFold();
                                        }}
                                        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-muted/50"
                                        aria-expanded={isExpanded}
                                        aria-controls={`chat-team-group-${team.id}`}
                                        aria-label={`Toggle ${team.name} members`}
                                      >
                                        {isExpanded ? (
                                          <ChevronDown className="h-4 w-4 text-muted-foreground" />
                                        ) : (
                                          <ChevronRight className="h-4 w-4 text-muted-foreground" />
                                        )}
                                      </button>
                                    )}
                                  </div>
                                )}
                              </div>
                            </div>
                            {hasExpandable && isExpanded && (
                              <div
                                id={`chat-team-group-${team.id}`}
                                className="space-y-1 border-t border-border/70 bg-muted/10 py-2 pl-4 pr-0"
                                role="list"
                                aria-label={`${team.name} members`}
                              >
                                {otherMembers.map((agent) =>
                                  renderMainAgentRow(agent, {
                                    keyPrefix: team.id,
                                    canDelete: Boolean(onDeleteAgent),
                                    teamId: team.id,
                                    teamName: team.name,
                                  }),
                                )}
                              </div>
                            )}
                          </div>
                        );
                      },
                    )}
                    {teamSections.noTeamAgents.length > 0 && (
                      <div className="pt-2">
                        {renderVisualSectionHeader(
                          'STANDALONE',
                          formatSectionCount(teamSections.noTeamAgents.length, 'agent'),
                          <User className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />,
                        )}
                        <div className="space-y-1" role="list" aria-label="Standalone agents">
                          {teamSections.noTeamAgents.map((agent) =>
                            renderMainAgentRow(agent, { keyPrefix: 'no-team' }),
                          )}
                        </div>
                      </div>
                    )}
                    {teamSections.items.length === 0 && teamSections.noTeamAgents.length === 0 && (
                      <p className="text-xs text-muted-foreground">No agents yet.</p>
                    )}
                  </>
                ) : agents.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No agents yet.</p>
                ) : (
                  <div className="space-y-1" role="list" aria-label="Agents">
                    {canonicalAgents.map((agent) => renderMainAgentRow(agent))}
                  </div>
                )}
              </div>
            </AgentEventBus>
          </div>

          {/* Guests Section */}
          {canonicalGuests.length > 0 && (
            <>
              <Separator />
              <div className="px-4 py-4">
                {renderVisualSectionHeader(
                  'GUESTS',
                  formatSectionCount(canonicalGuests.length, 'guest'),
                  <Users className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />,
                )}
                <div className="space-y-1" role="list" aria-label="Guest agents">
                  {canonicalGuests.map((guest) => {
                    const isOnline = true;

                    return (
                      <button
                        key={guest.id}
                        type="button"
                        className={cn(
                          'flex w-full cursor-default items-center gap-2 rounded-md border border-transparent bg-card/40 px-3 py-2 text-sm transition-colors hover:border-border hover:bg-muted/50',
                        )}
                        role="listitem"
                        aria-label={`Guest: ${guest.name}${isOnline ? ' (online)' : ' (offline)'}`}
                      >
                        <Circle
                          className={cn(
                            'h-2 w-2 fill-current',
                            isOnline ? 'text-status-ok' : 'text-muted-foreground',
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
                              className="border-purple-500/40 bg-purple-500/10 text-[10px] uppercase text-purple-600"
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
        </div>
      </ScrollArea>

      {overridesTarget &&
        (() => {
          const { agent, isOnline, triggerEl } = overridesTarget;
          const isSaving = Boolean(updatingConfigAgentIds[agent.id]);
          const handleSave = (payload: AgentOverridesSavePayload) =>
            onSwitchConfig(
              agent.id,
              payload.providerConfigId,
              payload.modelOverride,
              payload.effortOverride,
            );
          return (
            <AgentOverridesDialog
              key={agent.id}
              open
              onOpenChange={(next) => {
                if (!next) closeOverrides();
              }}
              agent={agent}
              isOnline={isOnline}
              isSaving={isSaving}
              onSave={handleSave}
              triggerEl={triggerEl}
            />
          );
        })()}
    </div>
  );
}

/**
 * Memoized at the bundle boundary: with ChatPage's three useMemo'd bundles, an
 * unrelated ChatPage re-render leaves all three prop references intact, so this
 * component and its AgentRow subtree skip re-rendering. Referential stability of
 * the bundles is the contract that makes this correct.
 */
export const ChatSidebar = memo(ChatSidebarInner);
