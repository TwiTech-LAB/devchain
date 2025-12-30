import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SubscriberDialog } from './SubscriberDialog';
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

function renderWithQuery(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe('SubscriberDialog - Restart Agent', () => {
  beforeEach(() => {
    toastSpy.mockReset();
    // Radix UI uses ResizeObserver via @radix-ui/react-use-size; jsdom doesn't provide it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (!(global as any).ResizeObserver) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (global as any).ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
    }
  });

  it('does not render Agent ID override and does not persist legacy agentId mapping on update', async () => {
    const subscriber: Subscriber = {
      id: 'sub-1',
      projectId: 'proj-1',
      name: 'Restart on error',
      description: null,
      enabled: true,
      eventName: 'terminal.watcher.triggered',
      eventFilter: null,
      actionType: 'restart_agent',
      actionInputs: {
        agentName: { source: 'custom', customValue: 'Coder' },
        agentId: { source: 'custom', customValue: 'legacy-agent-id' },
      },
      delayMs: 0,
      cooldownMs: 5000,
      retryOnError: false,
      groupName: null,
      position: 0,
      priority: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    let updateBody: Record<string, unknown> | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url === '/api/subscribers/events') {
        return {
          ok: true,
          json: async () => ({
            events: [
              {
                name: 'terminal.watcher.triggered',
                label: 'Terminal Watcher Triggered',
                description: '',
                category: 'terminal',
                fields: [],
              },
            ],
          }),
        } as Response;
      }

      if (url === '/api/actions') {
        return {
          ok: true,
          json: async () => [
            {
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
            },
          ],
        } as Response;
      }

      if (url.startsWith('/api/watchers?')) {
        return { ok: true, json: async () => [] } as Response;
      }

      if (url === '/api/subscribers/sub-1' && init?.method === 'PUT') {
        updateBody = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
        return {
          ok: true,
          json: async () => ({
            ...subscriber,
            ...(updateBody ?? {}),
            updatedAt: new Date().toISOString(),
          }),
        } as Response;
      }

      return { ok: true, json: async () => ({}) } as Response;
    });

    renderWithQuery(
      <SubscriberDialog open={true} onOpenChange={jest.fn()} subscriber={subscriber} />,
    );

    // Wait for action metadata to load so the inputs render
    await screen.findByText('Agent Name (Override)');
    expect(screen.queryByText('Agent ID (Override)')).not.toBeInTheDocument();

    // Ensure required fields are set (the Event Name select may not render a label until opened).
    fireEvent.change(screen.getByPlaceholderText('Or enter custom event name...'), {
      target: { value: 'terminal.watcher.triggered' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Update' }));

    await waitFor(() => expect(updateBody).not.toBeNull());
    expect(updateBody).toEqual(
      expect.objectContaining({
        actionType: 'restart_agent',
        actionInputs: {
          agentName: { source: 'custom', customValue: 'Coder' },
        },
      }),
    );
  });
});
