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

// The context's bound fetch routes the real TerminalDock session queries through the
// global fetch mock, so the gate test can observe every request the dock issues.
const mockBackendContext = {
  activeBackend: 'home',
  get activeRemote() {
    return mockActiveRemote;
  },
  ready: true,
  bindings: new Map<string, string>(),
  bindingsError: null,
  retry: jest.fn(),
  apiFetch: (input: RequestInfo | URL, init?: RequestInit) => global.fetch(input, init),
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

function onlineRemote(): MockRemote {
  return { id: 'remote-1', name: 'build-vm', online: true, version: '1.0.0', versionMatches: true };
}

beforeEach(() => {
  mockActiveRemote = null;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input: unknown) => {
    const url = typeof input === 'string' ? input : String(input);
    if (url.startsWith('/api/sessions')) {
      return { ok: true, json: async () => [] };
    }
    if (url.includes('/api/remotes/remote-1/stats/history')) {
      return { ok: true, json: async () => sampleBody() };
    }
    return { ok: true, json: async () => ({}) };
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

function sessionRequestCount(): number {
  return fetchMock.mock.calls.filter((call) => String(call[0]).startsWith('/api/sessions')).length;
}

function renderLayout(queryClient: QueryClient) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/']}>
        <Layout>
          <div>page content</div>
        </Layout>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function rerenderLayout(view: ReturnType<typeof render>, queryClient: QueryClient) {
  view.rerender(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/']}>
        <Layout>
          <div>page content</div>
        </Layout>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/**
 * Gate behavior with the real TerminalDock and its real sessions query wired through a
 * mocked transport: the dock only requests sessions while it is actually mounted, so the
 * status row must freeze the session traffic for as long as the remote is unusable.
 */
describe('Layout remote metrics gate with the real dock', () => {
  it('stops and resumes the dock session query across offline and recovery', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockActiveRemote = onlineRemote();
    const view = renderLayout(queryClient);

    // Online: the real dock mounts and its sessions query runs.
    await waitFor(() => {
      expect(screen.getByRole('region', { name: 'Terminal session dock' })).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(sessionRequestCount()).toBeGreaterThanOrEqual(1);
    });
    const onlineCount = sessionRequestCount();

    // Offline: the status row replaces the dock and no further session request runs.
    mockActiveRemote = { ...onlineRemote(), online: false };
    rerenderLayout(view, queryClient);
    await screen.findByTestId('remote-status-row');
    expect(screen.getByTestId('remote-metrics-strip')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Terminal session dock' })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'CPU 42%' })).toBeInTheDocument();
    });
    expect(sessionRequestCount()).toBe(onlineCount);

    // Recovery: the dock returns and its sessions query resumes.
    mockActiveRemote = onlineRemote();
    rerenderLayout(view, queryClient);
    await screen.findByRole('region', { name: 'Terminal session dock' });
    expect(screen.queryByTestId('remote-status-row')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(sessionRequestCount()).toBeGreaterThan(onlineCount);
    });
  });

  it('freezes the dock session query while a version mismatch gates the dock', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockActiveRemote = onlineRemote();
    const view = renderLayout(queryClient);

    await waitFor(() => {
      expect(screen.getByRole('region', { name: 'Terminal session dock' })).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(sessionRequestCount()).toBeGreaterThanOrEqual(1);
    });
    const gatedCount = sessionRequestCount();

    mockActiveRemote = { ...onlineRemote(), version: '0.9.0', versionMatches: false };
    rerenderLayout(view, queryClient);
    const row = await screen.findByTestId('remote-status-row');
    expect(row).toHaveTextContent('Remote "build-vm" needs update');
    expect(screen.queryByRole('region', { name: 'Terminal session dock' })).not.toBeInTheDocument();
    expect(sessionRequestCount()).toBe(gatedCount);
  });
});
