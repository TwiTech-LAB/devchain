import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AgentsPage } from './AgentsPage';

const toastSpy = jest.fn();
const openTerminalWindowSpy = jest.fn();

jest.mock('@/ui/hooks/use-toast', () => ({
  useToast: () => ({ toast: toastSpy }),
}));

jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => ({
    selectedProjectId: 'project-1',
    selectedProject: { id: 'project-1', name: 'Project One', rootPath: '/tmp/project-one' },
    projects: [],
    projectsLoading: false,
    projectsError: false,
    refetchProjects: jest.fn(),
    setSelectedProjectId: jest.fn(),
  }),
}));

jest.mock('@/ui/terminal-windows', () => ({
  useTerminalWindowManager: () => openTerminalWindowSpy,
}));

function renderWithQuery(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

function autoCompactErrorResponse(path: string): Response {
  return {
    ok: false,
    status: 409,
    json: async () => ({
      statusCode: 409,
      code: 'SESSION_LAUNCH_FAILED',
      message: 'Claude auto-compact is enabled.',
      details: {
        code: 'CLAUDE_AUTO_COMPACT_ENABLED',
        providerId: 'provider-1',
        providerName: 'claude',
      },
      timestamp: new Date().toISOString(),
      path,
    }),
  } as Response;
}

function buildFetchMock(options?: { restartFailsWithAutoCompact?: boolean }) {
  let launchCallCount = 0;

  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);

    if (url.includes('/api/profiles')) {
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }

    if (url === '/api/providers') {
      return {
        ok: true,
        json: async () => ({ items: [{ id: 'provider-1', name: 'claude' }] }),
      } as Response;
    }

    if (url.includes('/api/agents?projectId=')) {
      return {
        ok: true,
        json: async () => ({
          items: [
            {
              id: 'agent-1',
              projectId: 'project-1',
              profileId: 'profile-1',
              name: 'Agent One',
              createdAt: '2024-01-01T00:00:00.000Z',
              updatedAt: '2024-01-01T00:00:00.000Z',
            },
          ],
        }),
      } as Response;
    }

    if (url.includes('/api/sessions/agents/presence')) {
      return {
        ok: true,
        json: async () => ({
          'agent-1': options?.restartFailsWithAutoCompact
            ? { online: true, sessionId: 'session-old-1' }
            : { online: false },
        }),
      } as Response;
    }

    if (url.startsWith('/api/preflight')) {
      return {
        ok: true,
        json: async () => ({
          overall: 'pass',
          checks: [],
          providers: [],
          supportedMcpProviders: [],
          timestamp: new Date().toISOString(),
        }),
      } as Response;
    }

    if (url === '/api/sessions/launch' && init?.method === 'POST') {
      launchCallCount += 1;

      if (launchCallCount === 1) {
        return autoCompactErrorResponse('/api/sessions/launch');
      }

      return {
        ok: true,
        json: async () => ({
          id: 'session-new-1',
          epicId: null,
          agentId: 'agent-1',
          tmuxSessionId: 'tmux-1',
          status: 'running',
          startedAt: new Date().toISOString(),
          endedAt: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      } as Response;
    }

    if (url === '/api/agents/agent-1/restart' && init?.method === 'POST') {
      if (options?.restartFailsWithAutoCompact) {
        return autoCompactErrorResponse('/api/agents/agent-1/restart');
      }

      return {
        ok: true,
        json: async () => ({
          session: {
            id: 'session-new-1',
            epicId: null,
            agentId: 'agent-1',
            tmuxSessionId: 'tmux-1',
            status: 'running',
            startedAt: new Date().toISOString(),
            endedAt: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          terminateStatus: 'success',
        }),
      } as Response;
    }

    if (url === '/api/providers/provider-1/auto-compact/disable' && init?.method === 'POST') {
      return { ok: true, text: async () => '', json: async () => ({}) } as Response;
    }

    if (url.includes('/api/projects/project-1/presets')) {
      return { ok: true, json: async () => ({ presets: [] }) } as Response;
    }

    if (url.startsWith('/api/sessions')) {
      return { ok: true, json: async () => [] } as Response;
    }

    return { ok: true, json: async () => ({}) } as Response;
  });
}

describe('AgentsPage auto-compact handling', () => {
  beforeEach(() => {
    toastSpy.mockReset();
    openTerminalWindowSpy.mockReset();
  });

  it('shows standardized toast on launch auto-compact error', async () => {
    const fetchMock = buildFetchMock();
    global.fetch = fetchMock as unknown as typeof fetch;

    renderWithQuery(<AgentsPage />);
    await screen.findByText('Agent One');

    fireEvent.click(screen.getByRole('button', { name: /launch session/i }));

    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Session launch blocked',
          description: 'Claude auto-compact is enabled - see the notification to resolve.',
        }),
      );
    });
    expect(screen.queryByText('Claude Auto-Compact Detected')).not.toBeInTheDocument();
  });

  it('shows standardized toast on restart auto-compact error', async () => {
    const fetchMock = buildFetchMock({ restartFailsWithAutoCompact: true });
    global.fetch = fetchMock as unknown as typeof fetch;

    renderWithQuery(<AgentsPage />);
    await screen.findByText('Agent One');

    fireEvent.click(await screen.findByRole('button', { name: /restart session/i }));

    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Session launch blocked',
          description: 'Claude auto-compact is enabled - see the notification to resolve.',
        }),
      );
    });
    expect(screen.queryByText('Claude Auto-Compact Detected')).not.toBeInTheDocument();
  });

  it('does not call disable endpoint or retry launch from page-level handler', async () => {
    const fetchMock = buildFetchMock();
    global.fetch = fetchMock as unknown as typeof fetch;

    renderWithQuery(<AgentsPage />);
    await screen.findByText('Agent One');

    fireEvent.click(screen.getByRole('button', { name: /launch session/i }));

    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Session launch blocked',
          description: 'Claude auto-compact is enabled - see the notification to resolve.',
        }),
      );
    });

    const launchCalls = fetchMock.mock.calls.filter(
      ([url, init]) => String(url) === '/api/sessions/launch' && init?.method === 'POST',
    );
    expect(launchCalls).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalledWith('/api/providers/provider-1/auto-compact/disable', {
      method: 'POST',
    });
    expect(openTerminalWindowSpy).not.toHaveBeenCalled();
  });
});
