import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useChatQueries } from './useChatQueries';

jest.mock('@/ui/lib/sessions', () => ({
  ...jest.requireActual('@/ui/lib/sessions'),
  fetchAgentPresence: jest.fn().mockResolvedValue({}),
  fetchActiveSessions: jest.fn().mockResolvedValue([]),
}));

jest.mock('@/ui/lib/preflight', () => ({
  fetchPreflightChecks: jest.fn().mockResolvedValue({}),
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('useChatQueries', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    if (originalFetch) {
      global.fetch = originalFetch;
      window.fetch = originalFetch;
    }
  });

  it('loads canonical agent lifecycle data without requesting chat resources', async () => {
    const requests: string[] = [];
    const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url.startsWith('/api/agents')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              { id: 'agent-a', name: 'Alpha', type: 'agent', isProjectOwner: false },
              { id: 'agent-owner', name: 'Zulu', type: 'agent', isProjectOwner: true },
              { id: 'guest-a', name: 'Guest', type: 'guest', isProjectOwner: false },
            ],
          }),
        } as Response;
      }
      return { ok: true, json: async () => [] } as Response;
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    window.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(
      () => useChatQueries({ projectId: 'project-main', projectRootPath: undefined }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.agentsQuerySuccess).toBe(true));
    expect(result.current.agents.map((agent) => agent.id)).toEqual(['agent-owner', 'agent-a']);
    expect(result.current.guests.map((agent) => agent.id)).toEqual(['guest-a']);
    expect(requests.some((url) => url.startsWith('/api/chat'))).toBe(false);
  });
});
