import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const GB = 1024 ** 3;

interface MockRemote {
  id: string;
  name: string;
  online: boolean;
  version: string | null;
  versionMatches: boolean;
}

let mockActiveRemote: MockRemote | null = null;
const mockBackendContext = {
  activeBackend: 'home',
  get activeRemote() {
    return mockActiveRemote;
  },
  ready: true,
  bindings: new Map<string, string>(),
  bindingsError: null,
  retry: jest.fn(),
  apiFetch: jest.fn(),
  buildApiUrl: jest.fn(),
};

jest.mock('../lib/backend-context', () => ({
  useOptionalBackend: () => mockBackendContext,
}));

// Polyfill window.matchMedia
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: jest.fn().mockImplementation((query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addListener: jest.fn(),
    removeListener: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    dispatchEvent: jest.fn(),
  })),
});

jest.mock('../hooks/useAppSocket', () => ({
  useAppSocket: jest.fn(),
}));

jest.mock('../lib/socket', () => ({
  getAppSocket: jest.fn(() => ({
    connected: true,
    on: jest.fn(),
    off: jest.fn(),
    emit: jest.fn(),
  })),
  releaseAppSocket: jest.fn(),
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
  TerminalDock: ({ rightSlot }: { rightSlot?: React.ReactNode }) => (
    <div data-testid="terminal-dock">{rightSlot}</div>
  ),
  OPEN_TERMINAL_DOCK_EVENT: 'devchain:terminal-dock:open',
}));

jest.mock('../hooks/useProjectSelection', () => ({
  useSelectedProject: () => ({
    workspaces: [],
    selectedWorkspaceId: undefined,
    setSelectedWorkspaceId: jest.fn(),
    selectedProjectId: 'project-1',
    selectedProject: null,
    projects: [],
    projectsLoading: false,
    projectsError: null,
    refetchProjects: jest.fn(),
    setSelectedProjectId: jest.fn(),
  }),
}));

jest.mock('../hooks/use-toast', () => ({
  useToast: () => ({ toasts: [], toast: jest.fn(), dismiss: jest.fn() }),
}));

jest.mock('../lib/preflight', () => ({
  fetchPreflightChecks: jest.fn().mockResolvedValue({
    overall: 'pass',
    checks: [],
    providers: [],
    timestamp: new Date().toISOString(),
  }),
}));

jest.mock('./cloud/CloudStatusIndicator', () => ({
  CloudStatusIndicator: ({ compact }: { compact?: boolean }) => (
    <div data-testid="cloud-indicator" data-compact={compact ? 'true' : 'false'} />
  ),
}));

jest.mock('@/ui/components/ThemeSelect', () => ({
  ThemeSelect: () => null,
  getStoredTheme: () => 'ocean',
}));

jest.mock('./shared', () => ({
  ToastHost: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Breadcrumbs: () => null,
  EpicSearchInput: () => null,
}));

jest.mock('./shared/AutoCompactEnableModal', () => ({
  AutoCompactEnableModal: () => null,
}));

jest.mock('../pages/ReviewsPage.lazy', () => ({
  preloadReviewsPage: jest.fn(),
}));

jest.mock('../hooks/useBreadcrumbs', () => ({
  BreadcrumbsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useBreadcrumbs: () => ({ items: [] }),
}));

jest.mock('../hooks/useRuntime', () => ({
  useRuntime: () => ({ cloudUiEnabled: true }),
}));

import { Layout } from './Layout';

const fetchMock = jest.fn();

function sampleBody() {
  return {
    intervalMs: 10_000,
    samples: [
      {
        cpuPercent: 42,
        load1: 0.5,
        load5: 0.7,
        memTotalBytes: 16 * GB,
        memUsedBytes: 8 * GB,
        diskTotalBytes: 100 * GB,
        diskUsedBytes: 50 * GB,
        diskAvailBytes: 25 * GB,
        uptimeSec: 90_061,
        sampledAt: '2026-09-26T12:00:00Z',
      },
    ],
  };
}

function renderLayout() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/']}>
        <Layout>
          <div>page content</div>
        </Layout>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { view, queryClient };
}

function onlineRemote(): MockRemote {
  return { id: 'remote-1', name: 'build-vm', online: true, version: '1.0.0', versionMatches: true };
}

beforeEach(() => {
  mockActiveRemote = null;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input: unknown) => {
    const url = typeof input === 'string' ? input : String(input);
    if (url.includes('/api/remotes/remote-1/stats/history')) {
      return { ok: true, json: async () => sampleBody() };
    }
    return { ok: true, json: async () => ({}) };
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

function requestedUrls(): string[] {
  return fetchMock.mock.calls.map((call) => String(call[0]));
}

describe('Layout remote metrics integration', () => {
  it('shows the metrics strip and the compact cloud indicator for a remote project', async () => {
    mockActiveRemote = onlineRemote();
    renderLayout();

    // The strip mounts as "Waiting for stats" until the history query resolves.
    expect(await screen.findByRole('button', { name: 'CPU 42%' })).toBeInTheDocument();

    expect(screen.getByTestId('remote-metrics-strip')).toBeInTheDocument();
    expect(screen.getByTestId('cloud-indicator')).toHaveAttribute('data-compact', 'true');
    expect(screen.getByTestId('terminal-dock')).toBeInTheDocument();

    await waitFor(() => {
      expect(requestedUrls()).toContain('/api/remotes/remote-1/stats/history');
    });
  });

  it('keeps the home project unchanged: email indicator, no strip', async () => {
    mockActiveRemote = null;
    renderLayout();

    expect(await screen.findByTestId('terminal-dock')).toBeInTheDocument();
    expect(screen.queryByTestId('remote-metrics-strip')).not.toBeInTheDocument();
    const indicator = screen.getByTestId('cloud-indicator');
    expect(indicator).toHaveAttribute('data-compact', 'false');
    expect(requestedUrls().some((url) => url.includes('stats/history'))).toBe(false);
  });

  it('replaces the dock with the status row while the remote is offline and runs no session queries', async () => {
    mockActiveRemote = { ...onlineRemote(), online: false };
    renderLayout();

    const row = await screen.findByTestId('remote-status-row');
    expect(row).toHaveAttribute('role', 'alert');
    expect(row).toHaveTextContent('Remote "build-vm" is offline');

    expect(screen.queryByTestId('terminal-dock')).not.toBeInTheDocument();
    expect(screen.getByTestId('remote-metrics-strip')).toBeInTheDocument();
    expect(screen.getByTestId('cloud-indicator')).toHaveAttribute('data-compact', 'true');

    await waitFor(() => {
      expect(requestedUrls()).toContain('/api/remotes/remote-1/stats/history');
    });
    expect(requestedUrls().some((url) => url.includes('/api/sessions'))).toBe(false);
  });

  it('shows the strip in the status row for a version mismatch', async () => {
    mockActiveRemote = {
      ...onlineRemote(),
      version: '0.9.0',
      versionMatches: false,
    };
    renderLayout();

    const row = await screen.findByTestId('remote-status-row');
    expect(row).toHaveTextContent('Remote "build-vm" needs update');
    expect(screen.getByTestId('remote-metrics-strip')).toBeInTheDocument();
    expect(screen.queryByTestId('terminal-dock')).not.toBeInTheDocument();
  });
});
