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

// Avoid pulling xterm/terminal window components into JSDOM
jest.mock('@/ui/terminal-windows', () => ({
  useTerminalWindowManager: () => jest.fn(),
}));

function renderWithQuery(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe('AgentsPage - session controls', () => {
  beforeEach(() => {
    // Default fetch mock returns basic payloads for required endpoints
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
            total: 1,
            limit: 50,
            offset: 0,
          }),
        } as Response;
      }
      if (url.includes('/api/sessions/agents/presence')) {
        // default: offline
        return { ok: true, json: async () => ({ 'agent-1': { online: false } }) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });
  });

  it('shows Launch Session when agent has no running session', async () => {
    renderWithQuery(<AgentsPage />);

    await waitFor(() => expect(screen.getByText('Project Agents')).toBeInTheDocument());

    expect(await screen.findByText('Launch Session')).toBeInTheDocument();
    expect(screen.queryByText('Restart')).not.toBeInTheDocument();
    expect(screen.queryByText('Terminate')).not.toBeInTheDocument();
  });

  it('shows Restart and Terminate when agent has running session', async () => {
    // Override presence mock to indicate online session
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
            total: 1,
            limit: 50,
            offset: 0,
          }),
        } as Response;
      }
      if (url.includes('/api/sessions/agents/presence')) {
        return {
          ok: true,
          json: async () => ({ 'agent-1': { online: true, sessionId: 'sess-1' } }),
        } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });

    renderWithQuery(<AgentsPage />);

    await waitFor(() => expect(screen.getByText('Project Agents')).toBeInTheDocument());

    expect(await screen.findByText('Restart')).toBeInTheDocument();
    expect(await screen.findByText('Terminate')).toBeInTheDocument();
    expect(screen.queryByText('Launch Session')).not.toBeInTheDocument();
  });
});
