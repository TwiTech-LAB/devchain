import type {
  ChatSidebarAdminActions,
  ChatSidebarData,
  ChatSidebarProps,
  ChatSidebarSessionController,
} from './ChatSidebar';
import type { AgentOrGuest } from '@/ui/hooks/useChatQueries';

/**
 * The 55 individual sidebar inputs as one flat object — the shape existing specs
 * author fixtures and overrides in. `packChatSidebarProps` groups them into the
 * three bundles the component now receives. The flat object is a structural
 * superset of each bundle, so passing it as all three is type-safe; the component
 * reads only the members each bundle declares.
 */
export type FlatChatSidebarProps = ChatSidebarData &
  ChatSidebarSessionController &
  ChatSidebarAdminActions;

export function packChatSidebarProps(flat: FlatChatSidebarProps): ChatSidebarProps {
  return { data: flat, sessionController: flat, adminActions: flat };
}

/** A fully-populated flat fixture (one online agent) for stability/re-render specs. */
export function makeFlatChatSidebarProps(
  overrides: Partial<FlatChatSidebarProps> = {},
): FlatChatSidebarProps {
  const agent = {
    id: 'a1',
    name: 'Agent One',
    type: 'agent',
    profileId: 'p1',
  } as unknown as AgentOrGuest;
  return {
    projectId: 'proj-1',
    agents: [agent],
    guests: [],
    worktreeAgentGroups: [],
    worktreeAgentGroupsLoading: false,
    agentPresence: {},
    userThreads: [],
    agentThreads: [],
    presenceReady: true,
    offlineAgents: [agent],
    agentsWithSessions: [],
    agentsLoading: false,
    agentsError: false,
    userThreadsLoading: false,
    agentThreadsLoading: false,
    selectedThreadId: null,
    selectedWorktreeAgent: null,
    hasSelectedProject: true,
    getProviderForAgent: () => null,
    validatedPresets: [],
    activePreset: null,
    projectProfiles: [],
    launchingAgentIds: {},
    restartingAgentId: null,
    startingAll: false,
    terminatingAll: false,
    isLaunchingChat: false,
    onSelectThread: jest.fn(),
    onLaunchChat: jest.fn(),
    onLaunchWorktreeAgentChat: jest.fn(),
    onLaunchWorktreeSession: jest.fn(async () => {}),
    onRestartWorktreeSession: jest.fn(async () => {}),
    onTerminateWorktreeSession: jest.fn(async () => {}),
    onCreateGroup: jest.fn(),
    onStartAllAgents: jest.fn(),
    onTerminateAllConfirm: jest.fn(),
    onLaunchSession: jest.fn(async () => ({ id: 'session-1' })),
    onRestartSession: jest.fn(async () => {}),
    onTerminateConfirm: jest.fn(),
    pendingRestartAgentIds: new Set<string>(),
    onMarkForRestart: jest.fn(),
    worktreeSessionActionsByAgentKey: {},
    onApplyPreset: jest.fn(),
    applyingPreset: false,
    onSwitchConfig: jest.fn(),
    fetchProviderConfigsForProfile: jest.fn(async () => []),
    updatingConfigAgentIds: {},
    onSwitchWorktreeConfig: jest.fn(),
    updatingWorktreeConfigKey: null,
    createGroupPending: false,
    onCloneAgent: jest.fn(),
    onDeleteAgent: jest.fn(),
    pendingDeleteAgentId: null,
    onAddTeamAgent: jest.fn(),
    onEditTeam: jest.fn(),
    ...overrides,
  };
}
