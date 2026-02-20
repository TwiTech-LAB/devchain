import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

let mockActiveWorktree: { id: string; name: string; devchainProjectId: string | null } | null =
  null;

// Mock components that use ESM-only modules (must be before App import)
jest.mock('./components/review/DiffViewer', () => ({
  DiffViewer: () => null,
}));

jest.mock('./components/review/FileNavigator', () => ({
  FileNavigator: () => null,
}));

jest.mock('./components/review/CommentPanel', () => ({
  CommentPanel: () => null,
}));

jest.mock('./components/review/KeyboardShortcutsHelp', () => ({
  KeyboardShortcutsHelp: () => null,
}));

jest.mock('./hooks/useReviewSubscription', () => ({
  useReviewSubscription: jest.fn(),
}));

jest.mock('./hooks/useCommentMutations', () => ({
  useCreateComment: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useReplyToComment: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));

jest.mock('./hooks/useWorktreeTab', () => ({
  useOptionalWorktreeTab: () => ({
    activeWorktree: mockActiveWorktree,
    setActiveWorktree: jest.fn(),
    apiBase: '',
    worktrees: [],
    worktreesLoading: false,
  }),
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
  TerminalDock: () => null,
  OPEN_TERMINAL_DOCK_EVENT: 'devchain:terminal-dock:open',
}));

jest.mock('./pages/WorktreesPage', () => ({
  WorktreesPage: () => <h1>Worktrees Page</h1>,
}));

jest.mock('./pages/ChatPage', () => ({
  ChatPage: () => <h1>Chat Page</h1>,
}));

jest.mock('./pages/ReviewsPage.lazy', () => ({
  ReviewsPageWithSuspense: () => <h1>Reviews Page</h1>,
}));

jest.mock('./pages/ReviewDetailPage.lazy', () => ({
  ReviewDetailPageWithSuspense: () => <h1>Review Detail Page</h1>,
}));

import { App } from './App';

// Mock all the hooks and components that App depends on
jest.mock('./hooks/useProjectSelection', () => ({
  ProjectSelectionProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useSelectedProject: () => ({
    selectedProjectId: null,
    selectedProject: null,
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

describe('App startup routing', () => {
  let queryClient: QueryClient;
  let runtimeMode: 'main' | 'normal';

  beforeEach(() => {
    runtimeMode = 'normal';
    mockActiveWorktree = null;
    queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    // Mock fetch for settings and other API calls
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.startsWith('/api/projects')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ items: [], total: 0, limit: 100, offset: 0 }),
        } as Response);
      }

      if (url.startsWith('/api/settings')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({}),
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

      if (url.startsWith('/api/runtime')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            mode: runtimeMode,
            version: '1.0.0',
          }),
        } as Response);
      }

      return Promise.resolve({
        ok: true,
        json: async () => ({}),
      } as Response);
    }) as jest.Mock;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should start on Projects page without Mode selection prompt', async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/']}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // Wait for initial navigation to complete
    await waitFor(() => {
      // App should redirect from '/' to '/projects'
      // Check for Projects page content (heading or key element)
      const heading = screen.queryByRole('heading', { name: /projects/i });
      expect(heading).toBeInTheDocument();
    });

    // Assert no FirstRunSetup or Mode selection UI is present
    expect(screen.queryByText(/choose your instance mode/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/local mode/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/cloud mode/i)).not.toBeInTheDocument();
  });

  it('should not render FirstRunSetup component', async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/']}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // FirstRunSetup has specific text like "Welcome to Devchain"
    await waitFor(() => {
      expect(screen.queryByText(/welcome to devchain/i)).not.toBeInTheDocument();
    });
  });

  it('should load Projects page as the default route', async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/']}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // Projects page should be rendered (Layout + ProjectsPage)
    await waitFor(() => {
      // Look for the Projects heading which is rendered by ProjectsPage
      const projectsHeading = screen.queryByRole('heading', { name: /projects/i });
      expect(projectsHeading).toBeInTheDocument();
    });
  });

  it('should render /worktrees route in main mode', async () => {
    runtimeMode = 'main';

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/worktrees']}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Worktrees Page' })).toBeInTheDocument();
    });
  });

  it('should render /worktrees route outside main mode', async () => {
    runtimeMode = 'normal';

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/worktrees']}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Worktrees Page' })).toBeInTheDocument();
    });
  });

  it('should keep /chat accessible in main mode', async () => {
    runtimeMode = 'main';

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/chat']}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Chat Page' })).toBeInTheDocument();
    });
  });

  it('should keep /reviews and /reviews/:id accessible in main mode', async () => {
    runtimeMode = 'main';

    const reviewsRender = render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/reviews']}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Reviews Page' })).toBeInTheDocument();
    });

    reviewsRender.unmount();
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/reviews/review-1']}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Review Detail Page' })).toBeInTheDocument();
    });
  });

  it('should keep /chat and /reviews accessible in main mode when a worktree tab is active', async () => {
    runtimeMode = 'main';
    mockActiveWorktree = {
      id: 'wt-1',
      name: 'feature-auth',
      devchainProjectId: 'project-1',
    };

    const chatRender = render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/chat']}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Chat Page' })).toBeInTheDocument();
    });

    chatRender.unmount();
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/reviews/review-1']}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Review Detail Page' })).toBeInTheDocument();
    });
  });

  it('should keep /chat and /reviews accessible outside main mode', async () => {
    runtimeMode = 'normal';

    const chatRender = render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/chat']}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Chat Page' })).toBeInTheDocument();
    });

    chatRender.unmount();
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/reviews']}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Reviews Page' })).toBeInTheDocument();
    });
  });
});
