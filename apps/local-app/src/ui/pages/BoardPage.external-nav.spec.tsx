import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RuntimeProvider } from '@/ui/hooks/useRuntime';
// The real page is under test; do not mock ./BoardPage in this spec.
import { BoardPage } from './BoardPage';

// Layer: UI route regression. Project selection and the shared socket are mocked with the
// same minimal doubles the native URL-filter suite uses, because the contract under test
// is the /board composition (board-source navigation above the real native view), not
// project or realtime plumbing.
const mockSocket = {
  connected: true,
  on: jest.fn(),
  off: jest.fn(),
  emit: jest.fn(),
  disconnect: jest.fn(),
};

jest.mock('@/ui/hooks/useProjectSelection', () => ({
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

jest.mock('socket.io-client', () => ({ io: () => mockSocket }));

function zeroConnectionItems() {
  return {
    items: [
      { provider: 'clickup', connected: false, generation: null, updatedAt: null },
      { provider: 'jira', connected: false, generation: null, updatedAt: null },
    ],
  };
}

function renderBoardRoute({
  integrationAdmission,
}: {
  integrationAdmission: { allowed: boolean; reason: string | null };
}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('/api/runtime')) {
      return {
        ok: true,
        json: async () => ({
          mode: 'normal',
          version: 'test',
          dockerAvailable: false,
          integrationAdmission,
        }),
      } as Response;
    }
    if (url.startsWith('/api/integrations/connections')) {
      return { ok: true, json: async () => zeroConnectionItems() } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response;
  }) as jest.Mock;

  return render(
    <QueryClientProvider client={queryClient}>
      <RuntimeProvider>
        <MemoryRouter initialEntries={['/board']}>
          <Routes>
            <Route path="/board" element={<BoardPage />} />
            <Route path="/board/:providerName" element={<div data-testid="my-work-route" />} />
          </Routes>
        </MemoryRouter>
      </RuntimeProvider>
    </QueryClientProvider>,
  );
}

describe('BoardPage external navigation composition', () => {
  it('renders DevChain, hides disconnected provider tabs, and keeps Add board with the native view', async () => {
    renderBoardRoute({
      integrationAdmission: { allowed: true, reason: null },
    });

    const nav = await screen.findByRole('navigation', { name: 'Board source' });
    expect(nav).toBeInTheDocument();

    const devChainTab = screen.getByRole('link', { name: 'DevChain' });
    expect(devChainTab).toHaveAttribute('aria-current', 'page');
    expect(devChainTab).toHaveAttribute('href', '/board');

    expect(await screen.findByRole('button', { name: /add board/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^ClickUp/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Jira/ })).not.toBeInTheDocument();

    // The unchanged native view renders below the navigation (no project selected
    // renders its own no-project state).
    expect(screen.getByRole('heading', { name: 'Epic Board' })).toBeInTheDocument();
    expect(
      screen.getByText('Select a project from the header to view its Kanban board.'),
    ).toBeInTheDocument();
    expect(screen.getByText('No Project Selected')).toBeInTheDocument();
  });

  it('issues no provider connection query and hides onboarding when admission is denied', async () => {
    const fetchMock = renderBoardRoute({
      integrationAdmission: { allowed: false, reason: 'non_loopback_host' },
    }) as unknown as { unmount: () => void };

    await waitFor(() => {
      expect(screen.getByRole('navigation', { name: 'Board source' })).toBeInTheDocument();
    });

    expect(screen.queryByRole('button', { name: /add board/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^ClickUp/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Jira/ })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Epic Board' })).toBeInTheDocument();

    const calls = (global.fetch as jest.Mock).mock.calls.map(([input]: [RequestInfo | URL]) =>
      typeof input === 'string' ? input : input.toString(),
    );
    expect(calls.some((url) => url.startsWith('/api/integrations/connections'))).toBe(false);

    fetchMock.unmount();
  });
});
