import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AgentsPage } from './AgentsPage';

const toastSpy = jest.fn();

jest.mock('@/ui/hooks/use-toast', () => ({
  useToast: () => ({ toast: toastSpy }),
}));

const openTerminalWindowSpy = jest.fn();

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

jest.mock('@/ui/terminal-windows', () => ({
  useTerminalWindowManager: () => openTerminalWindowSpy,
}));

function renderWithQuery(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe('AgentsPage - Restart flow', () => {
  beforeEach(() => {
    openTerminalWindowSpy.mockReset();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as unknown as { fetch: unknown }).fetch = jest.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
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
          // indicate existing session so Restart button shows
          return {
            ok: true,
            json: async () => ({ 'agent-1': { online: true, sessionId: 'sess-old' } }),
          } as Response;
        }
        // Atomic restart endpoint
        if (url === '/api/agents/agent-1/restart' && init?.method === 'POST') {
          return {
            ok: true,
            json: async () => ({
              session: {
                id: 'sess-new',
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
        return { ok: true, json: async () => ({}) } as Response;
      },
    );
  });

  it('executes terminate→launch and opens terminal on Restart', async () => {
    const user = userEvent.setup();
    renderWithQuery(<AgentsPage />);

    await waitFor(() => expect(screen.getByText('Project Agents')).toBeInTheDocument());
    const restartBtn = await screen.findByRole('button', { name: /restart session/i });
    await user.click(restartBtn);

    await waitFor(() => expect(openTerminalWindowSpy).toHaveBeenCalled());
  });

  it('shows error toast and resets state when launch fails', async () => {
    const user = userEvent.setup();
    // Override fetch to fail on launch
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as unknown as { fetch: unknown }).fetch = jest.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
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
            json: async () => ({ 'agent-1': { online: true, sessionId: 'sess-old' } }),
          } as Response;
        }
        // Atomic restart endpoint - fail case
        if (url === '/api/agents/agent-1/restart' && init?.method === 'POST') {
          return { ok: false, json: async () => ({ message: 'Launch failed' }) } as Response;
        }
        return { ok: true, json: async () => ({}) } as Response;
      },
    );

    renderWithQuery(<AgentsPage />);

    await waitFor(() => expect(screen.getByText('Project Agents')).toBeInTheDocument());
    const restartBtn = await screen.findByRole('button', { name: /restart session/i });
    await user.click(restartBtn);

    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Restart failed',
          description: expect.stringMatching(/Launch failed|Failed to restart session/),
        }),
      );
    });

    // Button should be usable again (no spinner text)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /restart session/i })).toBeEnabled(),
    );
    expect(screen.getByText('Restart')).toBeInTheDocument();
  });
});
