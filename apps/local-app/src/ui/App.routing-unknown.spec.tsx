/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  TerminalDock: () => <div data-testid="reviewer-terminal-dock" />,
  OPEN_TERMINAL_DOCK_EVENT: 'devchain:terminal-dock:open',
}));
jest.mock('./pages/ChatPage', () => ({ ChatPage: () => <h1>Chat Page</h1> }));
// A project consumer in the shell itself (outside the page gate), as Layout's own
// project queries are: its request must be refused by the transport while routing is unknown.
const shellProbeResults: string[] = [];
jest.mock('./components/ThemeSelect', () => {
  const actual = jest.requireActual('./components/ThemeSelect');
  const { useEffect } = jest.requireActual('react');
  const { useFetchFactory } = jest.requireActual('./hooks/useFetchFactory');
  return {
    ...actual,
    ThemeSelect: () => {
      const fetchFn = useFetchFactory();
      useEffect(() => {
        fetchFn('/api/epics/shell-probe').then(
          () => shellProbeResults.push('sent'),
          (error: Error) => shellProbeResults.push(error.name),
        );
      }, [fetchFn]);
      return null;
    },
  };
});

// Issues one project-routed request through the bound fetch, like every real project page.
jest.mock('./pages/BoardPage', () => {
  const { useEffect } = jest.requireActual('react');
  const { useFetchFactory } = jest.requireActual('./hooks/useFetchFactory');
  return {
    BoardPage: () => {
      const fetchFn = useFetchFactory();
      useEffect(() => {
        void fetchFn('/api/epics/board-probe').catch(() => undefined);
      }, [fetchFn]);
      return <h1>Native Board Page</h1>;
    },
  };
});
jest.mock('./pages/ReviewsPage.lazy', () => ({
  ReviewsPageWithSuspense: () => <h1>Reviews Page</h1>,
}));
jest.mock('./pages/ReviewDetailPage.lazy', () => ({
  ReviewDetailPageWithSuspense: () => <h1>Review Detail Page</h1>,
}));

import { App } from './App';
import { isHomeRoute } from './lib/home-routes';
import { extractPathname, isHomeAlwaysRoute } from './lib/api-transport';

const REMOTE_ID = '11111111-1111-4111-8111-111111111111';
const BOUND_PROJECT = 'bound-project';

let remoteOnline = true;
let mockFailedEndpoint: string | null = null;
const requests: Array<{ url: string; method: string }> = [];

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

function mockBackendFetch() {
  global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    requests.push({ url, method: (init?.method ?? 'GET').toUpperCase() });
    if (url === mockFailedEndpoint) return Promise.reject(new Error('temporary lookup failure'));

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
}

function renderAt(path: string, queryClient: QueryClient) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// Every request issued while routing is unknown must be one the transport can place
// without the binding map: non-API, home-always, or never proxied to a remote.
async function expectOnlyRoutingFreeRequests() {
  await waitFor(() => expect(shellProbeResults).toContain('ROUTING_UNKNOWN'));
  expect(shellProbeResults).not.toContain('sent');
  for (const { url, method } of requests) {
    expect(url.startsWith('/r/')).toBe(false);
    const pathname = extractPathname(url) ?? url;
    if (pathname.startsWith('/api/')) {
      expect({ url, homeAlways: isHomeAlwaysRoute(pathname, method) }).toEqual({
        url,
        homeAlways: true,
      });
    }
  }
}

describe.each(['/api/remotes/bindings', '/api/remotes'])(
  'with a bound project selected and %s failing',
  (failedEndpoint) => {
    let queryClient: QueryClient;

    beforeEach(() => {
      remoteOnline = true;
      mockFailedEndpoint = failedEndpoint;
      requests.length = 0;
      shellProbeResults.length = 0;
      queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      mockBackendFetch();
    });

    afterEach(() => {
      jest.clearAllMocks();
    });

    it('renders Cloud > Remote VM on the home cache', async () => {
      renderAt('/cloud?section=remote-vm', queryClient);

      await screen.findByRole('tab', { name: 'Overview' });
      expect(screen.queryByTestId('backend-bindings-error')).not.toBeInTheDocument();
      expect(screen.queryByTestId('reviewer-terminal-dock')).not.toBeInTheDocument();
      await expectOnlyRoutingFreeRequests();
    });

    it('shows the retryable error panel instead of a project page', async () => {
      renderAt('/board', queryClient);

      await screen.findByTestId('backend-bindings-error');
      expect(screen.queryByRole('heading', { name: 'Native Board Page' })).not.toBeInTheDocument();
      expect(screen.queryByTestId('reviewer-terminal-dock')).not.toBeInTheDocument();
      await expectOnlyRoutingFreeRequests();
    });

    it('mounts the project page on the remote once Retry succeeds', async () => {
      renderAt('/board', queryClient);
      await screen.findByTestId('backend-bindings-error');
      expect(isHomeRoute('/board')).toBe(false);

      mockFailedEndpoint = null;
      fireEvent.click(screen.getByRole('button', { name: /retry/i }));

      await screen.findByRole('heading', { name: 'Native Board Page' });
      expect(screen.queryByTestId('backend-bindings-error')).not.toBeInTheDocument();
      await waitFor(() =>
        expect(requests.map(({ url }) => url)).toContain(`/r/${REMOTE_ID}/api/epics/board-probe`),
      );
      expect(requests.map(({ url }) => url)).not.toContain('/api/epics/board-probe');
    });
  },
);
