import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MessageFiltersPanel } from './MessageFiltersPanel';

// Mock Select component for testing
jest.mock('@/ui/components/ui/select', () => {
  let currentTriggerId: string | undefined;

  interface SelectTriggerProps {
    'aria-label'?: string;
    children: React.ReactNode;
    className?: string;
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

  const SelectTrigger = ({ 'aria-label': ariaLabel, children }: SelectTriggerProps) => {
    currentTriggerId = ariaLabel;
    return <>{children}</>;
  };

  const SelectContent = ({ children }: SelectContentProps) => <>{children}</>;

  const SelectItem = ({ value, children }: SelectItemProps) => (
    <option value={value}>{children}</option>
  );
  (SelectItem as { __SELECT_ITEM?: boolean }).__SELECT_ITEM = true;

  const collectOptions = (nodes: React.ReactNode): React.ReactNode[] => {
    const options: React.ReactNode[] = [];
    for (const child of React.Children.toArray(nodes)) {
      if (!React.isValidElement(child)) continue;

      if (child.type === SelectTrigger && child.props?.['aria-label']) {
        currentTriggerId = child.props['aria-label'];
      }
      if (child.type === SelectContent) {
        options.push(...collectOptions(child.props.children));
      } else if (
        child.type &&
        (child.type as { __SELECT_ITEM?: boolean }).__SELECT_ITEM &&
        child.props?.value
      ) {
        options.push(
          <option key={child.props.value} value={child.props.value}>
            {child.props.children}
          </option>,
        );
      }
    }
    return options;
  };

  const Select = ({ value, onValueChange, children }: SelectProps) => {
    const options = collectOptions(children);
    const element = (
      <select
        aria-label={currentTriggerId}
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

const mockAgents = [
  { id: 'agent-1', name: 'Test Agent', projectId: 'project-1' },
  { id: 'agent-2', name: 'Another Agent', projectId: 'project-1' },
];

describe('MessageFiltersPanel', () => {
  const originalFetch = global.fetch;
  const fetchMock = jest.fn();

  beforeEach(() => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.startsWith('/api/agents')) {
        return {
          ok: true,
          json: async () => ({ items: mockAgents }),
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
  });

  it('renders all filter controls', async () => {
    const { Wrapper } = createWrapper();

    await act(async () => {
      render(
        <Wrapper>
          <MessageFiltersPanel projectId="project-1" filters={{}} onChange={jest.fn()} />
        </Wrapper>,
      );
    });

    expect(screen.getByLabelText('Filter by status')).toBeInTheDocument();
    expect(screen.getByLabelText('Filter by agent')).toBeInTheDocument();
    expect(screen.getByLabelText('Filter by source')).toBeInTheDocument();
  });

  it('calls onChange when status filter changes', async () => {
    const onChange = jest.fn();
    const { Wrapper } = createWrapper();

    await act(async () => {
      render(
        <Wrapper>
          <MessageFiltersPanel projectId="project-1" filters={{}} onChange={onChange} />
        </Wrapper>,
      );
    });

    const statusSelect = screen.getByLabelText('Filter by status');
    fireEvent.change(statusSelect, { target: { value: 'delivered' } });

    expect(onChange).toHaveBeenCalledWith({ status: 'delivered' });
  });

  it('calls onChange when agent filter changes', async () => {
    const onChange = jest.fn();
    const { Wrapper } = createWrapper();

    await act(async () => {
      render(
        <Wrapper>
          <MessageFiltersPanel projectId="project-1" filters={{}} onChange={onChange} />
        </Wrapper>,
      );
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/agents'));
    });

    const agentSelect = screen.getByLabelText('Filter by agent');
    fireEvent.change(agentSelect, { target: { value: 'agent-1' } });

    expect(onChange).toHaveBeenCalledWith({ agentId: 'agent-1' });
  });

  it('calls onChange when source filter changes', async () => {
    const onChange = jest.fn();
    const { Wrapper } = createWrapper();

    await act(async () => {
      render(
        <Wrapper>
          <MessageFiltersPanel projectId="project-1" filters={{}} onChange={onChange} />
        </Wrapper>,
      );
    });

    const sourceSelect = screen.getByLabelText('Filter by source');
    fireEvent.change(sourceSelect, { target: { value: 'epic.assigned' } });

    expect(onChange).toHaveBeenCalledWith({ source: 'epic.assigned' });
  });

  it('clears status filter when "all" is selected', async () => {
    const onChange = jest.fn();
    const { Wrapper } = createWrapper();

    await act(async () => {
      render(
        <Wrapper>
          <MessageFiltersPanel
            projectId="project-1"
            filters={{ status: 'delivered' }}
            onChange={onChange}
          />
        </Wrapper>,
      );
    });

    const statusSelect = screen.getByLabelText('Filter by status');
    fireEvent.change(statusSelect, { target: { value: 'all' } });

    expect(onChange).toHaveBeenCalledWith({ status: undefined });
  });

  it('shows clear button when filters are active', async () => {
    const { Wrapper } = createWrapper();

    await act(async () => {
      render(
        <Wrapper>
          <MessageFiltersPanel
            projectId="project-1"
            filters={{ status: 'queued' }}
            onChange={jest.fn()}
          />
        </Wrapper>,
      );
    });

    expect(screen.getByRole('button', { name: /clear/i })).toBeInTheDocument();
  });

  it('hides clear button when no filters are active', async () => {
    const { Wrapper } = createWrapper();

    await act(async () => {
      render(
        <Wrapper>
          <MessageFiltersPanel projectId="project-1" filters={{}} onChange={jest.fn()} />
        </Wrapper>,
      );
    });

    expect(screen.queryByRole('button', { name: /clear/i })).not.toBeInTheDocument();
  });

  it('clears all filters when clear button is clicked', async () => {
    const onChange = jest.fn();
    const { Wrapper } = createWrapper();

    await act(async () => {
      render(
        <Wrapper>
          <MessageFiltersPanel
            projectId="project-1"
            filters={{ status: 'queued', agentId: 'agent-1', source: 'epic.assigned' }}
            onChange={onChange}
          />
        </Wrapper>,
      );
    });

    const clearButton = screen.getByRole('button', { name: /clear/i });
    fireEvent.click(clearButton);

    expect(onChange).toHaveBeenCalledWith({});
  });

  it('preserves other filters when changing one filter', async () => {
    const onChange = jest.fn();
    const { Wrapper } = createWrapper();

    await act(async () => {
      render(
        <Wrapper>
          <MessageFiltersPanel
            projectId="project-1"
            filters={{ status: 'delivered', agentId: 'agent-1' }}
            onChange={onChange}
          />
        </Wrapper>,
      );
    });

    const sourceSelect = screen.getByLabelText('Filter by source');
    fireEvent.change(sourceSelect, { target: { value: 'chat.message' } });

    expect(onChange).toHaveBeenCalledWith({
      status: 'delivered',
      agentId: 'agent-1',
      source: 'chat.message',
    });
  });

  it('fetches agents for the project', async () => {
    const { Wrapper } = createWrapper();

    await act(async () => {
      render(
        <Wrapper>
          <MessageFiltersPanel projectId="my-project" filters={{}} onChange={jest.fn()} />
        </Wrapper>,
      );
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/agents?projectId=my-project'),
      );
    });
  });

  it('renders all known source options', async () => {
    const { Wrapper } = createWrapper();

    await act(async () => {
      render(
        <Wrapper>
          <MessageFiltersPanel projectId="project-1" filters={{}} onChange={jest.fn()} />
        </Wrapper>,
      );
    });

    const sourceSelect = screen.getByLabelText('Filter by source');

    // Verify all source options are present
    expect(sourceSelect).toContainHTML('epic.assigned');
    expect(sourceSelect).toContainHTML('chat.message');
    expect(sourceSelect).toContainHTML('mcp.send_message');
    expect(sourceSelect).toContainHTML('subscriber.action');
    expect(sourceSelect).toContainHTML('pool.failure_notice');
  });

  it('calls onChange with subscriber.action source', async () => {
    const onChange = jest.fn();
    const { Wrapper } = createWrapper();

    await act(async () => {
      render(
        <Wrapper>
          <MessageFiltersPanel projectId="project-1" filters={{}} onChange={onChange} />
        </Wrapper>,
      );
    });

    const sourceSelect = screen.getByLabelText('Filter by source');
    fireEvent.change(sourceSelect, { target: { value: 'subscriber.action' } });

    expect(onChange).toHaveBeenCalledWith({ source: 'subscriber.action' });
  });

  it('calls onChange with pool.failure_notice source', async () => {
    const onChange = jest.fn();
    const { Wrapper } = createWrapper();

    await act(async () => {
      render(
        <Wrapper>
          <MessageFiltersPanel projectId="project-1" filters={{}} onChange={onChange} />
        </Wrapper>,
      );
    });

    const sourceSelect = screen.getByLabelText('Filter by source');
    fireEvent.change(sourceSelect, { target: { value: 'pool.failure_notice' } });

    expect(onChange).toHaveBeenCalledWith({ source: 'pool.failure_notice' });
  });
});
