import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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

  beforeEach(() => {
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
});
