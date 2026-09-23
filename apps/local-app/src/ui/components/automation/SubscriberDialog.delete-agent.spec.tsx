// Test layer: UI component/jsdom. Rendering SubscriberDialog with network-boundary mocks is the
// cheapest reliable layer for proving Delete Agent input rendering, retry disabling, hydration
// clearing, and serialized payloads without exercising backend I/O.
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SubscriberDialog } from './SubscriberDialog';
import type { ActionMetadata } from '@/ui/lib/actions';
import type { Subscriber } from '@/ui/lib/subscribers';

const toastSpy = jest.fn();

jest.mock('@/ui/hooks/use-toast', () => ({
  useToast: () => ({ toast: toastSpy }),
}));

jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => ({
    selectedProjectId: 'proj-1',
  }),
}));

const deleteAgentAction: ActionMetadata = {
  type: 'delete_agent',
  name: 'Delete Agent',
  description:
    'Permanently delete an agent or profile-family batch. Project Owners and Team Leads are protected.',
  category: 'session',
  supportsRetry: false,
  inputs: [
    {
      name: 'agentName',
      label: 'Agent Name',
      description:
        'Optional: delete one named agent in the current project. This takes priority over Family Slug. Leave both selectors empty to use the agent that caused the event.',
      type: 'string',
      required: false,
    },
    {
      name: 'familySlug',
      label: 'Profile Family Slug',
      description:
        'Optional: delete every agent in matching profile families in the current project. Matching is case-insensitive; Agent Name takes priority. Leave both selectors empty to use the agent that caused the event.',
      type: 'string',
      required: false,
    },
    {
      name: 'skipWhileEpicsInStatuses',
      label: 'Skip while epics are in statuses',
      description:
        'Optional: select statuses. When any visible epic in this project is in one of these statuses, the action skips and changes nothing. A label that matches no status in this project fails the action and changes nothing.',
      type: 'select',
      required: false,
      multiple: true,
      optionsSource: 'project_statuses',
      allowedSources: ['custom'],
    },
  ],
};

const restartAgentAction: ActionMetadata = {
  type: 'restart_agent',
  name: 'Restart Agent',
  description: 'Restart an agent',
  category: 'session',
  inputs: [
    {
      name: 'agentName',
      label: 'Agent Name (Override)',
      description: 'Optional agent name override',
      type: 'string',
      required: false,
    },
  ],
};

function jsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as Response;
}

const projectStatuses = {
  items: [
    {
      id: 'status-review',
      projectId: 'proj-1',
      label: 'Review',
      color: '#0000ff',
      position: 2,
      mcpHidden: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'status-ip',
      projectId: 'proj-1',
      label: 'In Progress',
      color: '#ffaa00',
      position: 1,
      mcpHidden: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ],
};

interface CapturedRequest {
  body: Record<string, unknown> | null;
}

function installApiMock(subscriber: Subscriber): CapturedRequest {
  const captured: CapturedRequest = { body: null };
  globalThis.fetch = jest.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);

      if (url === '/api/subscribers/events') {
        return jsonResponse({
          events: [
            {
              name: 'terminal.watcher.triggered',
              label: 'Terminal Watcher Triggered',
              description: '',
              category: 'terminal',
              fields: [],
            },
          ],
        });
      }

      if (url === '/api/actions') {
        return jsonResponse([deleteAgentAction, restartAgentAction]);
      }

      if (url.startsWith('/api/watchers?')) {
        return jsonResponse([]);
      }

      if (url === '/api/statuses?projectId=proj-1') {
        return jsonResponse(projectStatuses);
      }

      if (url === '/api/subscribers/sub-1' && init?.method === 'PUT') {
        captured.body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
        return jsonResponse(subscriber);
      }

      if (url === '/api/subscribers' && init?.method === 'POST') {
        captured.body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
        return jsonResponse({ ...subscriber, id: 'sub-created' });
      }

      return jsonResponse({});
    },
  );
  return captured;
}

function makeSubscriber(overrides: Partial<Subscriber> = {}): Subscriber {
  return {
    id: 'sub-1',
    projectId: 'proj-1',
    name: 'Delete on drift',
    description: null,
    enabled: true,
    eventName: 'terminal.watcher.triggered',
    eventFilter: null,
    actionType: 'delete_agent',
    actionInputs: { agentName: { source: 'custom', customValue: 'Coder' } },
    delayMs: 0,
    cooldownMs: 5000,
    retryOnError: false,
    groupName: null,
    position: 0,
    priority: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function renderWithQuery(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe('SubscriberDialog - Delete Agent', () => {
  beforeEach(() => {
    toastSpy.mockReset();
    // Radix UI uses ResizeObserver via @radix-ui/react-use-size; jsdom does not provide it.
    if (!globalThis.ResizeObserver) {
      globalThis.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
    }
  });

  it('renders both selectors with safety copy through the generic form and creates with retry off', async () => {
    const subscriber = makeSubscriber();
    const captured = installApiMock(subscriber);

    renderWithQuery(<SubscriberDialog open={true} onOpenChange={jest.fn()} />);

    fireEvent.change(screen.getByPlaceholderText('Error Handler'), {
      target: { value: 'Cleanup on drift' },
    });
    fireEvent.change(screen.getByPlaceholderText('Or enter custom event name...'), {
      target: { value: 'terminal.watcher.triggered' },
    });

    fireEvent.click(await screen.findByRole('combobox', { name: 'Action type' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Delete Agent' }));

    // Generic action-input form renders both selectors.
    expect(screen.getByText('Agent Name')).toBeInTheDocument();
    expect(screen.getByText('Profile Family Slug')).toBeInTheDocument();

    // Selector priority, event-agent fallback, permanence, and protected-target copy.
    expect(screen.getByText(/takes priority over Family Slug/)).toBeInTheDocument();
    expect(screen.getAllByText(/agent that caused the event/)).toHaveLength(2);
    expect(screen.getByText(/Permanently delete/)).toBeInTheDocument();
    expect(screen.getByText(/Project Owners and Team Leads are protected/)).toBeInTheDocument();

    const retry = screen.getByLabelText('Retry on error');
    expect(retry).toBeDisabled();
    expect(retry).not.toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(captured.body).not.toBeNull());
    expect(captured.body).toEqual(
      expect.objectContaining({
        actionType: 'delete_agent',
        retryOnError: false,
      }),
    );
  });

  it('clears a stored enabled retry after metadata hydration and serializes false on update', async () => {
    const subscriber = makeSubscriber({ retryOnError: true });
    const captured = installApiMock(subscriber);

    renderWithQuery(
      <SubscriberDialog open={true} onOpenChange={jest.fn()} subscriber={subscriber} />,
    );

    await screen.findByText('Profile Family Slug');

    const retry = screen.getByLabelText('Retry on error');
    expect(retry).toBeDisabled();
    expect(retry).not.toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: 'Update' }));

    await waitFor(() => expect(captured.body).not.toBeNull());
    expect(captured.body).toEqual(
      expect.objectContaining({
        actionType: 'delete_agent',
        retryOnError: false,
        actionInputs: { agentName: { source: 'custom', customValue: 'Coder' } },
      }),
    );
  });

  it('serializes retryOnError false when submitted before metadata hydrates', async () => {
    const subscriber = makeSubscriber({ retryOnError: true });
    const captured = installApiMock(subscriber);

    renderWithQuery(
      <SubscriberDialog open={true} onOpenChange={jest.fn()} subscriber={subscriber} />,
    );

    await screen.findByDisplayValue('Delete on drift');
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));

    await waitFor(() => expect(captured.body).not.toBeNull());
    expect(captured.body).toEqual(
      expect.objectContaining({
        actionType: 'delete_agent',
        retryOnError: false,
      }),
    );
  });

  it('keeps retry configurable for actions without the retry restriction', async () => {
    const subscriber = makeSubscriber({
      actionType: 'restart_agent',
      actionInputs: { agentName: { source: 'custom', customValue: 'Coder' } },
      retryOnError: true,
    });
    const captured = installApiMock(subscriber);

    renderWithQuery(
      <SubscriberDialog open={true} onOpenChange={jest.fn()} subscriber={subscriber} />,
    );

    await screen.findByText('Agent Name (Override)');

    const retry = screen.getByLabelText('Retry on error');
    expect(retry).toBeEnabled();
    expect(retry).toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: 'Update' }));

    await waitFor(() => expect(captured.body).not.toBeNull());
    expect(captured.body).toEqual(
      expect.objectContaining({
        actionType: 'restart_agent',
        retryOnError: true,
      }),
    );
  });

  it('fetches project statuses and lists them in position order in the status picker', async () => {
    installApiMock(makeSubscriber());

    renderWithQuery(<SubscriberDialog open={true} onOpenChange={jest.fn()} />);

    fireEvent.change(screen.getByPlaceholderText('Or enter custom event name...'), {
      target: { value: 'terminal.watcher.triggered' },
    });
    fireEvent.click(await screen.findByRole('combobox', { name: 'Action type' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Delete Agent' }));

    fireEvent.click(
      await screen.findByRole('combobox', { name: 'Skip while epics are in statuses' }),
    );

    const inProgress = await screen.findByRole('checkbox', { name: 'In Progress' });
    const review = screen.getByRole('checkbox', { name: 'Review' });
    expect(inProgress).not.toBeChecked();
    expect(review).not.toBeChecked();
    // Position order (In Progress=1, Review=2), not API row order (Review listed first).
    expect(
      inProgress.compareDocumentPosition(review) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('round-trips a stored value through save and shows the selected badges', async () => {
    const subscriber = makeSubscriber({
      actionInputs: {
        agentName: { source: 'custom', customValue: 'Coder' },
        skipWhileEpicsInStatuses: { source: 'custom', customValue: 'In Progress, Review' },
      },
    });
    const captured = installApiMock(subscriber);

    renderWithQuery(
      <SubscriberDialog open={true} onOpenChange={jest.fn()} subscriber={subscriber} />,
    );

    await screen.findByText('Skip while epics are in statuses');
    expect(screen.getByText('In Progress')).toBeInTheDocument();
    expect(screen.getByText('Review')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Update' }));

    await waitFor(() => expect(captured.body).not.toBeNull());
    expect(captured.body).toEqual(
      expect.objectContaining({
        actionType: 'delete_agent',
        actionInputs: {
          agentName: { source: 'custom', customValue: 'Coder' },
          skipWhileEpicsInStatuses: { source: 'custom', customValue: 'In Progress, Review' },
        },
      }),
    );
  });

  it('blocks save with an Unknown status error while a stored label is missing from the project', async () => {
    const subscriber = makeSubscriber({
      actionInputs: {
        agentName: { source: 'custom', customValue: 'Coder' },
        skipWhileEpicsInStatuses: { source: 'custom', customValue: 'In Progress, Gone' },
      },
    });
    const captured = installApiMock(subscriber);

    renderWithQuery(
      <SubscriberDialog open={true} onOpenChange={jest.fn()} subscriber={subscriber} />,
    );

    await screen.findByText('Gone');
    expect(screen.getByRole('button', { name: 'Remove Gone' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Update' }));

    expect(await screen.findByText('Unknown status: Gone')).toBeInTheDocument();
    expect(captured.body).toBeNull();

    // Removing the stale label clears the error and lets the save through.
    fireEvent.click(screen.getByRole('button', { name: 'Remove Gone' }));
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));

    await waitFor(() => expect(captured.body).not.toBeNull());
    expect(captured.body).toEqual(
      expect.objectContaining({
        actionInputs: {
          agentName: { source: 'custom', customValue: 'Coder' },
          skipWhileEpicsInStatuses: { source: 'custom', customValue: 'In Progress' },
        },
      }),
    );
  });

  it('saves without error when the status selection is empty', async () => {
    const subscriber = makeSubscriber({
      actionInputs: {
        agentName: { source: 'custom', customValue: 'Coder' },
        skipWhileEpicsInStatuses: { source: 'custom', customValue: '' },
      },
    });
    const captured = installApiMock(subscriber);

    renderWithQuery(
      <SubscriberDialog open={true} onOpenChange={jest.fn()} subscriber={subscriber} />,
    );

    await screen.findByText('Skip while epics are in statuses');

    fireEvent.click(screen.getByRole('button', { name: 'Update' }));

    await waitFor(() => expect(captured.body).not.toBeNull());
    expect(captured.body).toEqual(
      expect.objectContaining({
        actionType: 'delete_agent',
        actionInputs: {
          agentName: { source: 'custom', customValue: 'Coder' },
          skipWhileEpicsInStatuses: { source: 'custom', customValue: '' },
        },
      }),
    );
  });
});
