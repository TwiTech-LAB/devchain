/**
 * Layer: component integration test
 *
 * Why this layer: The theme-warning path spans runtimeInfo.bootId, a direct
 * fetchActiveSessions call (not dockSessions), localStorage, and the modal
 * surface. RTL at the component layer is the minimal harness that verifies
 * all four touchpoints without a running server.
 */
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Layout } from './Layout';
import type { ActiveSession } from '../lib/sessions';

// ── Module mocks ─────────────────────────────────────────────────────────────

const toastSpy = jest.fn();
const fetchActiveSessionsMock = jest.fn<Promise<ActiveSession[]>, [string?]>();
const useSelectedProjectMock = jest.fn();
const useRuntimeMock = jest.fn();

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
  useAppSocket: jest.fn(),
}));

jest.mock('../hooks/useRuntime', () => ({
  RuntimeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useRuntime: () => useRuntimeMock(),
}));

jest.mock('../hooks/useWorktreeTab', () => ({
  WorktreeTabProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useOptionalWorktreeTab: () => ({
    activeWorktree: null,
    setActiveWorktree: jest.fn(),
    apiBase: '',
  }),
}));

jest.mock('../terminal-windows', () => ({
  TerminalWindowsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TerminalWindowsLayer: () => null,
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

jest.mock('./cloud/CloudStatusIndicator', () => ({
  CloudStatusIndicator: () => null,
}));

jest.mock('./shared/AutoCompactEnableModal', () => ({
  AutoCompactEnableModal: () => null,
}));

jest.mock('../pages/ReviewsPage.lazy', () => ({
  preloadReviewsPage: jest.fn(),
}));

// Expose a minimal trigger so tests can fire onChange without fighting Radix portals.
jest.mock('@/ui/components/ThemeSelect', () => ({
  ThemeSelect: ({ onChange }: { value: string; onChange: (v: string) => void }) => (
    <button data-testid="theme-trigger" onClick={() => onChange('dark')}>
      Change Theme
    </button>
  ),
  getStoredTheme: () => 'ocean',
}));

jest.mock('../lib/sessions', () => ({
  fetchActiveSessions: (...args: unknown[]) => fetchActiveSessionsMock(...(args as [string?])),
}));

// ── DOM polyfills ─────────────────────────────────────────────────────────────

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

if (!HTMLElement.prototype.hasPointerCapture) HTMLElement.prototype.hasPointerCapture = () => false;
if (!HTMLElement.prototype.setPointerCapture) HTMLElement.prototype.setPointerCapture = () => {};
if (!HTMLElement.prototype.releasePointerCapture)
  HTMLElement.prototype.releasePointerCapture = () => {};
if (!HTMLElement.prototype.scrollIntoView) HTMLElement.prototype.scrollIntoView = () => {};

// ── Fixture data ──────────────────────────────────────────────────────────────

const RUNNING_SESSION: ActiveSession = {
  id: 'sess-1',
  epicId: null,
  agentId: 'agent-1',
  tmuxSessionId: 'tmux-1',
  status: 'running',
  startedAt: new Date().toISOString(),
  endedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

// ── Render helper ─────────────────────────────────────────────────────────────

async function renderLayout(bootId = 'boot-id-test') {
  useRuntimeMock.mockReturnValue({
    runtimeInfo: { mode: 'normal', version: '1.0.0', bootId },
    runtimeLoading: false,
    isMainMode: false,
    dockerAvailable: false,
    cloudUiEnabled: false,
  });

  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
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
      return { ok: true, json: async () => ({ version: '1.0.0' }) } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response;
  }) as unknown as typeof fetch;

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/projects']}>
        <Layout>
          <div>Content</div>
        </Layout>
      </MemoryRouter>
    </QueryClientProvider>,
  );

  await act(async () => {
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
  });
}

async function triggerThemeChange() {
  await act(async () => {
    screen.getByTestId('theme-trigger').click();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

async function expectThemeNotice() {
  const dialog = await screen.findByRole('dialog', { name: /restart agent terminals/i });
  expect(dialog).toHaveTextContent(/restarted or reloaded separately/i);
  expect(dialog).toHaveTextContent(/codex and claude/i);
  expect(dialog).toHaveTextContent('/theme');
  expect(screen.getByRole('button', { name: /i understand/i })).toBeInTheDocument();
}

async function acknowledgeThemeNotice() {
  await act(async () => {
    screen.getByRole('button', { name: /i understand/i }).click();
    await Promise.resolve();
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Layout theme-switch warning', () => {
  beforeEach(() => {
    localStorage.clear();
    toastSpy.mockReset();
    fetchActiveSessionsMock.mockReset();
    useRuntimeMock.mockReset();
    useSelectedProjectMock.mockReturnValue({
      projects: [{ id: 'project-1', name: 'Project One', rootPath: '/tmp/project-one' }],
      projectsLoading: false,
      projectsError: false,
      refetchProjects: jest.fn(),
      selectedProjectId: 'project-1',
      selectedProject: { id: 'project-1', name: 'Project One', rootPath: '/tmp/project-one' },
      setSelectedProjectId: jest.fn(),
    });
  });

  it('shows acknowledgement modal when theme changes while active sessions exist', async () => {
    fetchActiveSessionsMock.mockResolvedValue([RUNNING_SESSION]);
    await renderLayout();
    await triggerThemeChange();

    await expectThemeNotice();
    await acknowledgeThemeNotice();
    expect(
      screen.queryByRole('dialog', { name: /restart agent terminals/i }),
    ).not.toBeInTheDocument();
    expect(toastSpy).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Theme changed' }));
  });

  it('does not show acknowledgement modal when no active sessions exist', async () => {
    fetchActiveSessionsMock.mockResolvedValue([]);
    await renderLayout();
    await triggerThemeChange();

    // Wait for the fetch to prove the flow ran (runtimeInfo.bootId was available)
    await waitFor(() => expect(fetchActiveSessionsMock).toHaveBeenCalled());
    expect(
      screen.queryByRole('dialog', { name: /restart agent terminals/i }),
    ).not.toBeInTheDocument();
  });

  it('suppresses repeat modal for the same boot id via localStorage', async () => {
    const bootId = 'boot-id-persisted';
    localStorage.setItem(`devchain:theme-warning-shown:${bootId}`, 'true');
    fetchActiveSessionsMock.mockResolvedValue([RUNNING_SESSION]);

    await renderLayout(bootId);
    await triggerThemeChange();

    // localStorage check fires before fetchActiveSessions is reached
    expect(fetchActiveSessionsMock).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('dialog', { name: /restart agent terminals/i }),
    ).not.toBeInTheDocument();
  });

  it('suppresses repeat modal for the same boot id via in-memory set on second change', async () => {
    fetchActiveSessionsMock.mockResolvedValue([RUNNING_SESSION]);
    await renderLayout('boot-id-inmem');

    // First change: modal fires and in-memory set is populated
    await triggerThemeChange();
    await expectThemeNotice();
    await acknowledgeThemeNotice();

    toastSpy.mockClear();
    fetchActiveSessionsMock.mockClear();

    // Second change: in-memory set blocks before reaching fetchActiveSessions
    await triggerThemeChange();
    expect(fetchActiveSessionsMock).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('dialog', { name: /restart agent terminals/i }),
    ).not.toBeInTheDocument();
  });

  it('allows modal again for a different boot id', async () => {
    // A stale entry for a different boot id must not suppress the current process
    localStorage.setItem('devchain:theme-warning-shown:old-boot-id', 'true');
    fetchActiveSessionsMock.mockResolvedValue([RUNNING_SESSION]);

    await renderLayout('new-boot-id');
    await triggerThemeChange();

    await expectThemeNotice();
  });

  it('shows modal via fetchActiveSessions even when dockSessions is empty (collapsed dock)', async () => {
    // TerminalDock is mocked so dockSessions stays [] throughout the test.
    // Modal eligibility must use fetchActiveSessions, not dockSessions.
    fetchActiveSessionsMock.mockResolvedValue([RUNNING_SESSION]);
    await renderLayout();
    await triggerThemeChange();

    await waitFor(() => {
      expect(fetchActiveSessionsMock).toHaveBeenCalled();
    });
    await expectThemeNotice();
  });

  it('shows modal once in-memory when localStorage is unavailable', async () => {
    fetchActiveSessionsMock.mockResolvedValue([RUNNING_SESSION]);
    await renderLayout('boot-id-no-storage');

    // Patch localStorage AFTER component is mounted so state initializers are unaffected.
    // Only intercept the theme-warning key so Layout's own effects remain stable.
    const THEME_KEY_PREFIX = 'devchain:theme-warning-shown:';
    const originalGetItem = Storage.prototype.getItem;
    const originalSetItem = Storage.prototype.setItem;

    Storage.prototype.getItem = function (key: string) {
      if (key.startsWith(THEME_KEY_PREFIX)) throw new Error('storage unavailable');
      return originalGetItem.call(this, key);
    };
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key.startsWith(THEME_KEY_PREFIX)) throw new Error('storage unavailable');
      return originalSetItem.call(this, key, value);
    };

    try {
      // First change: localStorage throws for the theme key, but in-memory set + fetch opens modal
      await triggerThemeChange();
      await expectThemeNotice();
      await acknowledgeThemeNotice();

      // Second change: in-memory set suppresses — fetchActiveSessions not called again
      toastSpy.mockClear();
      fetchActiveSessionsMock.mockClear();
      await triggerThemeChange();
      expect(fetchActiveSessionsMock).not.toHaveBeenCalled();
      expect(
        screen.queryByRole('dialog', { name: /restart agent terminals/i }),
      ).not.toBeInTheDocument();
    } finally {
      Storage.prototype.getItem = originalGetItem;
      Storage.prototype.setItem = originalSetItem;
    }
  });
});
