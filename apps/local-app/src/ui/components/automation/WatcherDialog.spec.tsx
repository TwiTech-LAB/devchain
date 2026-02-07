import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WatcherDialog } from './WatcherDialog';
import type { Watcher } from '@/ui/lib/watchers';

const toastSpy = jest.fn();

jest.mock('@/ui/hooks/use-toast', () => ({
  useToast: () => ({ toast: toastSpy }),
}));

jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => ({ selectedProjectId: 'project-1' }),
}));

function renderWithQuery(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

async function selectConditionType(option: 'Contains' | 'Regex' | 'Not Contains') {
  const conditionTypeLabel = screen.getByText('Condition Type');
  const container = conditionTypeLabel.closest('div');
  if (!container) {
    throw new Error('Condition type container not found');
  }

  fireEvent.click(within(container).getByRole('combobox'));
  const options = await screen.findAllByRole('option', { name: option });
  fireEvent.click(options[options.length - 1]);
}

describe('WatcherDialog', () => {
  beforeEach(() => {
    toastSpy.mockReset();

    // Radix uses ResizeObserver in dialog/select internals; jsdom does not provide it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (!(global as any).ResizeObserver) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (global as any).ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
    }
    // Radix Select also expects scrollIntoView on options in jsdom.
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = jest.fn();
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.startsWith('/api/agents?')) {
        return { ok: true, json: async () => ({ items: [] }) } as Response;
      }

      if (url.startsWith('/api/profiles?')) {
        return { ok: true, json: async () => ({ items: [] }) } as Response;
      }

      if (url === '/api/providers') {
        return { ok: true, json: async () => ({ items: [] }) } as Response;
      }

      if (url === '/api/watchers' && init?.method === 'POST') {
        const payload = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
        return {
          ok: true,
          json: async () => ({
            id: 'watcher-1',
            ...payload,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }),
        } as Response;
      }

      if (url.startsWith('/api/watchers/') && init?.method === 'PUT') {
        const payload = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
        return {
          ok: true,
          json: async () => ({
            id: 'watcher-edit',
            ...payload,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }),
        } as Response;
      }

      return { ok: true, json: async () => ({}) } as Response;
    });
  });

  it('shows idle gate input for all condition types and displays hint when enabled', async () => {
    renderWithQuery(<WatcherDialog open={true} onOpenChange={jest.fn()} watcher={null} />);

    expect(screen.getByLabelText(/Only when idle for \(seconds\)/i)).toHaveValue(0);
    expect(screen.getByLabelText(/Viewport Lines/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Pattern/i)).toBeInTheDocument();
    expect(
      screen.queryByText(/Recommended: use "Until Condition Clears" cooldown mode/i),
    ).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Only when idle for \(seconds\)/i), {
      target: { value: '30' },
    });
    expect(
      screen.getByText(/Recommended: use "Until Condition Clears" cooldown mode/i),
    ).toBeInTheDocument();

    await selectConditionType('Regex');
    expect(screen.getByLabelText(/Regex Flags/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Only when idle for \(seconds\)/i)).toBeInTheDocument();

    await selectConditionType('Not Contains');
    expect(screen.getByLabelText(/Only when idle for \(seconds\)/i)).toBeInTheDocument();
  });

  it('submits watcher with idleAfterSeconds in payload', async () => {
    const onOpenChange = jest.fn();
    renderWithQuery(<WatcherDialog open={true} onOpenChange={onOpenChange} watcher={null} />);

    fireEvent.change(screen.getByLabelText(/^Name \*/i), {
      target: { value: 'Idle Gate Watcher' },
    });
    fireEvent.change(screen.getByLabelText(/^Event Name \*/i), {
      target: { value: 'watcher.error_detected' },
    });
    fireEvent.change(screen.getByLabelText(/Pattern/i), { target: { value: 'Error:' } });
    fireEvent.change(screen.getByLabelText(/Only when idle for \(seconds\)/i), {
      target: { value: '45' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      const fetchMock = global.fetch as unknown as jest.Mock;
      const createCalls = fetchMock.mock.calls.filter(
        (call) => call[0] === '/api/watchers' && call[1]?.method === 'POST',
      );
      expect(createCalls.length).toBeGreaterThan(0);
    });

    const fetchMock = global.fetch as unknown as jest.Mock;
    const createCall = fetchMock.mock.calls.find(
      (call) => call[0] === '/api/watchers' && call[1]?.method === 'POST',
    );
    const body = JSON.parse(String(createCall?.[1]?.body ?? '{}')) as {
      condition?: { type?: string; pattern?: string; flags?: string };
      idleAfterSeconds?: number;
    };

    expect(body.condition).toEqual({ type: 'contains', pattern: 'Error:' });
    expect(body.condition?.flags).toBeUndefined();
    expect(body.idleAfterSeconds).toBe(45);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('loads idleAfterSeconds in edit mode and sends updates', async () => {
    const existingWatcher: Watcher = {
      id: 'watcher-edit',
      projectId: 'project-1',
      name: 'Existing Watcher',
      description: null,
      enabled: true,
      scope: 'all',
      scopeFilterId: null,
      pollIntervalMs: 5000,
      viewportLines: 50,
      condition: { type: 'contains', pattern: 'Error:' },
      idleAfterSeconds: 90,
      cooldownMs: 30000,
      cooldownMode: 'time',
      eventName: 'watcher.error_existing',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    renderWithQuery(
      <WatcherDialog open={true} onOpenChange={jest.fn()} watcher={existingWatcher} />,
    );

    expect(screen.getByLabelText(/Only when idle for \(seconds\)/i)).toHaveValue(90);
    fireEvent.change(screen.getByLabelText(/Only when idle for \(seconds\)/i), {
      target: { value: '120' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));

    await waitFor(() => {
      const fetchMock = global.fetch as unknown as jest.Mock;
      const updateCalls = fetchMock.mock.calls.filter(
        (call) => String(call[0]).startsWith('/api/watchers/') && call[1]?.method === 'PUT',
      );
      expect(updateCalls.length).toBeGreaterThan(0);
    });

    const fetchMock = global.fetch as unknown as jest.Mock;
    const updateCall = fetchMock.mock.calls.find(
      (call) => String(call[0]).startsWith('/api/watchers/') && call[1]?.method === 'PUT',
    );
    const body = JSON.parse(String(updateCall?.[1]?.body ?? '{}')) as {
      idleAfterSeconds?: number;
    };
    expect(body.idleAfterSeconds).toBe(120);
  });
});
