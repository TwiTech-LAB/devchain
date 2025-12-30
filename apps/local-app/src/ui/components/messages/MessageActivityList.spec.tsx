import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MessageActivityList, type MessageLogPreview } from './MessageActivityList';

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

// T2-FIX: Use MessageLogPreview with 'preview' field (not MessageLogEntry with 'text')
// The component renders message.preview, so test data must have that field
const mockMessages: MessageLogPreview[] = [
  {
    id: 'msg-1',
    timestamp: Date.now() - 5000,
    projectId: 'project-1',
    agentId: 'agent-1',
    agentName: 'Test Agent',
    preview: 'First message content',
    source: 'epic.assigned',
    status: 'delivered',
    batchId: 'batch-1',
    deliveredAt: Date.now() - 4000,
    immediate: false,
  },
  {
    id: 'msg-2',
    timestamp: Date.now() - 5000,
    projectId: 'project-1',
    agentId: 'agent-1',
    agentName: 'Test Agent',
    preview: 'Second message in batch',
    source: 'chat.message',
    status: 'delivered',
    batchId: 'batch-1',
    deliveredAt: Date.now() - 4000,
    immediate: false,
  },
  {
    id: 'msg-3',
    timestamp: Date.now() - 1000,
    projectId: 'project-1',
    agentId: 'agent-2',
    agentName: 'Another Agent',
    preview: 'Single queued message',
    source: 'test.source',
    status: 'queued',
    immediate: false,
  },
  {
    id: 'msg-4',
    timestamp: Date.now() - 2000,
    projectId: 'project-1',
    agentId: 'agent-1',
    agentName: 'Test Agent',
    preview: 'Failed message',
    source: 'notification',
    status: 'failed',
    error: 'No active session',
    immediate: false,
  },
];

describe('MessageActivityList', () => {
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

      if (url.startsWith('/api/sessions/messages')) {
        return {
          ok: true,
          json: async () => ({ messages: mockMessages, total: mockMessages.length }),
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
        <MessageActivityList projectId="project-1" />
      </Wrapper>,
    );

    expect(screen.getByText('Loading messages...')).toBeInTheDocument();
  });

  it('renders messages after loading', async () => {
    const { Wrapper } = createWrapper();

    await act(async () => {
      render(
        <Wrapper>
          <MessageActivityList projectId="project-1" />
        </Wrapper>,
      );
    });

    expect(await screen.findByText(/First message content/)).toBeInTheDocument();
    expect(await screen.findByText(/Second message in batch/)).toBeInTheDocument();
    expect(await screen.findByText(/Single queued message/)).toBeInTheDocument();
  });

  it('shows empty state when no messages', async () => {
    fetchMock.mockImplementation(async () => ({
      ok: true,
      json: async () => ({ messages: [], total: 0 }),
    }));

    const { Wrapper } = createWrapper();

    await act(async () => {
      render(
        <Wrapper>
          <MessageActivityList projectId="project-1" />
        </Wrapper>,
      );
    });

    expect(await screen.findByText('No messages found')).toBeInTheDocument();
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
          <MessageActivityList projectId="project-1" />
        </Wrapper>,
      );
    });

    expect(await screen.findByText(/Failed to load messages/)).toBeInTheDocument();
  });

  it('groups messages by batchId', async () => {
    const { Wrapper } = createWrapper();

    await act(async () => {
      render(
        <Wrapper>
          <MessageActivityList projectId="project-1" />
        </Wrapper>,
      );
    });

    // Should show "batch of 2" for the batched messages
    expect(await screen.findByText('batch of 2')).toBeInTheDocument();
  });

  it('displays status badges', async () => {
    const { Wrapper } = createWrapper();

    await act(async () => {
      render(
        <Wrapper>
          <MessageActivityList projectId="project-1" />
        </Wrapper>,
      );
    });

    expect(await screen.findByText('delivered')).toBeInTheDocument();
    expect(await screen.findByText('queued')).toBeInTheDocument();
    expect(await screen.findByText('failed')).toBeInTheDocument();
  });

  it('shows error message for failed messages', async () => {
    const { Wrapper } = createWrapper();

    await act(async () => {
      render(
        <Wrapper>
          <MessageActivityList projectId="project-1" />
        </Wrapper>,
      );
    });

    expect(await screen.findByText(/Error: No active session/)).toBeInTheDocument();
  });

  it('shows message source in brackets', async () => {
    const { Wrapper } = createWrapper();

    await act(async () => {
      render(
        <Wrapper>
          <MessageActivityList projectId="project-1" />
        </Wrapper>,
      );
    });

    expect(await screen.findByText('[epic.assigned]')).toBeInTheDocument();
    expect(await screen.findByText('[chat.message]')).toBeInTheDocument();
  });

  it('shows agent name with arrow indicator', async () => {
    const { Wrapper } = createWrapper();

    await act(async () => {
      render(
        <Wrapper>
          <MessageActivityList projectId="project-1" />
        </Wrapper>,
      );
    });

    // T2-FIX: Use findAllByText since "Test Agent" appears in multiple batch groups
    const testAgentLabels = await screen.findAllByText('→ Test Agent');
    expect(testAgentLabels.length).toBeGreaterThan(0);
    expect(await screen.findByText('→ Another Agent')).toBeInTheDocument();
  });

  it('calls onMessageClick when message row is clicked', async () => {
    const onMessageClick = jest.fn();
    const { Wrapper } = createWrapper();

    await act(async () => {
      render(
        <Wrapper>
          <MessageActivityList projectId="project-1" onMessageClick={onMessageClick} />
        </Wrapper>,
      );
    });

    const firstMessage = await screen.findByText(/First message content/);
    fireEvent.click(firstMessage.closest('button')!);

    expect(onMessageClick).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'msg-1', preview: 'First message content' }),
    );
  });

  it('passes filters to API call', async () => {
    const { Wrapper } = createWrapper();

    await act(async () => {
      render(
        <Wrapper>
          <MessageActivityList
            projectId="project-1"
            filters={{ agentId: 'agent-1', status: 'delivered' }}
          />
        </Wrapper>,
      );
    });

    // T2-FIX: URL params order is projectId, status, agentId (per URLSearchParams construction)
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringMatching(/projectId=project-1.*status=delivered.*agentId=agent-1/),
      );
    });
  });

  it('shows filter description in card description', async () => {
    const { Wrapper } = createWrapper();

    await act(async () => {
      render(
        <Wrapper>
          <MessageActivityList projectId="project-1" filters={{ agentId: 'agent-1' }} />
        </Wrapper>,
      );
    });

    expect(await screen.findByText(/filtered by agent/)).toBeInTheDocument();
  });

  it('invalidates query on WebSocket activity update', async () => {
    const { Wrapper, queryClient } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    await act(async () => {
      render(
        <Wrapper>
          <MessageActivityList projectId="project-1" />
        </Wrapper>,
      );
    });

    await screen.findByText(/First message content/);

    // Simulate WebSocket message
    const messageHandlers = socketHandlers['message'] || [];
    act(() => {
      messageHandlers.forEach((handler) => {
        handler({
          topic: 'messages/activity',
          type: 'enqueued',
          payload: {},
          ts: new Date().toISOString(),
        });
      });
    });

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ['messages', 'project-1'],
      });
    });
  });

  it('shows total message count', async () => {
    const { Wrapper } = createWrapper();

    await act(async () => {
      render(
        <Wrapper>
          <MessageActivityList projectId="project-1" />
        </Wrapper>,
      );
    });

    expect(await screen.findByText(/4 total/)).toBeInTheDocument();
  });

  it('truncates long message text', async () => {
    // T2-FIX: Use MessageLogPreview with 'preview' field (not MessageLogEntry with 'text')
    const longMessage: MessageLogPreview = {
      id: 'msg-long',
      timestamp: Date.now(),
      projectId: 'project-1',
      agentId: 'agent-1',
      agentName: 'Test Agent',
      preview: 'A'.repeat(100),
      source: 'test',
      status: 'queued',
      immediate: false,
    };

    fetchMock.mockImplementation(async () => ({
      ok: true,
      json: async () => ({ messages: [longMessage], total: 1 }),
    }));

    const { Wrapper } = createWrapper();

    await act(async () => {
      render(
        <Wrapper>
          <MessageActivityList projectId="project-1" />
        </Wrapper>,
      );
    });

    // Should show truncated text (80 chars + "...")
    const truncatedText = await screen.findByText(/A{80}\.\.\./);
    expect(truncatedText).toBeInTheDocument();
  });
});
