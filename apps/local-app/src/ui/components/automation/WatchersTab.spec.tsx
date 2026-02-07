import React from 'react';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WatchersTab } from './WatchersTab';
import type { Watcher } from '@/ui/lib/watchers';

const toastSpy = jest.fn();

jest.mock('@/ui/hooks/use-toast', () => ({
  useToast: () => ({ toast: toastSpy }),
}));

jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => ({ selectedProjectId: 'project-1' }),
}));

jest.mock('./WatcherDialog', () => ({
  WatcherDialog: () => null,
}));

function renderWithQuery(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe('WatchersTab', () => {
  beforeEach(() => {
    toastSpy.mockReset();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (!(global as any).ResizeObserver) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (global as any).ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
    }

    const watchers: Watcher[] = [
      {
        id: 'watcher-1',
        projectId: 'project-1',
        name: 'Idle gated regex',
        description: null,
        enabled: true,
        scope: 'all',
        scopeFilterId: null,
        pollIntervalMs: 5000,
        viewportLines: 50,
        condition: { type: 'regex', pattern: 'error|exception' },
        idleAfterSeconds: 5,
        cooldownMs: 30000,
        cooldownMode: 'time',
        eventName: 'watcher.error_detected',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: 'watcher-2',
        projectId: 'project-1',
        name: 'Immediate contains',
        description: null,
        enabled: true,
        scope: 'all',
        scopeFilterId: null,
        pollIntervalMs: 5000,
        viewportLines: 50,
        condition: { type: 'contains', pattern: 'Error:' },
        idleAfterSeconds: 0,
        cooldownMs: 30000,
        cooldownMode: 'time',
        eventName: 'watcher.error_contains',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/watchers?')) {
        return { ok: true, json: async () => watchers } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });
  });

  it('shows idle gate prefix only when idleAfterSeconds is greater than zero', async () => {
    renderWithQuery(<WatchersTab />);

    await screen.findByText('Idle gated regex');

    expect(screen.getByText('Idle >= 5s + Regex: error|exception')).toBeInTheDocument();
    expect(screen.getByText('Contains: Error:')).toBeInTheDocument();
  });
});
