import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Mock useSelectedProject
const mockUseSelectedProject = jest.fn();
jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => mockUseSelectedProject(),
}));

// Mock useDevicesQuery (used by real ProjectForwardingRow)
const mockUseDevicesQuery = jest.fn();
jest.mock('@/ui/hooks/useDevicesQuery', () => ({
  useDevicesQuery: () => mockUseDevicesQuery(),
}));

// Mock tooltip components for jsdom compatibility
jest.mock('../ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-provider">{children}</div>
  ),
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
}));

// Mock fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

import { ProjectForwardingList } from './ProjectForwardingList';

function renderWithClient(ui: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const PROJECTS = [
  { id: 'p1', name: 'Project One', rootPath: '/tmp/p1' },
  { id: 'p2', name: 'Project Two', rootPath: '/tmp/p2' },
];

const DEVICES_READY_EMPTY = {
  status: 'ready' as const,
  devices: [],
  devicesAvailable: true,
  refetch: jest.fn(),
};

function mockGetFetch(enabledMap: Record<string, boolean>) {
  return (url: string, opts?: RequestInit) => {
    if (opts?.method === 'PUT') {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ enabled: true }),
      } as Response);
    }
    const projectId = url.split('/').pop()!;
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ enabled: enabledMap[projectId] ?? false }),
    } as Response);
  };
}

describe('ProjectForwardingList', () => {
  beforeEach(() => {
    global.fetch = mockFetch;
    mockUseSelectedProject.mockReset();
    mockFetch.mockReset();
    mockUseDevicesQuery.mockReset().mockReturnValue(DEVICES_READY_EMPTY);
  });

  it('renders loading state', () => {
    mockUseSelectedProject.mockReturnValue({ projects: [], projectsLoading: true });
    renderWithClient(<ProjectForwardingList />);
    expect(screen.getByText('Loading projects...')).toBeInTheDocument();
  });

  it('renders empty state when no projects', () => {
    mockUseSelectedProject.mockReturnValue({ projects: [], projectsLoading: false });
    renderWithClient(<ProjectForwardingList />);
    expect(screen.getByText('Add a project to manage its notifications')).toBeInTheDocument();
  });

  it('renders header and rows', async () => {
    mockFetch.mockImplementation(mockGetFetch({ p1: true, p2: true }));
    mockUseSelectedProject.mockReturnValue({ projects: PROJECTS, projectsLoading: false });
    renderWithClient(<ProjectForwardingList />);

    await waitFor(() => {
      expect(screen.getByText('Per-project forwarding')).toBeInTheDocument();
    });
    expect(screen.getByText('Project One')).toBeInTheDocument();
    expect(screen.getByText('Project Two')).toBeInTheDocument();
  });

  it('flips to "Disable all" after all queries resolve enabled', async () => {
    mockFetch.mockImplementation(mockGetFetch({ p1: true, p2: true }));
    mockUseSelectedProject.mockReturnValue({ projects: PROJECTS, projectsLoading: false });
    renderWithClient(<ProjectForwardingList />);

    // Button starts as "Enable all" while queries load
    expect(screen.getByRole('button', { name: /Enable all|Disable all/ })).toHaveTextContent(
      'Enable all',
    );

    // After queries resolve, button flips to "Disable all"
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Enable all|Disable all/ })).toHaveTextContent(
        'Disable all',
      );
    });
  });

  it('shows "Enable all" for mixed states', async () => {
    mockFetch.mockImplementation(mockGetFetch({ p1: true, p2: false }));
    mockUseSelectedProject.mockReturnValue({ projects: PROJECTS, projectsLoading: false });
    renderWithClient(<ProjectForwardingList />);

    await waitFor(() => {
      expect(screen.getByText('Project One')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /Enable all|Disable all/ })).toHaveTextContent(
      'Enable all',
    );
  });

  it('shows "Enable all" when all disabled', async () => {
    mockFetch.mockImplementation(mockGetFetch({ p1: false, p2: false }));
    mockUseSelectedProject.mockReturnValue({ projects: PROJECTS, projectsLoading: false });
    renderWithClient(<ProjectForwardingList />);

    await waitFor(() => {
      expect(screen.getByText('Project One')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /Enable all|Disable all/ })).toHaveTextContent(
      'Enable all',
    );
  });

  it('bulk Enable all: fires N PUTs and updates state', async () => {
    mockFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (opts?.method === 'PUT') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ enabled: true }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ enabled: false }),
      } as Response);
    });
    mockUseSelectedProject.mockReturnValue({ projects: PROJECTS, projectsLoading: false });
    renderWithClient(<ProjectForwardingList />);

    // Wait for initial queries to resolve
    await waitFor(() => {
      expect(screen.getByText('Project One')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: /Enable all/ }));

    // Verify N PUT requests fired
    const putCalls = mockFetch.mock.calls.filter(
      (call: unknown[]) => call.length > 1 && (call[1] as RequestInit)?.method === 'PUT',
    );
    expect(putCalls).toHaveLength(2);

    // Button label updates after optimistic update
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Enable all|Disable all/ })).toHaveTextContent(
        'Disable all',
      );
    });
  });

  it('bulk partial failure: rolls back failed row', async () => {
    mockFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (opts?.method === 'PUT') {
        if (url.includes('/p2')) {
          return Promise.resolve({ ok: false, status: 500 } as Response);
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ enabled: true }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ enabled: false }),
      } as Response);
    });
    mockUseSelectedProject.mockReturnValue({ projects: PROJECTS, projectsLoading: false });
    renderWithClient(<ProjectForwardingList />);

    await waitFor(() => {
      expect(screen.getByText('Project One')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: /Enable all/ }));

    // After bulk with partial failure, button label reflects actual state
    // p1 succeeded (enabled), p2 rolled back to false → not all enabled → "Enable all"
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Enable all|Disable all/ })).toHaveTextContent(
        'Enable all',
      );
    });
  });

  it('bulk-pending disables rows during in-flight fetch (Inv 15)', async () => {
    const resolvers: Array<() => void> = [];
    mockFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (opts?.method === 'PUT') {
        return new Promise<Response>((resolve) => {
          resolvers.push(() =>
            resolve({ ok: true, status: 200, json: async () => ({ enabled: true }) } as Response),
          );
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ enabled: false }),
      } as Response);
    });
    mockUseSelectedProject.mockReturnValue({ projects: PROJECTS, projectsLoading: false });
    renderWithClient(<ProjectForwardingList />);

    await waitFor(() => {
      expect(screen.getByText('Project One')).toBeInTheDocument();
    });

    const button = screen.getByRole('button', { name: /Enable all/ });
    expect(button).not.toBeDisabled();

    await act(async () => {
      fireEvent.click(button);
      await new Promise((r) => {
        setTimeout(r, 0);
      });
    });

    // Button disabled during flight
    expect(screen.getByRole('button', { name: /Enable all|Disable all/ })).toBeDisabled();

    // Resolve all pending PUT fetches
    await act(async () => {
      resolvers.forEach((r) => r());
      await new Promise((r) => {
        setTimeout(r, 0);
      });
    });

    expect(screen.getByRole('button', { name: /Enable all|Disable all/ })).not.toBeDisabled();
  });

  it('per-row toggle works after bulk action (regression)', async () => {
    let p1Enabled = false;
    mockFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (opts?.method === 'PUT') {
        const body = JSON.parse(opts!.body as string) as { enabled: boolean };
        if (url.includes('/p1')) p1Enabled = body.enabled;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ enabled: body.enabled }),
        } as Response);
      }
      const projectId = url.split('/').pop()!;
      const enabled = projectId === 'p1' ? p1Enabled : false;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ enabled }),
      } as Response);
    });
    mockUseSelectedProject.mockReturnValue({ projects: PROJECTS, projectsLoading: false });
    renderWithClient(<ProjectForwardingList />);

    await waitFor(() => {
      expect(screen.getByText('Project One')).toBeInTheDocument();
    });

    // Bulk enable all
    await userEvent.click(screen.getByRole('button', { name: /Enable all/ }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Enable all|Disable all/ })).toHaveTextContent(
        'Disable all',
      );
    });

    // Per-row toggle on p1 — same query key, should work
    const p1Switch = screen.getByRole('switch', { name: /Push notifications for Project One/ });
    await userEvent.click(p1Switch);
    // After toggling p1 off, not all enabled → "Enable all"
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Enable all|Disable all/ })).toHaveTextContent(
        'Enable all',
      );
    });
  });

  it('summary badge shows enabled count and total', async () => {
    mockFetch.mockImplementation(mockGetFetch({ p1: true, p2: false }));
    mockUseSelectedProject.mockReturnValue({ projects: PROJECTS, projectsLoading: false });
    renderWithClient(<ProjectForwardingList />);

    await waitFor(() => {
      expect(screen.getByText(/1 enabled/)).toBeInTheDocument();
    });
    expect(screen.getByText(/2 projects/)).toBeInTheDocument();
  });

  it('summary badge updates when all enabled', async () => {
    mockFetch.mockImplementation(mockGetFetch({ p1: true, p2: true }));
    mockUseSelectedProject.mockReturnValue({ projects: PROJECTS, projectsLoading: false });
    renderWithClient(<ProjectForwardingList />);

    await waitFor(() => {
      expect(screen.getByText(/2 enabled/)).toBeInTheDocument();
    });
    expect(screen.getByText(/2 projects/)).toBeInTheDocument();
  });

  it('search by name filters displayed rows', async () => {
    mockFetch.mockImplementation(mockGetFetch({ p1: true, p2: true }));
    mockUseSelectedProject.mockReturnValue({ projects: PROJECTS, projectsLoading: false });
    renderWithClient(<ProjectForwardingList />);

    await waitFor(() => expect(screen.getByText('Project One')).toBeInTheDocument());

    const searchInput = screen.getByRole('textbox', { name: /search projects/i });
    await userEvent.type(searchInput, 'One');

    expect(screen.getByText('Project One')).toBeInTheDocument();
    expect(screen.queryByText('Project Two')).not.toBeInTheDocument();
  });

  it('search by rootPath filters displayed rows', async () => {
    mockFetch.mockImplementation(mockGetFetch({ p1: true, p2: true }));
    mockUseSelectedProject.mockReturnValue({ projects: PROJECTS, projectsLoading: false });
    renderWithClient(<ProjectForwardingList />);

    await waitFor(() => expect(screen.getByText('Project One')).toBeInTheDocument());

    const searchInput = screen.getByRole('textbox', { name: /search projects/i });
    await userEvent.type(searchInput, '/tmp/p2');

    expect(screen.queryByText('Project One')).not.toBeInTheDocument();
    expect(screen.getByText('Project Two')).toBeInTheDocument();
  });

  it('shows no-match message when search matches nothing', async () => {
    mockFetch.mockImplementation(mockGetFetch({ p1: true, p2: true }));
    mockUseSelectedProject.mockReturnValue({ projects: PROJECTS, projectsLoading: false });
    renderWithClient(<ProjectForwardingList />);

    await waitFor(() => expect(screen.getByText('Project One')).toBeInTheDocument());

    const searchInput = screen.getByRole('textbox', { name: /search projects/i });
    await userEvent.type(searchInput, 'xyznotfound');

    expect(screen.getByText('No projects match your filters')).toBeInTheDocument();
  });

  it('filter buttons have correct aria-pressed state', async () => {
    mockFetch.mockImplementation(mockGetFetch({ p1: true, p2: true }));
    mockUseSelectedProject.mockReturnValue({ projects: PROJECTS, projectsLoading: false });
    renderWithClient(<ProjectForwardingList />);

    await waitFor(() => expect(screen.getByText('Project One')).toBeInTheDocument());

    const allBtn = screen.getByRole('button', { name: /^All$/ });
    const enabledBtn = screen.getByRole('button', { name: /^Enabled$/ });
    const disabledBtn = screen.getByRole('button', { name: /^Disabled$/ });

    expect(allBtn).toHaveAttribute('aria-pressed', 'true');
    expect(enabledBtn).toHaveAttribute('aria-pressed', 'false');
    expect(disabledBtn).toHaveAttribute('aria-pressed', 'false');

    await userEvent.click(enabledBtn);
    expect(allBtn).toHaveAttribute('aria-pressed', 'false');
    expect(enabledBtn).toHaveAttribute('aria-pressed', 'true');
    expect(disabledBtn).toHaveAttribute('aria-pressed', 'false');
  });

  it('Enabled filter shows only enabled rows', async () => {
    mockFetch.mockImplementation(mockGetFetch({ p1: true, p2: false }));
    mockUseSelectedProject.mockReturnValue({ projects: PROJECTS, projectsLoading: false });
    renderWithClient(<ProjectForwardingList />);

    await waitFor(() => expect(screen.getByText('Project One')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /^Enabled$/ }));

    expect(screen.getByText('Project One')).toBeInTheDocument();
    expect(screen.queryByText('Project Two')).not.toBeInTheDocument();
  });

  it('Disabled filter shows only disabled rows', async () => {
    mockFetch.mockImplementation(mockGetFetch({ p1: true, p2: false }));
    mockUseSelectedProject.mockReturnValue({ projects: PROJECTS, projectsLoading: false });
    renderWithClient(<ProjectForwardingList />);

    await waitFor(() => expect(screen.getByText('Project One')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /^Disabled$/ }));

    expect(screen.queryByText('Project One')).not.toBeInTheDocument();
    expect(screen.getByText('Project Two')).toBeInTheDocument();
  });

  it('bulk action applies to ALL projects regardless of active filter (Inv bulk)', async () => {
    mockFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (opts?.method === 'PUT') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ enabled: true }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ enabled: false }),
      } as Response);
    });
    mockUseSelectedProject.mockReturnValue({ projects: PROJECTS, projectsLoading: false });
    renderWithClient(<ProjectForwardingList />);

    await waitFor(() => expect(screen.getByText('Project One')).toBeInTheDocument());

    // Switch to Enabled filter — shows no rows since all are disabled
    await userEvent.click(screen.getByRole('button', { name: /^Enabled$/ }));
    expect(screen.getByText('No projects match your filters')).toBeInTheDocument();

    // Bulk "Enable all" — must fire PUTs for ALL projects (p1 and p2), not just filtered rows
    await userEvent.click(screen.getByRole('button', { name: /Enable all/ }));

    const putCalls = mockFetch.mock.calls.filter(
      (call: unknown[]) => call.length > 1 && (call[1] as RequestInit)?.method === 'PUT',
    );
    expect(putCalls).toHaveLength(2);
  });
});
