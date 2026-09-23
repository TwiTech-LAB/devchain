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
    humanHeldMessageCount: 0,
    waitingMs: 5000,
    messages: [{ id: 'msg-1', preview: 'Hello', source: 'test', timestamp: Date.now() }],
  },
  {
    agentId: 'agent-2',
    agentName: 'Another Agent',
    projectId: 'project-1',
    messageCount: 1,
    humanHeldMessageCount: 0,
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
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('projectId=my-project-123'),
        undefined,
      );
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

  describe('Send now', () => {
    const forcePool: PoolDetails = {
      agentId: 'agent-force',
      agentName: 'Force Agent',
      projectId: 'project-1',
      messageCount: 1,
      humanHeldMessageCount: 1,
      holdReason: 'awaiting_quiet',
      forceEligibleAt: Date.now() - 1000,
      activeSessionId: 'session-1',
      deferredMessageIds: ['msg-force-1'],
      waitingMs: 35000,
      messages: [{ id: 'msg-force-1', preview: 'Deferred', source: 'test', timestamp: Date.now() }],
    };

    const onIdlePool: PoolDetails = {
      ...forcePool,
      agentId: 'agent-idle',
      agentName: 'Idle Agent',
      humanHeldMessageCount: 0,
      holdReason: 'awaiting_idle',
      activeSessionId: 'session-2',
      deferredMessageIds: ['msg-idle-1'],
    };

    const draftPool: PoolDetails = {
      ...forcePool,
      agentId: 'agent-draft',
      agentName: 'Draft Agent',
      holdReason: 'human_draft',
      forceEligibleAt: undefined,
      activeSessionId: undefined,
      deferredMessageIds: undefined,
    };

    const beforeThresholdPool: PoolDetails = {
      ...forcePool,
      agentId: 'agent-before',
      agentName: 'Before Agent',
      forceEligibleAt: Date.now() + 60000,
    };

    function setupWithPools(pools: PoolDetails[]) {
      fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/sessions/pools')) {
          return { ok: true, json: async () => ({ pools }) };
        }
        if (url.includes('force-deferred')) {
          return {
            ok: true,
            json: async () => ({ status: 'delivered', deliveredCount: 1 }),
          };
        }
        return { ok: true, json: async () => ({}) };
      });
    }

    it('shows Send now for eligible awaiting_quiet lane', async () => {
      setupWithPools([forcePool]);
      const { Wrapper } = createWrapper();
      await act(async () => {
        render(
          <Wrapper>
            <CurrentPoolsPanel projectId="project-1" />
          </Wrapper>,
        );
      });
      expect(
        await screen.findByRole('button', { name: 'Send now for Force Agent' }),
      ).toBeInTheDocument();
    });

    it('shows Send now for on_idle lane with humanHeldMessageCount=0', async () => {
      setupWithPools([onIdlePool]);
      const { Wrapper } = createWrapper();
      await act(async () => {
        render(
          <Wrapper>
            <CurrentPoolsPanel projectId="project-1" />
          </Wrapper>,
        );
      });
      expect(
        await screen.findByRole('button', { name: 'Send now for Idle Agent' }),
      ).toBeInTheDocument();
    });

    it('never shows Send now for human_draft', async () => {
      setupWithPools([draftPool]);
      const { Wrapper } = createWrapper();
      await act(async () => {
        render(
          <Wrapper>
            <CurrentPoolsPanel projectId="project-1" />
          </Wrapper>,
        );
      });
      await screen.findByText('Draft Agent');
      expect(screen.queryByRole('button', { name: /Send now/i })).not.toBeInTheDocument();
      expect(screen.getByText('Waiting for you to finish typing')).toBeInTheDocument();
    });

    it('shows hold label without Send now before forceEligibleAt', async () => {
      setupWithPools([beforeThresholdPool]);
      const { Wrapper } = createWrapper();
      await act(async () => {
        render(
          <Wrapper>
            <CurrentPoolsPanel projectId="project-1" />
          </Wrapper>,
        );
      });
      await screen.findByText('Before Agent');
      expect(screen.queryByRole('button', { name: /Send now/i })).not.toBeInTheDocument();
      expect(screen.getByText('Waiting for terminal quiet')).toBeInTheDocument();
    });

    it('opens a confirmation dialog on Send now click; Cancel sends nothing', async () => {
      setupWithPools([forcePool]);
      const { Wrapper } = createWrapper();
      await act(async () => {
        render(
          <Wrapper>
            <CurrentPoolsPanel projectId="project-1" />
          </Wrapper>,
        );
      });
      fireEvent.click(await screen.findByRole('button', { name: 'Send now for Force Agent' }));
      expect(screen.getByRole('heading', { name: 'Send now' })).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('heading', { name: 'Send now' })).not.toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalledWith(
        expect.stringContaining('force-deferred'),
        expect.anything(),
      );
    });

    it('Confirm posts exact {projectId, sessionId, messageIds}', async () => {
      setupWithPools([forcePool]);
      const { Wrapper } = createWrapper();
      await act(async () => {
        render(
          <Wrapper>
            <CurrentPoolsPanel projectId="project-1" />
          </Wrapper>,
        );
      });
      fireEvent.click(await screen.findByRole('button', { name: 'Send now for Force Agent' }));
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Send now' }));
      });

      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
          expect.stringContaining('force-deferred'),
          expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({
              projectId: 'project-1',
              sessionId: 'session-1',
              messageIds: ['msg-force-1'],
            }),
          }),
        ),
      );
    });

    it('Confirm sends exactly one POST (pending blocks duplicates)', async () => {
      setupWithPools([forcePool]);
      const { Wrapper } = createWrapper();
      await act(async () => {
        render(
          <Wrapper>
            <CurrentPoolsPanel projectId="project-1" />
          </Wrapper>,
        );
      });
      fireEvent.click(await screen.findByRole('button', { name: 'Send now for Force Agent' }));
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Send now' }));
      });

      const forceCalls = fetchMock.mock.calls.filter((c: unknown[]) =>
        String(c[0]).includes('force-deferred'),
      );
      expect(forceCalls).toHaveLength(1);
    });

    it('shows queue changed message on 409', async () => {
      fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('force-deferred')) {
          return { ok: false, status: 409, json: async () => ({ message: 'Batch changed' }) };
        }
        if (url.includes('/api/sessions/pools')) {
          return { ok: true, json: async () => ({ pools: [forcePool] }) };
        }
        return { ok: true, json: async () => ({}) };
      });
      const { Wrapper } = createWrapper();
      await act(async () => {
        render(
          <Wrapper>
            <CurrentPoolsPanel projectId="project-1" />
          </Wrapper>,
        );
      });
      fireEvent.click(await screen.findByRole('button', { name: 'Send now for Force Agent' }));
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Send now' }));
      });
      expect(
        await screen.findByText('Queue changed — review and confirm again.'),
      ).toBeInTheDocument();
    });

    it('PoolCard click still calls onAgentClick while Send now is a sibling', async () => {
      const onAgentClick = jest.fn();
      setupWithPools([forcePool]);
      const { Wrapper } = createWrapper();
      await act(async () => {
        render(
          <Wrapper>
            <CurrentPoolsPanel projectId="project-1" onAgentClick={onAgentClick} />
          </Wrapper>,
        );
      });
      const card = await screen.findByText('Force Agent');
      fireEvent.click(card.closest('button')!);
      expect(onAgentClick).toHaveBeenCalledWith('agent-force');

      const sendBtn = screen.getByRole('button', { name: 'Send now for Force Agent' });
      expect(sendBtn.closest('button[aria-pressed]')).toBeNull();
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
