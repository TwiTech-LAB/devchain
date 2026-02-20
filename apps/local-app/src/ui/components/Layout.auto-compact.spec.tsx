import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Layout } from './Layout';
import { RuntimeProvider } from '../hooks/useRuntime';
import { WorktreeTabProvider } from '../hooks/useWorktreeTab';
import type { WsEnvelope } from '../lib/socket';
import { WORKTREE_PROXY_UNAVAILABLE_EVENT } from '../lib/worktree-fetch-interceptor';

const toastSpy = jest.fn();
const useSelectedProjectMock = jest.fn();
let wsMessageHandler: ((envelope: WsEnvelope) => void) | null = null;

jest.mock('../hooks/useProjectSelection', () => ({
  useSelectedProject: () => useSelectedProjectMock(),
}));

jest.mock('../hooks/use-toast', () => ({
  useToast: () => ({ toast: toastSpy, toasts: [], dismiss: jest.fn() }),
}));

jest.mock('../hooks/useBreadcrumbs', () => ({
  BreadcrumbsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useBreadcrumbs: () => ({ items: [] }),
}));

jest.mock('./shared', () => ({
  Breadcrumbs: () => null,
  ToastHost: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  EpicSearchInput: () => null,
}));

jest.mock('../hooks/useAppSocket', () => ({
  useAppSocket: (handlers: Record<string, (...args: unknown[]) => void>) => {
    wsMessageHandler =
      typeof handlers.message === 'function'
        ? (handlers.message as (envelope: WsEnvelope) => void)
        : null;
    return {} as never;
  },
}));

jest.mock('../terminal-windows', () => ({
  TerminalWindowsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TerminalWindowsLayer: () => <div data-testid="terminal-layer" />,
  useTerminalWindowManager: () => jest.fn(),
  useTerminalWindows: () => ({
    windows: [],
    closeWindow: jest.fn(),
    focusedWindowId: null,
    focusWindow: jest.fn(),
    minimizeWindow: jest.fn(),
    restoreWindow: jest.fn(),
  }),
}));

jest.mock('./terminal-dock', () => ({
  TerminalDock: () => <div data-testid="terminal-dock" />,
  OPEN_TERMINAL_DOCK_EVENT: 'devchain:terminal-dock:open',
}));

jest.mock('./shared/AutoCompactEnableModal', () => ({
  AutoCompactEnableModal: (props: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    providerId: string;
    providerName: string;
    onEnabled?: () => void;
    onSkipped?: () => void;
  }) =>
    props.open ? (
      <div
        data-testid="auto-compact-modal"
        data-provider-id={props.providerId}
        data-provider-name={props.providerName}
      >
        <button data-testid="modal-enable" onClick={props.onEnabled}>
          Enable &amp; Continue
        </button>
        <button data-testid="modal-skip" onClick={props.onSkipped}>
          Skip
        </button>
      </div>
    ) : null,
}));

jest.mock('../pages/ReviewsPage.lazy', () => ({
  preloadReviewsPage: jest.fn(),
}));

(global as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: jest.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: jest.fn(),
    removeListener: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    dispatchEvent: jest.fn(),
  })),
});

if (!HTMLElement.prototype.hasPointerCapture) {
  HTMLElement.prototype.hasPointerCapture = () => false;
}
if (!HTMLElement.prototype.setPointerCapture) {
  HTMLElement.prototype.setPointerCapture = () => {};
}
if (!HTMLElement.prototype.releasePointerCapture) {
  HTMLElement.prototype.releasePointerCapture = () => {};
}
if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = () => {};
}

function renderLayout(initialEntries: string[] = ['/projects']) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <RuntimeProvider>
        <WorktreeTabProvider>
          <MemoryRouter initialEntries={initialEntries}>
            <Layout>
              <div>Layout Test Content</div>
            </Layout>
          </MemoryRouter>
        </WorktreeTabProvider>
      </RuntimeProvider>
    </QueryClientProvider>,
  );
}

async function emitSessionRecommendation(payload: Record<string, unknown>) {
  expect(wsMessageHandler).toBeTruthy();
  await act(async () => {
    wsMessageHandler?.({
      topic: 'system',
      type: 'session_recommendation',
      payload,
      ts: new Date().toISOString(),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('Layout auto-compact recommendation modal', () => {
  const originalFetch = global.fetch;
  let runtimeMode: 'main' | 'normal';
  let worktreesPayload: Array<{
    id: string;
    name: string;
    branchName: string;
    status: string;
    containerPort: number | null;
    devchainProjectId: string | null;
    errorMessage: string | null;
  }>;

  beforeEach(() => {
    window.history.replaceState({}, '', '/projects');
    runtimeMode = 'normal';
    worktreesPayload = [
      {
        id: 'wt-1',
        name: 'feature-auth',
        branchName: 'feature/auth',
        status: 'running',
        containerPort: 4310,
        devchainProjectId: 'project-1',
        errorMessage: null,
      },
      {
        id: 'wt-2',
        name: 'bugfix-ci',
        branchName: 'bugfix/ci',
        status: 'stopped',
        containerPort: null,
        devchainProjectId: 'project-2',
        errorMessage: null,
      },
      {
        id: 'wt-3',
        name: 'done-epic',
        branchName: 'done/epic',
        status: 'completed',
        containerPort: 4312,
        devchainProjectId: 'project-3',
        errorMessage: null,
      },
    ];
    toastSpy.mockReset();
    wsMessageHandler = null;
    localStorage.clear();
    useSelectedProjectMock.mockReturnValue({
      projects: [{ id: 'project-1', name: 'Project One', rootPath: '/tmp/project-one' }],
      projectsLoading: false,
      projectsError: false,
      refetchProjects: jest.fn(),
      selectedProjectId: 'project-1',
      selectedProject: { id: 'project-1', name: 'Project One', rootPath: '/tmp/project-one' },
      setSelectedProjectId: jest.fn(),
    });

    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/preflight')) {
        return {
          ok: true,
          json: async () => ({
            overall: 'pass',
            checks: [],
            providers: [],
            supportedMcpProviders: [],
            timestamp: new Date().toISOString(),
          }),
        } as Response;
      }
      if (url === '/health') {
        return {
          ok: true,
          json: async () => ({ version: '1.0.0' }),
        } as Response;
      }
      if (url === '/api/runtime') {
        return {
          ok: true,
          json: async () => ({ mode: runtimeMode, version: '1.0.0' }),
        } as Response;
      }
      if (url === '/api/worktrees') {
        return {
          ok: true,
          json: async () => worktreesPayload,
        } as Response;
      }
      if (url === '/api/providers/provider-1/auto-compact/enable' && init?.method === 'POST') {
        return {
          ok: true,
          text: async () => '',
          json: async () => ({ success: true }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({}),
      } as Response;
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    if (originalFetch) {
      global.fetch = originalFetch;
    }
  });

  it('opens modal for non-silent auto-compact recommendation', async () => {
    renderLayout();

    await emitSessionRecommendation({
      reason: 'claude_auto_compact_disabled',
      agentName: 'Builder Agent',
      providerId: 'provider-1',
      providerName: 'claude',
      silent: false,
      bootId: 'test-boot-id-123',
    });

    const modal = screen.getByTestId('auto-compact-modal');
    expect(modal).toBeInTheDocument();
    expect(modal).toHaveAttribute('data-provider-id', 'provider-1');
    expect(modal).toHaveAttribute('data-provider-name', 'claude');
  });

  it('does not open modal for silent auto-compact recommendations', async () => {
    renderLayout();

    await emitSessionRecommendation({
      reason: 'claude_auto_compact_disabled',
      agentName: 'Silent Agent',
      providerId: 'provider-1',
      providerName: 'claude',
      silent: true,
      bootId: 'test-boot-id-123',
    });

    expect(screen.queryByTestId('auto-compact-modal')).not.toBeInTheDocument();
  });

  it('does not open modal when localStorage bootId matches current bootId', async () => {
    localStorage.setItem('devchain:autoCompact:recommended:provider-1', 'test-boot-id-123');
    renderLayout();

    await emitSessionRecommendation({
      reason: 'claude_auto_compact_disabled',
      agentName: 'Builder Agent',
      providerId: 'provider-1',
      providerName: 'claude',
      silent: false,
      bootId: 'test-boot-id-123',
    });

    expect(screen.queryByTestId('auto-compact-modal')).not.toBeInTheDocument();
  });

  it('writes localStorage and shows success toast when Enable is clicked', async () => {
    renderLayout();

    await emitSessionRecommendation({
      reason: 'claude_auto_compact_disabled',
      agentName: 'Builder Agent',
      providerId: 'provider-1',
      providerName: 'claude',
      silent: false,
      bootId: 'test-boot-id-123',
    });

    expect(screen.getByTestId('auto-compact-modal')).toBeInTheDocument();

    await act(async () => {
      screen.getByTestId('modal-enable').click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(localStorage.getItem('devchain:autoCompact:recommended:provider-1')).toBe(
      'test-boot-id-123',
    );
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Auto-compact enabled' }),
    );
    expect(screen.queryByTestId('auto-compact-modal')).not.toBeInTheDocument();
  });

  it('writes localStorage and closes modal when Skip is clicked', async () => {
    renderLayout();

    await emitSessionRecommendation({
      reason: 'claude_auto_compact_disabled',
      agentName: 'Builder Agent',
      providerId: 'provider-1',
      providerName: 'claude',
      silent: false,
      bootId: 'test-boot-id-123',
    });

    expect(screen.getByTestId('auto-compact-modal')).toBeInTheDocument();

    await act(async () => {
      screen.getByTestId('modal-skip').click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(localStorage.getItem('devchain:autoCompact:recommended:provider-1')).toBe(
      'test-boot-id-123',
    );
    expect(screen.queryByTestId('auto-compact-modal')).not.toBeInTheDocument();
    // No success toast for skip
    expect(toastSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Auto-compact enabled' }),
    );
  });

  it('does not reopen modal for same provider after Skip (same bootId)', async () => {
    renderLayout();

    await emitSessionRecommendation({
      reason: 'claude_auto_compact_disabled',
      agentName: 'First Agent',
      providerId: 'provider-1',
      providerName: 'claude',
      silent: false,
      bootId: 'test-boot-id-123',
    });

    await act(async () => {
      screen.getByTestId('modal-skip').click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.queryByTestId('auto-compact-modal')).not.toBeInTheDocument();

    // Second recommendation for same provider with same bootId — blocked by localStorage
    await emitSessionRecommendation({
      reason: 'claude_auto_compact_disabled',
      agentName: 'Second Agent',
      providerId: 'provider-1',
      providerName: 'claude',
      silent: false,
      bootId: 'test-boot-id-123',
    });

    expect(screen.queryByTestId('auto-compact-modal')).not.toBeInTheDocument();
  });

  it('reopens modal when bootId changes (simulating server restart)', async () => {
    // Previous boot dismissed with old bootId
    localStorage.setItem('devchain:autoCompact:recommended:provider-1', 'old-boot-id-999');
    renderLayout();

    // New server boot sends a different bootId
    await emitSessionRecommendation({
      reason: 'claude_auto_compact_disabled',
      agentName: 'Builder Agent',
      providerId: 'provider-1',
      providerName: 'claude',
      silent: false,
      bootId: 'new-boot-id-456',
    });

    // Modal should appear because bootId changed
    expect(screen.getByTestId('auto-compact-modal')).toBeInTheDocument();
  });

  it('falls back to any-truthy suppression when bootId is absent from payload', async () => {
    localStorage.setItem('devchain:autoCompact:recommended:provider-1', 'true');
    renderLayout();

    // Payload without bootId (backward compat with old server)
    await emitSessionRecommendation({
      reason: 'claude_auto_compact_disabled',
      agentName: 'Builder Agent',
      providerId: 'provider-1',
      providerName: 'claude',
      silent: false,
    });

    // Modal should be suppressed (fallback: any truthy value in localStorage)
    expect(screen.queryByTestId('auto-compact-modal')).not.toBeInTheDocument();
  });

  it('stores "true" when payload lacks bootId and user dismisses', async () => {
    renderLayout();

    // Payload without bootId
    await emitSessionRecommendation({
      reason: 'claude_auto_compact_disabled',
      agentName: 'Builder Agent',
      providerId: 'provider-1',
      providerName: 'claude',
      silent: false,
    });

    expect(screen.getByTestId('auto-compact-modal')).toBeInTheDocument();

    await act(async () => {
      screen.getByTestId('modal-skip').click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Falls back to 'true' when no bootId
    expect(localStorage.getItem('devchain:autoCompact:recommended:provider-1')).toBe('true');
  });

  it('shows Worktrees nav link when runtime mode is normal', async () => {
    runtimeMode = 'normal';
    renderLayout();

    expect(await screen.findByRole('link', { name: 'Worktrees' })).toBeInTheDocument();
  });

  it('shows Worktrees nav link when runtime mode is main', async () => {
    runtimeMode = 'main';
    renderLayout();

    expect(await screen.findByRole('link', { name: 'Worktrees' })).toBeInTheDocument();
  });

  it('keeps Chat and Reviews nav links visible in main mode', async () => {
    runtimeMode = 'main';
    renderLayout();

    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Chat' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Reviews' })).toBeInTheDocument();
    });
  });

  it('shows Chat and Reviews nav links in main mode when a worktree tab is active', async () => {
    const user = userEvent.setup();
    runtimeMode = 'main';
    renderLayout();

    const worktreeTab = await screen.findByRole('tab', { name: /feature-auth/i });
    await user.click(worktreeTab);

    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Chat' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Reviews' })).toBeInTheDocument();
    });
  });

  it('keeps terminal dock and terminal layer rendered in both normal and main modes', async () => {
    runtimeMode = 'normal';
    const normalRender = renderLayout();

    expect(await screen.findByTestId('terminal-dock')).toBeInTheDocument();
    expect(screen.getByTestId('terminal-layer')).toBeInTheDocument();

    normalRender.unmount();
    runtimeMode = 'main';
    renderLayout();

    await waitFor(() => {
      expect(screen.getByTestId('terminal-dock')).toBeInTheDocument();
      expect(screen.getByTestId('terminal-layer')).toBeInTheDocument();
    });
  });

  it('hides worktree tab bar outside main mode', async () => {
    runtimeMode = 'normal';
    renderLayout();

    await waitFor(() => {
      expect(screen.queryByRole('tab', { name: /main/i })).not.toBeInTheDocument();
    });
  });

  it('shows worktree tab bar in main mode with proxyable and unavailable status states', async () => {
    runtimeMode = 'main';
    renderLayout();

    expect(await screen.findByRole('tab', { name: /main/i })).toBeInTheDocument();
    expect(await screen.findByText('feature-auth')).toBeInTheDocument();
    expect(screen.getByText('bugfix-ci')).toBeInTheDocument();
    expect(screen.getByText('done-epic')).toBeInTheDocument();

    expect(screen.getByRole('tab', { name: /feature-auth/i })).toBeEnabled();
    expect(screen.getByRole('tab', { name: /bugfix-ci/i })).toBeDisabled();
    expect(screen.getByRole('tab', { name: /done-epic/i })).toBeEnabled();
  });

  it('updates selected tab and URL search params when clicking a running worktree tab', async () => {
    const user = userEvent.setup();
    runtimeMode = 'main';
    renderLayout();

    const mainTab = await screen.findByRole('tab', { name: /main/i });
    const worktreeTab = await screen.findByRole('tab', { name: /feature-auth/i });
    expect(mainTab).toHaveAttribute('aria-selected', 'true');

    await user.click(worktreeTab);

    await waitFor(() => {
      expect(worktreeTab).toHaveAttribute('aria-selected', 'true');
      expect(window.location.search).toBe('?wt=feature-auth');
    });
  });

  it('updates selected tab and URL search params when clicking a completed worktree tab', async () => {
    const user = userEvent.setup();
    runtimeMode = 'main';
    renderLayout();

    const mainTab = await screen.findByRole('tab', { name: /main/i });
    const completedTab = await screen.findByRole('tab', { name: /done-epic/i });
    expect(mainTab).toHaveAttribute('aria-selected', 'true');

    await user.click(completedTab);

    await waitFor(() => {
      expect(completedTab).toHaveAttribute('aria-selected', 'true');
      expect(window.location.search).toBe('?wt=done-epic');
    });
  });

  it('locks project selector when a worktree tab is active', async () => {
    const user = userEvent.setup();
    runtimeMode = 'main';
    renderLayout();

    expect(await screen.findByTestId('project-selector-select')).toBeInTheDocument();

    const worktreeTab = await screen.findByRole('tab', { name: /feature-auth/i });
    await user.click(worktreeTab);

    await waitFor(() => {
      expect(screen.queryByTestId('project-selector-select')).not.toBeInTheDocument();
      expect(screen.getByTestId('project-selector-locked')).toBeInTheDocument();
    });
  });

  it('shows unavailable banner for an active worktree when status transitions to stopped', async () => {
    jest.useFakeTimers();
    runtimeMode = 'main';

    try {
      renderLayout(['/board']);

      const worktreeTab = await screen.findByRole('tab', { name: /feature-auth/i });
      await act(async () => {
        worktreeTab.click();
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(window.location.search).toBe('?wt=feature-auth');
      });

      worktreesPayload = [
        {
          ...worktreesPayload[0],
          status: 'stopped',
          containerPort: null,
        },
        ...worktreesPayload.slice(1),
      ];

      await act(async () => {
        jest.advanceTimersByTime(16_000);
        await Promise.resolve();
      });

      expect(await screen.findByTestId('worktree-status-banner')).toBeInTheDocument();
      expect(screen.getByText('Worktree unavailable')).toBeInTheDocument();
      expect(
        screen.getByText(/Worktree "feature-auth" is stopped and cannot serve proxied requests./i),
      ).toBeInTheDocument();

      await act(async () => {
        screen.getByRole('button', { name: /switch to main/i }).click();
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(window.location.search).toBe('');
        expect(screen.getByRole('tab', { name: /main/i })).toHaveAttribute('aria-selected', 'true');
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('shows error message banner when active worktree transitions to error status', async () => {
    jest.useFakeTimers();
    runtimeMode = 'main';

    try {
      renderLayout(['/board']);

      const worktreeTab = await screen.findByRole('tab', { name: /feature-auth/i });
      await act(async () => {
        worktreeTab.click();
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(window.location.search).toBe('?wt=feature-auth');
      });

      worktreesPayload = [
        {
          ...worktreesPayload[0],
          status: 'error',
          containerPort: null,
          errorMessage: 'Container failed to start: missing env vars',
        },
        ...worktreesPayload.slice(1),
      ];

      await act(async () => {
        jest.advanceTimersByTime(16_000);
        await Promise.resolve();
      });

      expect(await screen.findByTestId('worktree-status-banner')).toBeInTheDocument();
      expect(screen.getByText('Worktree error')).toBeInTheDocument();
      expect(screen.getByText('Container failed to start: missing env vars')).toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  });

  it('switches to Main when active worktree disappears on polling refresh', async () => {
    jest.useFakeTimers();
    runtimeMode = 'main';

    try {
      renderLayout(['/board']);

      const worktreeTab = await screen.findByRole('tab', { name: /feature-auth/i });
      await act(async () => {
        worktreeTab.click();
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(window.location.search).toBe('?wt=feature-auth');
        expect(worktreeTab).toHaveAttribute('aria-selected', 'true');
      });

      worktreesPayload = worktreesPayload.filter((worktree) => worktree.name !== 'feature-auth');

      await act(async () => {
        jest.advanceTimersByTime(16_000);
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(window.location.search).toBe('');
        expect(screen.getByRole('tab', { name: /main/i })).toHaveAttribute('aria-selected', 'true');
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('shows unavailable banner after a proxied 503 event for the active worktree tab', async () => {
    runtimeMode = 'main';
    renderLayout(['/board']);

    const worktreeTab = await screen.findByRole('tab', { name: /feature-auth/i });
    await act(async () => {
      worktreeTab.click();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(window.location.search).toBe('?wt=feature-auth');
      expect(worktreeTab).toHaveAttribute('aria-selected', 'true');
    });

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(WORKTREE_PROXY_UNAVAILABLE_EVENT, {
          detail: {
            statusCode: 503,
            worktreeName: 'feature-auth',
            message: 'Worktree is not running (status: stopped)',
            requestUrl: '/wt/feature-auth/api/epics?projectId=project-1',
          },
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(await screen.findByTestId('worktree-status-banner')).toBeInTheDocument();
    expect(screen.getByText('Worktree unavailable')).toBeInTheDocument();
    expect(screen.getByText('Worktree is not running (status: stopped)')).toBeInTheDocument();
  });

  it('hides Worktrees and Registry nav links when a worktree tab is active', async () => {
    const user = userEvent.setup();
    runtimeMode = 'main';
    renderLayout();

    // Before selecting a worktree: both nav items should be visible
    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Worktrees' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Registry' })).toBeInTheDocument();
    });

    // Select a worktree tab
    const worktreeTab = await screen.findByRole('tab', { name: /feature-auth/i });
    await user.click(worktreeTab);

    // After selecting a worktree: both nav items should be hidden
    await waitFor(() => {
      expect(screen.queryByRole('link', { name: 'Worktrees' })).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Registry' })).not.toBeInTheDocument();
    });

    // Other nav items should still be visible
    expect(screen.getByRole('link', { name: 'Chat' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Board' })).toBeInTheDocument();
  });
});
