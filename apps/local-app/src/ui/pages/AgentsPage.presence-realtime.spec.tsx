import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AgentsPage } from './AgentsPage';

jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => ({
    selectedProjectId: 'proj-1',
    selectedProject: { id: 'proj-1', name: 'Test Project' },
    projects: [],
    projectsLoading: false,
    projectsError: false,
    refetchProjects: jest.fn(),
    setSelectedProjectId: jest.fn(),
  }),
}));

// Avoid importing terminal window components (xterm) in JSDOM
jest.mock('@/ui/terminal-windows', () => ({
  useTerminalWindowManager: () => jest.fn(),
}));

// Minimal socket mock capturing handlers
interface MockSocket {
  on: jest.Mock;
  off: jest.Mock;
  emit: jest.Mock;
  disconnect: jest.Mock;
}
const handlers: Record<string, ((...args: unknown[]) => unknown)[]> = {};
const mockSocket: MockSocket = {
  on: jest.fn(),
  off: jest.fn(),
  emit: jest.fn(),
  disconnect: jest.fn(),
};
mockSocket.on.mockImplementation((event: string, cb: (...args: unknown[]) => unknown) => {
  handlers[event] = handlers[event] || [];
  handlers[event].push(cb);
  return mockSocket;
});
mockSocket.off.mockImplementation((event: string, cb: (...args: unknown[]) => unknown) => {
  if (!handlers[event]) return mockSocket;
  handlers[event] = handlers[event].filter((fn) => fn !== cb);
  return mockSocket;
});

jest.mock('socket.io-client', () => ({
  io: () => mockSocket,
}));

describe('AgentsPage realtime presence updates', () => {
  const originalFetch = global.fetch;
  let online = false;

  function renderWithQuery(ui: React.ReactElement) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
  }

  beforeEach(() => {
    online = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/profiles')) {
        return { ok: true, json: async () => ({ items: [] }) } as Response;
      }
      if (url.includes('/api/providers')) {
        return { ok: true, json: async () => ({ items: [] }) } as Response;
      }
      if (url.includes('/api/agents?projectId=')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                id: 'agent-1',
                projectId: 'proj-1',
                profileId: 'profile-1',
                name: 'CC2',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            ],
          }),
        } as Response;
      }
      if (url.includes('/api/sessions/agents/presence')) {
        return {
          ok: true,
          json: async () => ({
            'agent-1': online ? { online: true, sessionId: 'sess-1' } : { online: false },
          }),
        } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });
  });

  afterEach(() => {
    if (originalFetch) {
      global.fetch = originalFetch;
    }
  });

  it('switches from Launch to Restart/Terminate when presence envelope arrives', async () => {
    renderWithQuery(<AgentsPage />);

    // Initially offline → Launch Session visible
    await waitFor(() => expect(screen.getByText('Launch Session')).toBeInTheDocument());

    // Flip presence and emit envelope
    online = true;
    handlers['message']?.forEach((fn) =>
      fn({ topic: 'agent/agent-1', type: 'presence', payload: {}, ts: new Date().toISOString() }),
    );

    await waitFor(() => expect(screen.getByText('Restart')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('Terminate')).toBeInTheDocument());
  });
});
