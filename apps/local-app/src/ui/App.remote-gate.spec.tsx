/** @jest-environment jsdom */

import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Polyfill window.matchMedia for Layout's responsive sidebar
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

// Mock components that use ESM-only modules (must be before App import)
jest.mock('./components/review/DiffViewer', () => ({ DiffViewer: () => null }));
jest.mock('./components/review/FileNavigator', () => ({ FileNavigator: () => null }));
jest.mock('./components/review/CommentPanel', () => ({ CommentPanel: () => null }));
jest.mock('./components/review/KeyboardShortcutsHelp', () => ({
  KeyboardShortcutsHelp: () => null,
}));
jest.mock('./hooks/useReviewSubscription', () => ({ useReviewSubscription: jest.fn() }));
jest.mock('./hooks/useCommentMutations', () => ({
  useCreateComment: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useReplyToComment: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));
jest.mock('./hooks/useAppSocket', () => ({
  useAppSocket: jest.fn(() => ({
    connected: true,
    on: jest.fn(),
    off: jest.fn(),
    emit: jest.fn(),
  })),
}));
jest.mock('./lib/socket', () => ({
  getAppSocket: jest.fn(() => ({
    connected: true,
    on: jest.fn(),
    off: jest.fn(),
    emit: jest.fn(),
  })),
  releaseAppSocket: jest.fn(),
}));
jest.mock('./hooks/useKeyboardShortcuts', () => ({
  useKeyboardShortcuts: () => ({ isHelpOpen: false, closeHelp: jest.fn(), openHelp: jest.fn() }),
}));
jest.mock('./terminal-windows', () => ({
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
jest.mock('./components/terminal-dock', () => ({
  TerminalDock: () => <div data-testid="terminal-dock-sentinel" />,
  OPEN_TERMINAL_DOCK_EVENT: 'devchain:terminal-dock:open',
}));
jest.mock('./pages/ChatPage', () => ({ ChatPage: () => <h1>Chat Page</h1> }));
jest.mock('./pages/BoardPage', () => ({ BoardPage: () => <h1>Native Board Page</h1> }));
jest.mock('./pages/ReviewsPage.lazy', () => ({
  ReviewsPageWithSuspense: () => <h1>Reviews Page</h1>,
}));
jest.mock('./pages/ReviewDetailPage.lazy', () => ({
  ReviewDetailPageWithSuspense: () => <h1>Review Detail Page</h1>,
}));

import { App } from './App';

const REMOTE_ID = '11111111-1111-4111-8111-111111111111';
const BOUND_PROJECT = 'bound-project';

let remoteOnline = false;

jest.mock('./hooks/useProjectSelection', () => ({
  ProjectSelectionProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useSelectedProject: () => ({
    selectedProjectId: BOUND_PROJECT,
    selectedProject: { id: BOUND_PROJECT, name: 'Bound Project' },
    projects: [],
    projectsLoading: false,
    projectsError: null,
    refetchProjects: jest.fn(),
    setSelectedProjectId: jest.fn(),
  }),
}));

jest.mock('./hooks/use-toast', () => ({
  useToast: () => ({ toasts: [], toast: jest.fn(), dismiss: jest.fn() }),
}));

jest.mock('./lib/preflight', () => ({
  fetchPreflightChecks: jest.fn().mockResolvedValue({
    overall: 'pass',
    checks: [],
    providers: [],
    timestamp: new Date().toISOString(),
  }),
}));

// The bound project's remote is offline for every test in this file: CRITICAL 3's scenario.
describe("Home routes stay reachable while the active project's remote is unusable", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    remoteOnline = false;
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url === '/api/remotes/bindings') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            items: [{ projectId: BOUND_PROJECT, remoteId: REMOTE_ID, state: 'remote' }],
          }),
        } as Response);
      }
      if (url === '/api/remotes') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            items: [
              {
                id: REMOTE_ID,
                name: 'lab-vm',
                online: remoteOnline,
                version: '1.0.0',
                versionMatches: true,
              },
            ],
          }),
        } as Response);
      }
      if (url.startsWith('/api/runtime')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            mode: 'normal',
            version: '1.0.0',
            integrationAdmission: { allowed: true, reason: null },
            features: { cloudUi: true },
          }),
        } as Response);
      }
      if (url.startsWith('/api/settings')) {
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
      }
      if (url.startsWith('/api/preflight')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            overall: 'pass',
            checks: [],
            providers: [],
            timestamp: new Date().toISOString(),
          }),
        } as Response);
      }
      if (url.startsWith('/api/integrations/connections')) {
        return Promise.resolve({ ok: true, json: async () => ({ items: [] }) } as Response);
      }

      return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
    }) as jest.Mock;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('renders Cloud > Remote VM but keeps the terminal dock gated behind its own status row', async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/cloud?section=remote-vm']}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await screen.findByRole('tab', { name: 'Overview' });
    expect(screen.queryByTestId('terminal-dock-sentinel')).not.toBeInTheDocument();
    // Only the dock's gate blocks here; the page content isn't gated on this route.
    // The terminal gate swaps the amber banner for the metrics status row.
    expect(screen.queryByTestId('remote-unavailable-banner')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('remote-status-row')).toHaveLength(1);
  });

  it('still gates both the page content and the terminal dock on /board', async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/board']}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      // The page scope keeps the amber banner; the terminal scope shows the status row.
      expect(screen.getAllByTestId('remote-unavailable-banner')).toHaveLength(1);
      expect(screen.getAllByTestId('remote-status-row')).toHaveLength(1);
    });
    expect(screen.queryByRole('heading', { name: 'Native Board Page' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('terminal-dock-sentinel')).not.toBeInTheDocument();
  });
});
