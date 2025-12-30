import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import { AgentsPage } from './AgentsPage';

const toastSpy = jest.fn();
const useSelectedProjectMock = jest.fn();
const openTerminalWindowSpy = jest.fn();

jest.mock('@/ui/hooks/use-toast', () => ({
  useToast: () => ({ toast: toastSpy }),
}));

jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => useSelectedProjectMock(),
}));

jest.mock('@/ui/terminal-windows', () => ({
  useTerminalWindowManager: () => openTerminalWindowSpy,
}));

const baseProfile = {
  id: 'profile-1',
  name: 'Default Profile',
  providerId: 'provider-1',
  promptCount: 0,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

const baseProvider = {
  id: 'provider-1',
  name: 'claude',
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

const agentProfile = {
  ...baseProfile,
  provider: { id: baseProvider.id, name: baseProvider.name },
};

const baseAgent = {
  id: 'agent-1',
  projectId: 'project-1',
  profileId: baseProfile.id,
  name: 'Agent One',
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
  profile: agentProfile,
};

const projectSelectionValue = {
  projects: [],
  projectsLoading: false,
  projectsError: false,
  refetchProjects: jest.fn(),
  selectedProjectId: 'project-1',
  selectedProject: { id: 'project-1', name: 'Project Alpha' },
  setSelectedProjectId: jest.fn(),
};

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  return { Wrapper, queryClient };
}

function buildFetchMock(overrides?: {
  onLaunch?: () => Promise<Response> | Response;
  onUpdate?: () => Promise<Response> | Response;
}) {
  let currentAgent = { ...baseAgent };
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('/api/profiles')) {
      return {
        ok: true,
        json: async () => ({ items: [baseProfile], total: 1 }),
      } as Response;
    }

    if (url === '/api/providers') {
      return {
        ok: true,
        json: async () => ({ items: [baseProvider], total: 1 }),
      } as Response;
    }

    if (url.startsWith('/api/agents') && (!init || init.method === undefined)) {
      return {
        ok: true,
        json: async () => ({ items: [currentAgent], total: 1 }),
      } as Response;
    }

    if (url === '/api/sessions/launch' && init?.method === 'POST') {
      if (overrides?.onLaunch) {
        return overrides.onLaunch();
      }

      return {
        ok: true,
        json: async () => ({
          id: 'session-1',
          epicId: null,
          agentId: 'agent-1',
          tmuxSessionId: 'tmux-1',
          status: 'running',
          startedAt: '2024-01-01T00:00:00.000Z',
          endedAt: null,
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        }),
      } as Response;
    }

    if (url === `/api/agents/${baseAgent.id}` && init?.method === 'PATCH') {
      if (overrides?.onUpdate) {
        return overrides.onUpdate();
      }

      return {
        ok: true,
        json: async () => {
          currentAgent = { ...currentAgent, name: 'Agent One Updated' };
          return currentAgent;
        },
      } as Response;
    }

    return {
      ok: true,
      json: async () => ({}),
    } as Response;
  });
}

describe('AgentsPage', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    toastSpy.mockClear();
    openTerminalWindowSpy.mockClear();
    useSelectedProjectMock.mockReturnValue(projectSelectionValue);
  });

  afterEach(() => {
    if (originalFetch) {
      global.fetch = originalFetch;
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (global as unknown as { fetch?: unknown }).fetch;
    }
  });

  it('launches a session from the Agents page', async () => {
    const fetchMock = buildFetchMock();
    global.fetch = fetchMock as unknown as typeof fetch;
    const dispatchSpy = jest.spyOn(window, 'dispatchEvent');

    const { Wrapper, queryClient } = createWrapper();
    render(<AgentsPage />, { wrapper: Wrapper });

    await screen.findByText('Agent One');

    const launchButton = screen.getByRole('button', { name: /launch session/i });
    fireEvent.click(launchButton);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/sessions/launch',
        expect.objectContaining({
          method: 'POST',
        }),
      );
    });

    expect(openTerminalWindowSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'session-1', agentId: 'agent-1' }),
    );
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'devchain:terminal-dock:open' }),
    );
    expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ title: 'Session launched' }));

    dispatchSpy.mockRestore();
    queryClient.clear();
  });

  it('saves edits and closes the dialog on success', async () => {
    const fetchMock = buildFetchMock();
    global.fetch = fetchMock as unknown as typeof fetch;

    const { Wrapper, queryClient } = createWrapper();
    render(<AgentsPage />, { wrapper: Wrapper });

    await screen.findByText('Agent One');

    fireEvent.click(screen.getByRole('button', { name: /edit/i }));

    const nameInput = await screen.findByLabelText(/name/i);
    fireEvent.change(nameInput, { target: { value: 'Agent One Updated' } });

    const saveButton = screen.getByRole('button', { name: /save changes/i });
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/agents/${baseAgent.id}`,
        expect.objectContaining({ method: 'PATCH' }),
      );
    });

    await waitFor(() => {
      expect(screen.getByText('Agent One Updated')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.queryByText('Edit Agent')).not.toBeInTheDocument();
    });
    expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ title: 'Agent updated' }));

    queryClient.clear();
  });

  it('reverts optimistic edit and surfaces error toast on failure', async () => {
    let resolvePatch: ((value: Response) => void) | undefined;
    const fetchMock = buildFetchMock({
      onUpdate: () =>
        new Promise<Response>((resolve) => {
          resolvePatch = resolve;
        }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const { Wrapper, queryClient } = createWrapper();
    render(<AgentsPage />, { wrapper: Wrapper });

    await screen.findByText('Agent One');
    fireEvent.click(screen.getByRole('button', { name: /edit/i }));

    const nameInput = await screen.findByLabelText(/name/i);
    fireEvent.change(nameInput, { target: { value: 'Agent One Updated' } });

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    });

    await waitFor(() => {
      expect(screen.getByText('Agent One Updated')).toBeInTheDocument();
    });

    expect(resolvePatch).toBeDefined();
    resolvePatch?.({
      ok: false,
      json: async () => ({ message: 'Failed to update agent' }),
    } as Response);

    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ title: 'Update failed' }));
    });

    await waitFor(() => {
      expect(screen.getByText('Agent One')).toBeInTheDocument();
    });
    expect(screen.getByText('Edit Agent')).toBeInTheDocument();

    queryClient.clear();
  });

  it('renders avatar previews in dialogs and updates with debounced input', async () => {
    jest.useFakeTimers();
    const fetchMock = buildFetchMock();
    global.fetch = fetchMock as unknown as typeof fetch;

    const { Wrapper, queryClient } = createWrapper();

    try {
      render(<AgentsPage />, { wrapper: Wrapper });

      await screen.findByText('Agent One');

      fireEvent.click(screen.getByRole('button', { name: /create agent/i }));

      const createLabel = await screen.findByTestId('agent-preview-create-label');
      expect(createLabel).toHaveTextContent('Avatar preview');

      const createNameInput = screen.getByLabelText('Name *');
      fireEvent.change(createNameInput, { target: { value: 'Ada Lovelace' } });

      await act(async () => {
        jest.advanceTimersByTime(300);
      });

      await waitFor(() => {
        expect(screen.getByTestId('agent-preview-create-label')).toHaveTextContent('Ada Lovelace');
      });

      fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

      fireEvent.click(screen.getByRole('button', { name: /edit/i }));
      await screen.findByTestId('agent-preview-edit-label');
      await act(async () => {
        jest.advanceTimersByTime(300);
      });
      await waitFor(() => {
        expect(screen.getByTestId('agent-preview-edit-label')).toHaveTextContent('Agent One');
      });

      const editNameInput = screen.getByLabelText('Name *');
      fireEvent.change(editNameInput, { target: { value: '' } });

      await act(async () => {
        jest.advanceTimersByTime(300);
      });

      await waitFor(() => {
        expect(screen.getByTestId('agent-preview-edit-label')).toHaveTextContent('Avatar preview');
      });
    } finally {
      jest.useRealTimers();
      queryClient.clear();
    }
  });

  it('exposes accessible avatar labels on the agents list', async () => {
    const fetchMock = buildFetchMock();
    global.fetch = fetchMock as unknown as typeof fetch;

    const { Wrapper, queryClient } = createWrapper();

    render(<AgentsPage />, { wrapper: Wrapper });

    await screen.findByText('Agent One');

    const avatars = screen.getAllByRole('img', { name: 'Avatar for agent Agent One' });
    expect(avatars.length).toBeGreaterThanOrEqual(1);
    avatars.forEach((avatar) => {
      expect(avatar).toHaveAttribute('aria-label', 'Avatar for agent Agent One');
    });

    queryClient.clear();
  });
});
