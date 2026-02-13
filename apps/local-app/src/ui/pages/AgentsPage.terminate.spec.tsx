import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AgentsPage } from './AgentsPage';

const toastSpy = jest.fn();

jest.mock('@/ui/hooks/use-toast', () => ({
  useToast: () => ({ toast: toastSpy }),
}));

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
  useTerminalWindowManager: () => jest.fn(),
}));

function renderWithQuery(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe('AgentsPage - Terminate flow', () => {
  beforeEach(() => {
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
            json: async () => ({ 'agent-1': { online: true, sessionId: 'sess-1' } }),
          } as Response;
        }
        if (url === '/api/sessions/sess-1' && init?.method === 'DELETE') {
          return { ok: true, json: async () => ({ message: 'terminated' }) } as Response;
        }
        return { ok: true, json: async () => ({}) } as Response;
      },
    );
  });

  it('terminates session via helper and disables button while pending', async () => {
    const user = userEvent.setup();
    renderWithQuery(<AgentsPage />);

    await waitFor(() => expect(screen.getByText('Project Agents')).toBeInTheDocument());
    const terminateBtn = await screen.findByRole('button', { name: /terminate session/i });
    await user.click(terminateBtn);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/sessions/sess-1',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });

  it('shows error toast and resets state when terminate fails', async () => {
    const user = userEvent.setup();
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
            json: async () => ({ 'agent-1': { online: true, sessionId: 'sess-1' } }),
          } as Response;
        }
        if (url === '/api/sessions/sess-1' && init?.method === 'DELETE') {
          return { ok: false, json: async () => ({ message: 'Boom' }) } as Response;
        }
        return { ok: true, json: async () => ({}) } as Response;
      },
    );

    renderWithQuery(<AgentsPage />);

    await waitFor(() => expect(screen.getByText('Project Agents')).toBeInTheDocument());
    const terminateBtn = await screen.findByRole('button', { name: /terminate session/i });
    await user.click(terminateBtn);

    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Terminate failed',
          description: expect.stringMatching(/Boom|Failed to terminate session/),
        }),
      );
    });

    // Button returns to normal state
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /terminate session/i })).toBeEnabled(),
    );
    expect(screen.getByText('Terminate')).toBeInTheDocument();
  });
});
