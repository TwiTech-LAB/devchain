import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SubscriberDialog } from './SubscriberDialog';
import type { Subscriber } from '@/ui/lib/subscribers';

const toastSpy = jest.fn();

jest.mock('@/ui/hooks/use-toast', () => ({
  useToast: () => ({ toast: toastSpy }),
}));

jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => ({ selectedProjectId: 'proj-1' }),
}));

const sendMessageMetadata = {
  type: 'send_agent_message',
  name: 'Send Message to Agent',
  description: 'Send a message',
  category: 'terminal',
  inputs: [
    {
      name: 'text',
      label: 'Message Text',
      description: 'Text to send',
      type: 'textarea',
      required: true,
    },
    {
      name: 'submitKey',
      label: 'Submit Key',
      description: 'Key to press',
      type: 'select',
      required: false,
      defaultValue: 'Enter',
      allowedSources: ['custom'],
      options: [
        { value: 'Enter', label: 'Enter (submit)' },
        { value: 'none', label: 'None (paste only)' },
      ],
    },
    {
      name: 'deliveryMode',
      label: 'Delivery Mode',
      description: 'Choose delivery timing',
      type: 'select',
      required: false,
      defaultValue: 'default',
      allowedSources: ['custom'],
      options: [
        { value: 'default', label: 'Default (queue)' },
        { value: 'immediate', label: 'Deliver Immediately' },
        { value: 'on_idle', label: 'Delivery on Idle' },
      ],
    },
  ],
};

function createSubscriber(actionInputs: Subscriber['actionInputs']): Subscriber {
  return {
    id: 'sub-1',
    projectId: 'proj-1',
    name: 'Send notification',
    description: null,
    enabled: true,
    eventName: 'terminal.watcher.triggered',
    eventFilter: null,
    actionType: 'send_agent_message',
    actionInputs,
    delayMs: 0,
    cooldownMs: 5000,
    retryOnError: false,
    groupName: null,
    position: 0,
    priority: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function renderDialog(subscriber: Subscriber, onUpdate: (body: Record<string, unknown>) => void) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/subscribers/events') {
      return { ok: true, json: async () => ({ events: [] }) } as Response;
    }
    if (url === '/api/actions') {
      return { ok: true, json: async () => [sendMessageMetadata] } as Response;
    }
    if (url.startsWith('/api/watchers?')) {
      return { ok: true, json: async () => [] } as Response;
    }
    if (url === '/api/subscribers/sub-1' && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
      onUpdate(body);
      return { ok: true, json: async () => ({ ...subscriber, ...body }) } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response;
  }) as jest.Mock;

  return render(
    <QueryClientProvider client={queryClient}>
      <SubscriberDialog open={true} onOpenChange={jest.fn()} subscriber={subscriber} />
    </QueryClientProvider>,
  );
}

describe('SubscriberDialog - Send Message', () => {
  beforeEach(() => {
    toastSpy.mockReset();
    global.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });

  it.each([
    {
      label: 'legacy immediate mapping',
      inputs: { immediate: { source: 'custom', customValue: 'true' } },
      mode: 'immediate',
      display: 'Deliver Immediately',
    },
    {
      label: 'explicit mode wins over legacy mapping',
      inputs: {
        deliveryMode: { source: 'custom', customValue: 'on_idle' },
        immediate: { source: 'custom', customValue: 'true' },
      },
      mode: 'on_idle',
      display: 'Delivery on Idle',
    },
    {
      label: 'missing mode defaults on save',
      inputs: {},
      mode: 'default',
      display: 'Default (queue)',
    },
  ] as const)('$label', async ({ inputs, mode, display }) => {
    let updateBody: Record<string, unknown> | null = null;
    const subscriber = createSubscriber({
      text: { source: 'custom', customValue: 'Hello' },
      ...(inputs as Parameters<typeof createSubscriber>[0]),
    });
    renderDialog(subscriber, (body) => {
      updateBody = body;
    });
    await screen.findByText('Delivery Mode');
    expect(screen.getAllByText(display)).not.toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(updateBody).not.toBeNull());
    expect(updateBody).toEqual(
      expect.objectContaining({
        actionInputs: {
          text: { source: 'custom', customValue: 'Hello' },
          deliveryMode: { source: 'custom', customValue: mode },
          submitKey: { source: 'custom', customValue: 'Enter' },
        },
      }),
    );
  });

  it('rejects an unsupported explicit delivery mode', async () => {
    const onUpdate = jest.fn();
    const subscriber = createSubscriber({
      text: { source: 'custom', customValue: 'Hello' },
      deliveryMode: { source: 'custom', customValue: 'eventually' },
    });
    renderDialog(subscriber, onUpdate);

    await screen.findByText('Delivery Mode');
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));

    expect(await screen.findByText('Unsupported value for Delivery Mode')).toBeInTheDocument();
    expect(onUpdate).not.toHaveBeenCalled();
  });
});
