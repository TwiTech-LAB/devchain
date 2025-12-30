import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EventsPage } from './EventsPage';

const ioMock = jest.fn();

jest.mock('socket.io-client', () => ({
  io: (...args: unknown[]) => ioMock(...args),
}));

jest.mock('@/ui/components/ui/select', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const React = require('react');
  let currentTriggerId: string | undefined;

  interface SelectTriggerProps {
    id?: string;
    children: React.ReactNode;
  }

  interface SelectContentProps {
    children: React.ReactNode;
  }

  interface SelectItemProps {
    value: string;
    children: React.ReactNode;
  }

  interface SelectProps {
    value: string;
    onValueChange?: (value: string) => void;
    children: React.ReactNode;
  }

  interface SelectValueProps {
    placeholder?: string;
  }

  const SelectTrigger = ({ id, children }: SelectTriggerProps) => {
    currentTriggerId = id;
    return <>{children}</>;
  };

  const SelectContent = ({ children }: SelectContentProps) => <>{children}</>;

  const SelectItem = ({ value, children }: SelectItemProps) => (
    <option value={value}>{children}</option>
  );
  (SelectItem as { __SELECT_ITEM?: boolean }).__SELECT_ITEM = true;

  const collectOptions = (nodes: React.ReactNode): React.ReactNode[] => {
    const options: React.ReactNode[] = [];
    React.Children.forEach(nodes, (child: React.ReactElement) => {
      if (!child) return;
      if (child.type === SelectTrigger && child.props?.id) {
        currentTriggerId = child.props.id;
      }
      if (child.type === SelectContent) {
        options.push(...collectOptions(child.props.children));
      } else if (child.type && (child.type as { __SELECT_ITEM?: boolean }).__SELECT_ITEM) {
        options.push(
          <option key={child.props.value} value={child.props.value}>
            {child.props.children}
          </option>,
        );
      }
    });
    return options;
  };

  const Select = ({ value, onValueChange, children }: SelectProps) => {
    const options = collectOptions(children);
    const element = (
      <select
        id={currentTriggerId}
        value={value}
        onChange={(event) => onValueChange?.(event.target.value)}
      >
        {options}
      </select>
    );
    currentTriggerId = undefined;
    return element;
  };

  const SelectValue = ({ placeholder }: SelectValueProps) => <>{placeholder}</>;

  return { Select, SelectTrigger, SelectContent, SelectItem, SelectValue };
});

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

describe('EventsPage', () => {
  const originalFetch = global.fetch;
  const fetchMock = jest.fn();

  beforeEach(() => {
    const socketHandlers: Record<string, ((payload: unknown) => void)[]> = {};
    ioMock.mockReturnValue({
      on: jest.fn((event: string, handler: (payload: unknown) => void) => {
        socketHandlers[event] = socketHandlers[event] || [];
        socketHandlers[event].push(handler);
      }),
      emit: jest.fn(),
      off: jest.fn(),
      disconnect: jest.fn(),
    });

    fetchMock.mockImplementation(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.startsWith('/api/events')) {
        const params = new URL(url, 'http://localhost');
        const nameFilter = params.searchParams.get('name');
        const status = params.searchParams.get('status');

        const items = [
          {
            id: 'event-1',
            name: 'epic.assigned',
            payload: { epicId: 'epic-1', agentId: 'agent-1' },
            requestId: 'req-1',
            publishedAt: new Date('2024-01-01T00:00:00Z').toISOString(),
            handlers: [
              {
                id: 'handler-1',
                eventId: 'event-1',
                handler: 'EpicAssignmentNotifier',
                status: 'success',
                detail: { sessionId: 'session-1' },
                startedAt: new Date('2024-01-01T00:00:01Z').toISOString(),
                endedAt: new Date('2024-01-01T00:00:02Z').toISOString(),
              },
            ],
          },
        ].filter((event) => {
          const nameMatch = !nameFilter || event.name.includes(nameFilter);
          const statusMatch = !status || event.handlers.some((h) => h.status === status);
          return nameMatch && statusMatch;
        });

        return {
          ok: true,
          json: async () => ({ items, total: items.length, limit: 50, offset: 0 }),
        } as Response;
      }

      if (url.startsWith('/api/preflight')) {
        return {
          ok: true,
          json: async () => ({ overall: 'pass', checks: [], timestamp: new Date().toISOString() }),
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

  it('renders events, supports filtering, and shows detail payload', async () => {
    const { Wrapper } = createWrapper();

    await act(async () => {
      render(
        <Wrapper>
          <EventsPage />
        </Wrapper>,
      );
    });

    expect(await screen.findByText('epic.assigned')).toBeInTheDocument();
    expect(await screen.findByText('EpicAssignmentNotifier')).toBeInTheDocument();

    const payloadViewer = await screen.findByText(/"epicId": "epic-1"/i);
    expect(payloadViewer).toBeInTheDocument();

    // Filter by name
    const nameInput = screen.getByLabelText(/Event name/i);
    fireEvent.change(nameInput, { target: { value: 'epic' } });

    await waitFor(() => {
      const matchingCall = fetchMock.mock.calls.find(([url]) =>
        url.toString().includes('name=epic'),
      );
      expect(matchingCall).toBeDefined();
    });

    // Select row and ensure handler detail appears
    const row = await screen.findByText('epic.assigned');
    fireEvent.click(row);
    expect(await screen.findByText('EpicAssignmentNotifier')).toBeInTheDocument();
    expect(screen.getByText(/session-1/)).toBeInTheDocument();
  });
});
