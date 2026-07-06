import React from 'react';
import { render, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { restartKeyForWorktree } from '@/ui/lib/restart-keys';
import type { WorktreeAgentGroup } from '@/ui/hooks/useWorktreeAgents';

/**
 * Characterization tests for the INLINE worktree session handlers in ChatPage
 * (ChatPage.tsx:1226-1368). These lock the behavior that the lifecycle-matrix
 * doc (docs/ui-session-lifecycle-matrix.md) records for the `worktree` consumer,
 * so the Task-7 deletion of the inline copy is provably behavior-preserving.
 *
 * The handlers are captured off the mocked ChatSidebar props and invoked
 * directly — this exercises the real ChatPage closures without depending on the
 * sidebar's DOM.
 */

// ---- jsdom polyfills required by ChatPage's dependency tree ----
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = jest.fn();
}
if (!(global as unknown as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver) {
  class ResizeObserverMock {
    observe = jest.fn();
    unobserve = jest.fn();
    disconnect = jest.fn();
  }
  (global as unknown as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver =
    ResizeObserverMock as unknown as typeof ResizeObserver;
}

// Capture holder for the props ChatSidebar last received (mock-prefixed so
// babel-plugin-jest-hoist permits the reference inside jest.mock factories).
const mockSidebarProps: { current: Record<string, unknown> | null } = { current: null };

const toastSpy = jest.fn();
const openWorktreeTerminalWindowMock = jest.fn();

// ---- Session fetcher core: mock the three worktree-used fns, keep the rest ----
jest.mock('@/ui/lib/sessions', () => {
  const actual = jest.requireActual('@/ui/lib/sessions');
  return {
    ...actual,
    launchSession: jest.fn(),
    restartSession: jest.fn(),
    terminateSession: jest.fn(),
  };
});

import {
  launchSession,
  restartSession,
  terminateSession,
  SessionApiError,
  type ActiveSession,
} from '@/ui/lib/sessions';

const mockLaunch = launchSession as jest.MockedFunction<typeof launchSession>;
const mockRestart = restartSession as jest.MockedFunction<typeof restartSession>;
const mockTerminate = terminateSession as jest.MockedFunction<typeof terminateSession>;

// ---- Capture the worktree handlers by mocking ChatSidebar ----
jest.mock('@/ui/components/chat/ChatSidebar', () => ({
  ChatSidebar: (props: Record<string, unknown>) => {
    mockSidebarProps.current = props;
    return null;
  },
}));

// ---- Standard ChatPage test scaffolding (mirrors ChatPage.sessions.spec) ----
jest.mock('@xterm/xterm/css/xterm.css', () => ({}), { virtual: true });
jest.mock('@xterm/xterm', () => ({
  Terminal: jest.fn(() => ({
    loadAddon: jest.fn(),
    dispose: jest.fn(),
    open: jest.fn(),
    reset: jest.fn(),
    write: jest.fn(),
    attachCustomKeyEventHandler: jest.fn(),
    onData: jest.fn(() => ({ dispose: jest.fn() })),
    onResize: jest.fn(() => ({ dispose: jest.fn() })),
    onTitleChange: jest.fn(() => ({ dispose: jest.fn() })),
    onSelectionChange: jest.fn(() => ({ dispose: jest.fn() })),
  })),
  FitAddon: jest.fn(() => ({ activate: jest.fn(), dispose: jest.fn(), fit: jest.fn() })),
}));
jest.mock('@/ui/components/chat/InlineTerminalPanel', () => ({
  InlineTerminalPanel: () => null,
}));
jest.mock('@/ui/terminal-windows', () => ({
  useTerminalWindowManager: () => jest.fn(),
  useWorktreeTerminalWindowManager: () => openWorktreeTerminalWindowMock,
  useTerminalWindows: () => ({ windows: [], closeWindow: jest.fn(), focusedWindowId: null }),
  TerminalWindowsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock('@/ui/hooks/use-toast', () => ({
  useToast: () => ({ toast: toastSpy }),
}));
jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => ({
    selectedProjectId: 'project-1',
    selectedProject: { id: 'project-1', name: 'Project 1', rootPath: '/tmp/project-1' },
    projectsLoading: false,
    projectsError: false,
    projects: [],
  }),
}));
jest.mock('@/ui/hooks/useWorktreeTab', () => ({
  useOptionalWorktreeTab: () => ({
    activeWorktree: null,
    setActiveWorktree: jest.fn(),
    apiBase: '',
    worktrees: [],
    worktreesLoading: false,
    runtimeResolved: true,
  }),
}));
jest.mock('@/ui/hooks/useAppSocket', () => ({
  useAppSocket: jest.fn(() => ({
    connected: true,
    on: jest.fn(),
    off: jest.fn(),
    emit: jest.fn(),
  })),
}));
jest.mock('@/ui/lib/socket', () => ({
  getAppSocket: jest.fn(() => ({
    connected: true,
    on: jest.fn(),
    off: jest.fn(),
    emit: jest.fn(),
  })),
  getWorktreeSocket: jest.fn(() => ({
    connected: true,
    on: jest.fn(),
    off: jest.fn(),
    emit: jest.fn(),
  })),
  releaseAppSocket: jest.fn(),
  releaseWorktreeSocket: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ChatPage = require('./ChatPage').ChatPage as React.ComponentType;

// ============================================
// Helpers
// ============================================

function makeSession(overrides: Partial<ActiveSession> = {}): ActiveSession {
  return {
    id: 'sess-new-000001',
    epicId: null,
    agentId: 'agent-a',
    tmuxSessionId: 'tmux-a',
    status: 'running',
    startedAt: '2026-01-01T00:00:00Z',
    endedAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeGroup(overrides: Partial<WorktreeAgentGroup> = {}): WorktreeAgentGroup {
  return {
    id: 'wt-1',
    name: 'feature-x',
    status: 'ready',
    runtimeType: 'container',
    devchainProjectId: 'wt-proj-1',
    apiBase: '/wt/feature-x',
    agents: [],
    agentPresence: { 'agent-a': { online: true, sessionId: 'sess-a' } },
    disabled: false,
    error: null,
    ...overrides,
  };
}

function mcpError(providerName?: string): SessionApiError {
  return new SessionApiError('MCP not configured', 400, {
    statusCode: 400,
    code: 'MCP_NOT_CONFIGURED',
    message: 'MCP not configured',
    details: {
      code: 'MCP_NOT_CONFIGURED',
      ...(providerName ? { providerName } : {}),
    },
    timestamp: '2026-01-01T00:00:00Z',
    path: '/api/sessions/launch',
  });
}

function stubFetch(): jest.Mock {
  return jest.fn(async () => ({ ok: true, json: async () => ({ items: [] }) }) as Response);
}

async function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <MemoryRouter initialEntries={['/chat']}>
      <QueryClientProvider client={queryClient}>
        <ChatPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  await waitFor(() => expect(mockSidebarProps.current).not.toBeNull());
  return { ...utils, queryClient };
}

/** Latest session-controller bundle the mocked ChatSidebar received. */
function sidebar() {
  if (!mockSidebarProps.current) throw new Error('ChatSidebar has not rendered yet');
  return mockSidebarProps.current.sessionController as {
    onLaunchWorktreeSession: (group: WorktreeAgentGroup, agentId: string) => Promise<void>;
    onRestartWorktreeSession: (group: WorktreeAgentGroup, agentId: string) => Promise<void>;
    onTerminateWorktreeSession: (
      group: WorktreeAgentGroup,
      agentId: string,
      sessionId: string,
    ) => Promise<void>;
    onMarkForRestart: (keys: string[]) => void;
    worktreeSessionActionsByAgentKey: Record<string, 'launching' | 'restarting' | 'terminating'>;
    pendingRestartAgentIds: Set<string>;
  };
}

// ============================================
// Tests
// ============================================

describe('ChatPage inline worktree session handlers (characterization)', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSidebarProps.current = null;
    global.fetch = stubFetch() as unknown as typeof fetch;
  });

  afterEach(() => {
    if (originalFetch) global.fetch = originalFetch;
  });

  describe('handleLaunchWorktreeSession', () => {
    it('calls launchSession apiBase-targeted with default fetch (no fetchFn injected)', async () => {
      await setup();
      const group = makeGroup();
      mockLaunch.mockResolvedValue(makeSession());

      await act(async () => {
        await sidebar().onLaunchWorktreeSession(group, 'agent-a');
      });

      // 4 args exactly: (agentId, devchainProjectId, undefined, apiBase). No 5th
      // fetchFn arg → the worktree path runs on the module default window.fetch.
      expect(mockLaunch).toHaveBeenCalledWith('agent-a', 'wt-proj-1', undefined, '/wt/feature-x');
      expect(mockLaunch.mock.calls[0]).toHaveLength(4);
    });

    it('shows the worktree success toast', async () => {
      await setup();
      mockLaunch.mockResolvedValue(makeSession());
      await act(async () => {
        await sidebar().onLaunchWorktreeSession(makeGroup(), 'agent-a');
      });
      expect(toastSpy).toHaveBeenCalledWith({
        title: 'Session launched',
        description: 'Session started for feature-x:agent-a.',
      });
    });

    it('refreshes worktree agent groups on success', async () => {
      const { queryClient } = await setup();
      const group = makeGroup();
      mockLaunch.mockResolvedValue(makeSession());
      const spy = jest.spyOn(queryClient, 'refetchQueries');

      await act(async () => {
        await sidebar().onLaunchWorktreeSession(group, 'agent-a');
      });

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ['chat-worktree-agent-groups'] }),
      );
    });

    it('isolates the busy key to the launching agent only', async () => {
      await setup();
      const group = makeGroup();
      let resolve!: (s: ActiveSession) => void;
      mockLaunch.mockReturnValue(new Promise<ActiveSession>((r) => (resolve = r)));

      let p!: Promise<void>;
      act(() => {
        p = sidebar().onLaunchWorktreeSession(group, 'agent-a');
      });

      await waitFor(() =>
        expect(sidebar().worktreeSessionActionsByAgentKey['feature-x:agent-a']).toBe('launching'),
      );
      // Only this key is busy — a different worktree agent is untouched.
      expect(sidebar().worktreeSessionActionsByAgentKey['feature-x:agent-b']).toBeUndefined();

      await act(async () => {
        resolve(makeSession());
        await p;
      });

      // Cleared in finally.
      expect(sidebar().worktreeSessionActionsByAgentKey['feature-x:agent-a']).toBeUndefined();
    });

    it('guards against missing devchainProjectId (no fetch, project-unavailable toast)', async () => {
      await setup();
      const group = makeGroup({ devchainProjectId: null });

      await act(async () => {
        await sidebar().onLaunchWorktreeSession(group, 'agent-a');
      });

      expect(mockLaunch).not.toHaveBeenCalled();
      expect(toastSpy).toHaveBeenCalledWith({
        title: 'Worktree project unavailable',
        description: 'Cannot launch session for feature-x because project metadata is missing.',
        variant: 'destructive',
      });
    });

    it('shows the switch-tab MCP toast (with provider name) on MCP_NOT_CONFIGURED', async () => {
      await setup();
      mockLaunch.mockRejectedValue(mcpError('Claude'));

      await act(async () => {
        await sidebar().onLaunchWorktreeSession(makeGroup(), 'agent-a');
      });

      expect(toastSpy).toHaveBeenCalledWith({
        title: 'MCP not configured',
        description: 'Switch to worktree tab to configure MCP for Claude.',
        variant: 'destructive',
      });
    });

    it('shows the switch-tab MCP toast (no provider name) when providerName is absent', async () => {
      await setup();
      mockLaunch.mockRejectedValue(mcpError());

      await act(async () => {
        await sidebar().onLaunchWorktreeSession(makeGroup(), 'agent-a');
      });

      expect(toastSpy).toHaveBeenCalledWith({
        title: 'MCP not configured',
        description: 'Switch to worktree tab to configure MCP.',
        variant: 'destructive',
      });
    });

    it('shows a generic failure toast on non-MCP errors', async () => {
      await setup();
      mockLaunch.mockRejectedValue(new Error('boom'));

      await act(async () => {
        await sidebar().onLaunchWorktreeSession(makeGroup(), 'agent-a');
      });

      expect(toastSpy).toHaveBeenCalledWith({
        title: 'Failed to launch session',
        description: 'boom',
        variant: 'destructive',
      });
    });
  });

  describe('handleRestartWorktreeSession', () => {
    it('calls restartSession with the current session id and apiBase (default fetch)', async () => {
      await setup();
      const group = makeGroup();
      mockRestart.mockResolvedValue({ session: makeSession() });

      await act(async () => {
        await sidebar().onRestartWorktreeSession(group, 'agent-a');
      });

      expect(mockRestart).toHaveBeenCalledWith('agent-a', 'wt-proj-1', 'sess-a', '/wt/feature-x');
      expect(mockRestart.mock.calls[0]).toHaveLength(4);
    });

    it('passes an empty session id when presence has none (no launch fallback)', async () => {
      await setup();
      const group = makeGroup({ agentPresence: {} });
      mockRestart.mockResolvedValue({ session: makeSession() });

      await act(async () => {
        await sidebar().onRestartWorktreeSession(group, 'agent-a');
      });

      expect(mockRestart).toHaveBeenCalledWith('agent-a', 'wt-proj-1', '', '/wt/feature-x');
      expect(mockLaunch).not.toHaveBeenCalled();
    });

    it('surfaces the terminateWarning as a destructive toast', async () => {
      await setup();
      mockRestart.mockResolvedValue({
        session: makeSession(),
        terminateWarning: 'old tmux lingered',
      });

      await act(async () => {
        await sidebar().onRestartWorktreeSession(makeGroup(), 'agent-a');
      });

      expect(toastSpy).toHaveBeenCalledWith({
        title: 'Session restarted with warning',
        description: 'old tmux lingered',
        variant: 'destructive',
      });
    });

    it('clears the worktree restart key on success', async () => {
      await setup();
      const group = makeGroup();
      const key = restartKeyForWorktree('/wt/feature-x', 'agent-a');
      mockRestart.mockResolvedValue({ session: makeSession() });

      act(() => sidebar().onMarkForRestart([key]));
      await waitFor(() => expect(sidebar().pendingRestartAgentIds.has(key)).toBe(true));

      await act(async () => {
        await sidebar().onRestartWorktreeSession(group, 'agent-a');
      });

      expect(sidebar().pendingRestartAgentIds.has(key)).toBe(false);
    });

    it('shows the switch-tab MCP toast on MCP_NOT_CONFIGURED', async () => {
      await setup();
      mockRestart.mockRejectedValue(mcpError('Codex'));

      await act(async () => {
        await sidebar().onRestartWorktreeSession(makeGroup(), 'agent-a');
      });

      expect(toastSpy).toHaveBeenCalledWith({
        title: 'MCP not configured',
        description: 'Switch to worktree tab to configure MCP for Codex.',
        variant: 'destructive',
      });
    });
  });

  describe('handleTerminateWorktreeSession', () => {
    it('calls terminateSession with the apiBase (default fetch) and refreshes groups', async () => {
      const { queryClient } = await setup();
      const group = makeGroup();
      mockTerminate.mockResolvedValue(undefined);
      const spy = jest.spyOn(queryClient, 'refetchQueries');

      await act(async () => {
        await sidebar().onTerminateWorktreeSession(group, 'agent-a', 'sess-a');
      });

      expect(mockTerminate).toHaveBeenCalledWith('sess-a', '/wt/feature-x');
      expect(mockTerminate.mock.calls[0]).toHaveLength(2);
      expect(toastSpy).toHaveBeenCalledWith({
        title: 'Session terminated',
        description: 'The worktree session was terminated.',
      });
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ['chat-worktree-agent-groups'] }),
      );
    });

    it('clears the worktree restart key on success', async () => {
      await setup();
      const group = makeGroup();
      const key = restartKeyForWorktree('/wt/feature-x', 'agent-a');
      mockTerminate.mockResolvedValue(undefined);

      act(() => sidebar().onMarkForRestart([key]));
      await waitFor(() => expect(sidebar().pendingRestartAgentIds.has(key)).toBe(true));

      await act(async () => {
        await sidebar().onTerminateWorktreeSession(group, 'agent-a', 'sess-a');
      });

      expect(sidebar().pendingRestartAgentIds.has(key)).toBe(false);
    });

    it('shows a generic failure toast when terminate throws', async () => {
      await setup();
      mockTerminate.mockRejectedValue(new Error('nope'));

      await act(async () => {
        await sidebar().onTerminateWorktreeSession(makeGroup(), 'agent-a', 'sess-a');
      });

      expect(toastSpy).toHaveBeenCalledWith({
        title: 'Failed to terminate session',
        description: 'nope',
        variant: 'destructive',
      });
    });
  });
});
