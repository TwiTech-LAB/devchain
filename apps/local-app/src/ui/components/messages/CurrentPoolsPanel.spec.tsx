import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CurrentPoolsPanel, type PoolDetails } from './CurrentPoolsPanel';

const ioMock = jest.fn();

jest.mock('socket.io-client', () => ({
  io: (...args: unknown[]) => ioMock(...args),
}));

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

const mockPools: PoolDetails[] = [
  {
    agentId: 'agent-1',
    agentName: 'Test Agent',
    projectId: 'project-1',
    messageCount: 3,
    waitingMs: 5000,
    messages: [{ id: 'msg-1', preview: 'Hello', source: 'test', timestamp: Date.now() }],
  },
  {
    agentId: 'agent-2',
    agentName: 'Another Agent',
    projectId: 'project-1',
    messageCount: 1,
    waitingMs: 2000,
    messages: [{ id: 'msg-2', preview: 'World', source: 'test', timestamp: Date.now() }],
  },
];

describe('CurrentPoolsPanel', () => {
  const originalFetch = global.fetch;
  const fetchMock = jest.fn();
  let socketHandlers: Record<string, ((payload: unknown) => void)[]>;

  beforeEach(() => {
    socketHandlers = {};
    ioMock.mockReturnValue({
      on: jest.fn((event: string, handler: (payload: unknown) => void) => {
        socketHandlers[event] = socketHandlers[event] || [];
        socketHandlers[event].push(handler);
      }),
      emit: jest.fn(),
      off: jest.fn(),
      disconnect: jest.fn(),
    });

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.startsWith('/api/sessions/pools')) {
        return {
          ok: true,
          json: async () => ({ pools: mockPools }),
        } as Response;
      }

      return {
        ok: true,
        json: async () => ({}),
      } as Response;
    });

    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    fetchMock.mockReset();
    ioMock.mockReset();
  });

  it('renders loading state initially', async () => {
    const { Wrapper } = createWrapper();

    render(
      <Wrapper>
        <CurrentPoolsPanel projectId="project-1" />
      </Wrapper>,
    );

    expect(screen.getByText('Loading pools...')).toBeInTheDocument();
  });

  it('renders pool cards after loading', async () => {
    const { Wrapper } = createWrapper();

    await act(async () => {
      render(
        <Wrapper>
          <CurrentPoolsPanel projectId="project-1" />
        </Wrapper>,
      );
    });

    expect(await screen.findByText('Test Agent')).toBeInTheDocument();
    expect(await screen.findByText('Another Agent')).toBeInTheDocument();
    expect(screen.getByText('3 msgs')).toBeInTheDocument();
    expect(screen.getByText('1 msg')).toBeInTheDocument();
    expect(screen.getByText('~5s wait')).toBeInTheDocument();
    expect(screen.getByText('~2s wait')).toBeInTheDocument();
  });

  it('shows empty state when no pools', async () => {
    fetchMock.mockImplementation(async () => ({
      ok: true,
      json: async () => ({ pools: [] }),
    }));

    const { Wrapper } = createWrapper();

    await act(async () => {
      render(
        <Wrapper>
          <CurrentPoolsPanel projectId="project-1" />
        </Wrapper>,
      );
    });

    expect(await screen.findByText('No pending messages')).toBeInTheDocument();
  });

  it('shows error state on fetch failure', async () => {
    fetchMock.mockImplementation(async () => ({
      ok: false,
      status: 500,
    }));

    const { Wrapper } = createWrapper();

    await act(async () => {
      render(
        <Wrapper>
          <CurrentPoolsPanel projectId="project-1" />
        </Wrapper>,
      );
    });

    expect(await screen.findByText(/Failed to load pools/)).toBeInTheDocument();
  });

  it('calls onAgentClick when pool card is clicked', async () => {
    const onAgentClick = jest.fn();
    const { Wrapper } = createWrapper();

    await act(async () => {
      render(
        <Wrapper>
          <CurrentPoolsPanel projectId="project-1" onAgentClick={onAgentClick} />
        </Wrapper>,
      );
    });

    const card = await screen.findByText('Test Agent');
    fireEvent.click(card.closest('button')!);

    expect(onAgentClick).toHaveBeenCalledWith('agent-1');
  });

  it('shows selected state for pool card', async () => {
    const { Wrapper } = createWrapper();

    await act(async () => {
      render(
        <Wrapper>
          <CurrentPoolsPanel projectId="project-1" selectedAgentId="agent-1" />
        </Wrapper>,
      );
    });

    const card = await screen.findByText('Test Agent');
    const button = card.closest('button')!;
    expect(button).toHaveAttribute('aria-pressed', 'true');
  });

  it('passes projectId to API call', async () => {
    const { Wrapper } = createWrapper();

    await act(async () => {
      render(
        <Wrapper>
          <CurrentPoolsPanel projectId="my-project-123" />
        </Wrapper>,
      );
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('projectId=my-project-123'));
    });
  });

  it('invalidates query on WebSocket pools update', async () => {
    const { Wrapper, queryClient } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    await act(async () => {
      render(
        <Wrapper>
          <CurrentPoolsPanel projectId="project-1" />
        </Wrapper>,
      );
    });

    await screen.findByText('Test Agent');

    // Simulate WebSocket message
    const messageHandlers = socketHandlers['message'] || [];
    act(() => {
      messageHandlers.forEach((handler) => {
        handler({
          topic: 'messages/pools',
          type: 'updated',
          payload: [],
          ts: new Date().toISOString(),
        });
      });
    });

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ['pools', 'project-1'],
      });
    });
  });

  it('has accessible pool card labels', async () => {
    const { Wrapper } = createWrapper();

    await act(async () => {
      render(
        <Wrapper>
          <CurrentPoolsPanel projectId="project-1" />
        </Wrapper>,
      );
    });

    const card = await screen.findByRole('button', {
      name: /Test Agent: 3 messages, waiting 5 seconds/,
    });
    expect(card).toBeInTheDocument();
  });
});
